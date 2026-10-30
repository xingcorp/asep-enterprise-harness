// The fake docker client (fake-docker.mjs) where tests rely on it to clean up:
// a container's record goes only once its process is shown gone, every
// container is in the run's process registry while it runs, and a fixture is
// removed only after every container recorded under it has been ended.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  endProcess, endRecorded, stillRunning, REGISTRY_ENV,
  // @ts-expect-error — .mjs helper has no type declarations; we test its runtime contract.
} from '../lib/process-registry.mjs';
import {
  removeFakeDockerFixture,
  // @ts-expect-error — .mjs helper has no type declarations; we test its runtime contract.
} from './fake-docker-fixture.mjs';

const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'fake-docker.mjs');
const IMAGE = `alpine@sha256:${'a'.repeat(64)}`;
// The container's command; its second word marks it.
const HOLD = ['-e', 'setInterval(() => {}, 1e9)'];

interface Started {
  readonly client: ChildProcess;
  readonly pid: number;
  readonly record: Record<string, unknown>;
}

// A container run by the fake's `docker run` client, once its record shows it.
async function startContainer(state: string, name: string, env: Record<string, string> = {}): Promise<Started> {
  const client = spawn(process.execPath, [FAKE, '--state', state, 'run', '--name', name, IMAGE, process.execPath, ...HOLD], {
    stdio: 'ignore', env: { PATH: process.env['PATH'] ?? '', ...env },
  });
  const file = join(state, 'containers', `${name}.json`);
  const end = Date.now() + 30_000;
  while (!existsSync(file)) {
    if (Date.now() > end) throw new Error(`container ${name} did not start within 30 s`);
    await new Promise((r) => setTimeout(r, 20));
  }
  const record = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  return { client, pid: record['pid'] as number, record };
}

const docker = (state: string, ...args: string[]) =>
  spawnSync(process.execPath, [FAKE, '--state', state, ...args], { encoding: 'utf8', timeout: 30_000 });

const end = (c: Started | undefined) => {
  if (c === undefined) return;
  c.client.kill('SIGKILL');
  endProcess({ pid: c.pid, group: true, marker: c.record['marker'] });
};

test('docker kill and rm take a container\'s record away only once its process is shown gone', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'asep-fake-docker-'));
  const state = join(dir, 'docker-state');
  let c: Started | undefined;
  try {
    c = await startContainer(state, 'held');
    // A daemon whose kill does not take: the container's process runs on.
    writeFileSync(join(state, 'kill-does-not-take'), '');
    const killed = docker(state, 'kill', 'held');
    assert.equal(killed.status, 1, killed.stderr);
    assert.match(killed.stderr, new RegExp(`cannot kill container: held: process ${c.pid} is still running`));
    const refused = docker(state, 'rm', '-f', 'held');
    assert.equal(refused.status, 1, refused.stderr);
    assert.match(refused.stderr, new RegExp(`cannot remove container "/held": could not kill: process ${c.pid} is still running`));
    assert.equal(existsSync(join(state, 'containers', 'held.json')), true, 'the record stays while its process runs');
    assert.equal(stillRunning(c.pid, true), true);

    rmSync(join(state, 'kill-does-not-take'));
    const removed = docker(state, 'rm', '-f', 'held');
    assert.equal(removed.status, 0, removed.stderr);
    assert.equal(stillRunning(c.pid, true), false, 'nothing of the container runs');
    assert.deepEqual(readdirSync(join(state, 'containers')), [], 'and only then is its record gone');
  } finally {
    end(c);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every container is in the run\'s process registry while it runs, and leaves it once shown gone', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'asep-fake-docker-'));
  const state = join(dir, 'docker-state');
  const registry = join(dir, 'registry');
  mkdirSync(registry);
  const started: Started[] = [];
  try {
    const removed = await startContainer(state, 'removed', { [REGISTRY_ENV]: registry });
    started.push(removed);
    const entry = JSON.parse(readFileSync(join(registry, `${removed.pid}.json`), 'utf8')) as Record<string, unknown>;
    assert.deepEqual(entry, { pid: removed.pid, group: true, marker: `${process.execPath} ${HOLD[0]}` });
    const shown = spawnSync('ps', ['-ww', '-o', 'args=', '-p', String(removed.pid)], { encoding: 'utf8' }).stdout;
    assert.ok(shown.includes(entry['marker'] as string), `its marker is in its command line: ${shown}`);
    assert.equal(docker(state, 'rm', '-f', 'removed').status, 0);
    assert.deepEqual(readdirSync(registry), [], 'a removed container leaves the registry');

    // A container whose client died stays in the registry, and the registry
    // can end it.
    const orphan = await startContainer(state, 'orphan', { [REGISTRY_ENV]: registry });
    started.push(orphan);
    orphan.client.kill('SIGKILL');
    await new Promise((r) => orphan.client.once('exit', r));
    assert.equal(stillRunning(orphan.pid, true), true, 'a killed client does not stop its container');
    assert.deepEqual(readdirSync(registry), [`${orphan.pid}.json`]);
    assert.deepEqual(endRecorded(registry).map((e: { pid: number; outcome: string }) => [e.pid, e.outcome]),
      [[orphan.pid, 'ended']]);
    assert.equal(stillRunning(orphan.pid, true), false);
  } finally {
    for (const c of started) end(c);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('when a container\'s process ends, the rest of its group is ended before its record goes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'asep-fake-docker-'));
  const state = join(dir, 'docker-state');
  let member: number | undefined;
  try {
    // Its process starts a member of its group, prints the member's pid, and exits.
    const script = "const m = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)', "
      + "'asep-fake-member'], { stdio: 'ignore' }); process.stdout.write(m.pid + '\\n'); setTimeout(() => process.exit(0), 200);";
    const client = spawn(process.execPath, [FAKE, '--state', state, 'run', '--name', 'brief', IMAGE, process.execPath, '-e', script], {
      stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: process.env['PATH'] ?? '' },
    });
    let out = '';
    client.stdout.on('data', (d: Buffer) => { out += d.toString('utf8'); });
    const code = await new Promise<number | null>((r) => client.once('exit', r));
    member = Number(out.trim());
    assert.equal(code, 0);
    assert.ok(Number.isSafeInteger(member) && member > 0, `the member's pid: ${out}`);
    assert.equal(stillRunning(member), false, 'the member went with its container');
    assert.deepEqual(readdirSync(join(state, 'containers')), [], 'and then the record');
  } finally {
    if (member !== undefined) endProcess({ pid: member, marker: 'asep-fake-member' });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a fixture is removed only after every container recorded under it is ended', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'asep-fake-docker-'));
  const registry = mkdtempSync(join(tmpdir(), 'asep-registry-'));
  const started: Started[] = [];
  try {
    // Fixtures keep their docker state at the top or one level down.
    for (const state of [join(dir, 'docker-state'), join(dir, 'sandbox', 'docker-state')]) {
      const c = await startContainer(state, 'left', { [REGISTRY_ENV]: registry });
      started.push(c);
      c.client.kill('SIGKILL');
      await new Promise((r) => c.client.once('exit', r));
      assert.equal(stillRunning(c.pid, true), true, 'its client is gone, the container is not');
    }
    assert.equal(readdirSync(registry).length, 2, 'both are in the run\'s registry');
    // One that cannot be shown gone keeps the fixture, records and all.
    await assert.rejects(removeFakeDockerFixture(dir, () => 'still-running', registry),
      new RegExp(`fake containers still running after SIGKILL, so ${dir} is kept: pid ${started[0]!.pid} \\(left\\)`));
    assert.equal(existsSync(join(dir, 'docker-state', 'containers', 'left.json')), true);
    assert.equal(readdirSync(registry).length, 2, 'and in the registry');
    await removeFakeDockerFixture(dir, undefined, registry);
    for (const c of started) assert.equal(stillRunning(c.pid, true), false, `container process ${c.pid} was ended`);
    assert.equal(existsSync(dir), false, 'and then the fixture was removed');
    assert.deepEqual(readdirSync(registry), [], 'and what it ended left the registry');
  } finally {
    for (const c of started) end(c);
    rmSync(dir, { recursive: true, force: true });
    rmSync(registry, { recursive: true, force: true });
  }
});
