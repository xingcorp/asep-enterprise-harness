// The fake docker client (fake-docker.mjs) where tests rely on it to clean up:
// a container's record goes only once its process is shown gone — never on a
// process table that cannot be read — every container is in the run's process
// registry while it runs, by its pid, start time and token, and a fixture is
// removed only after every container recorded under it has been ended.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  endProcess, endRecorded, identityOf, nestRegistry, shownGone, spawnRecorded, stillRunning, unregister,
  PS_ENV, RECORD_VERSION, REGISTRY_ENV,
  // @ts-expect-error — .mjs helper has no type declarations; we test its runtime contract.
} from '../lib/process-registry.mjs';
import {
  removeFakeDockerFixture,
  // @ts-expect-error — .mjs helper has no type declarations; we test its runtime contract.
} from './fake-docker-fixture.mjs';

const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'fake-docker.mjs');
const IMAGE = `alpine@sha256:${'a'.repeat(64)}`;
// The container's command: it holds for a minute at most, so that one a
// failed test leaves behind does not outlive it by long.
const HOLD = ['-e', 'setTimeout(() => {}, 60_000)'];

interface Started {
  readonly client: ChildProcess;
  readonly pid: number;
  readonly record: Record<string, unknown>;
}

// The run's registry, for a client's environment; with `own`, a registry of
// the test's own as well (process-registry.mjs).
const registryEnv = (own?: string): Record<string, string> => {
  const dirs = [own, process.env[REGISTRY_ENV]].filter((d): d is string => d !== undefined && d !== '');
  return dirs.length > 0 ? { [REGISTRY_ENV]: dirs.join(delimiter) } : {};
};

// A `docker run` client of the fake, recorded in the run's registry like the
// container it starts.
const runClient = (args: string[], env: Record<string, string>, stdout: 'ignore' | 'pipe') =>
  (spawnRecorded(process.execPath, [FAKE, ...args], {
    stdio: ['ignore', stdout, 'ignore'], env: { PATH: process.env['PATH'] ?? '', ...registryEnv(), ...env },
  }) as { child: ChildProcess }).child;

// Kills a client and, once it has exited, forgets it in the run's registry.
async function endClient(client: ChildProcess): Promise<void> {
  client.kill('SIGKILL');
  if (client.exitCode === null && client.signalCode === null) await new Promise((r) => client.once('exit', r));
  unregister(client.pid);
}

// A container run by the fake's `docker run` client, once its record shows it.
async function startContainer(state: string, name: string, env: Record<string, string> = {}): Promise<Started> {
  const client = runClient(['--state', state, 'run', '--name', name, IMAGE, process.execPath, ...HOLD], env, 'ignore');
  const file = join(state, 'containers', `${name}.json`);
  const end = Date.now() + 30_000;
  while (!existsSync(file)) {
    if (Date.now() > end) throw new Error(`container ${name} did not start within 30 s`);
    await new Promise((r) => setTimeout(r, 20));
  }
  const record = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  return { client, pid: record['pid'] as number, record };
}

const docker = (state: string, ...args: string[]) => dockerWith({}, state, ...args);
const dockerWith = (env: Record<string, string>, state: string, ...args: string[]) =>
  spawnSync(process.execPath, [FAKE, '--state', state, ...args], {
    encoding: 'utf8', timeout: 30_000, env: { ...process.env, ...env },
  });

// Ends a container's client and the container, by what identifies it.
const end = async (c: Started | undefined) => {
  if (c === undefined) return;
  await endClient(c.client);
  if (shownGone(endProcess(c.record))) unregister(c.pid);
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
    await end(c);
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
    const removed = await startContainer(state, 'removed', registryEnv(registry));
    started.push(removed);
    const entry = JSON.parse(readFileSync(join(registry, `${removed.pid}.json`), 'utf8')) as Record<string, unknown>;
    const { version, pid, group, token, startedAt } = removed.record;
    assert.deepEqual(entry, { version, pid, group, token, startedAt }, 'the registry has what identifies the container');
    assert.equal(version, RECORD_VERSION);
    assert.equal(group, true);
    assert.match(String(token), /^[0-9a-f-]{36}$/);
    assert.deepEqual(identityOf(removed.pid, { token, group: true }), entry,
      'the process table shows the container\'s process with that start time and token');
    assert.equal(docker(state, 'rm', '-f', 'removed').status, 0);
    assert.deepEqual(readdirSync(registry), [], 'a removed container leaves the registry');

    // A container whose client died stays in the registry, and the registry
    // can end it.
    const orphan = await startContainer(state, 'orphan', registryEnv(registry));
    started.push(orphan);
    await endClient(orphan.client);
    assert.equal(stillRunning(orphan.pid, true), true, 'a killed client does not stop its container');
    assert.deepEqual(readdirSync(registry), [`${orphan.pid}.json`]);
    assert.deepEqual(endRecorded(registry).map((e: { pid: number; outcome: string }) => [e.pid, e.outcome]),
      [[orphan.pid, 'ended']]);
    assert.equal(stillRunning(orphan.pid, true), false);
    unregister(orphan.pid);
  } finally {
    for (const c of started) await end(c);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a container this file\'s helper starts, and its client, are in the run\'s registry without being handed it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'asep-fake-docker-'));
  const state = join(dir, 'docker-state');
  const own = join(dir, 'own');
  const standIn = join(dir, 'run');
  mkdirSync(own);
  mkdirSync(standIn);
  // The run's registries, as the canonical runner hands them to this process;
  // run by hand, outside a run, a stand-in for one. A registry of the test's
  // own is added beside them.
  const restoreRun = process.env[REGISTRY_ENV] ? () => undefined : nestRegistry(standIn);
  const runs = process.env[REGISTRY_ENV]!.split(delimiter).filter((d) => d !== '');
  const restore = nestRegistry(own);
  const heldIn = (d: string, names: string[]) => names.filter((n) => readdirSync(d).includes(n));
  let c: Started | undefined;
  try {
    c = await startContainer(state, 'helped');
    const names = [`${c.client.pid}.json`, `${c.pid}.json`].sort();
    assert.deepEqual(readdirSync(own).sort(), names, 'the client and its container are both recorded in the test\'s own registry');
    for (const r of runs) assert.deepEqual(heldIn(r, names), names, `and in the run's, ${r}`);
    await end(c);
    c = undefined;
    assert.deepEqual(readdirSync(own), [], 'and both leave it once shown gone');
    for (const r of runs) assert.deepEqual(heldIn(r, names), [], `the run's too, ${r}`);
  } finally {
    await end(c);
    restore();
    restoreRun();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('docker kill and rm keep a container whose process table cannot be read, and say so', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'asep-fake-docker-'));
  const state = join(dir, 'docker-state');
  const failing = join(dir, 'ps-fails');
  writeFileSync(failing, '#!/bin/sh\nexit 1\n');
  chmodSync(failing, 0o755);
  let c: Started | undefined;
  try {
    c = await startContainer(state, 'unread');
    const unread = { [PS_ENV]: failing };
    const killed = dockerWith(unread, state, 'kill', 'unread');
    assert.equal(killed.status, 1, killed.stderr);
    assert.match(killed.stderr, new RegExp(`cannot kill container: unread: could not tell whether process ${c.pid} is still running`));
    const refused = dockerWith(unread, state, 'rm', '-f', 'unread');
    assert.equal(refused.status, 1, refused.stderr);
    assert.match(refused.stderr,
      new RegExp(`cannot remove container "/unread": could not tell whether process ${c.pid} is still running`));
    assert.equal(existsSync(join(state, 'containers', 'unread.json')), true, 'the record stays');
    assert.equal(stillRunning(c.pid, true), true, 'and nothing was signalled');

    const removed = docker(state, 'rm', '-f', 'unread');
    assert.equal(removed.status, 0, removed.stderr);
    assert.equal(stillRunning(c.pid, true), false);
    assert.deepEqual(readdirSync(join(state, 'containers')), []);
  } finally {
    await end(c);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('when a container\'s process ends, the rest of its group is ended before its record goes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'asep-fake-docker-'));
  const state = join(dir, 'docker-state');
  let member: { pid: number; token: string } | undefined;
  try {
    // Its process starts a member of its group, which inherits its token,
    // prints the member's pid and the token, and exits.
    const script = "const m = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], "
      + "{ stdio: 'ignore' }); process.stdout.write(m.pid + ' ' + process.env.ASEP_PROCESS_TOKEN + '\\n'); "
      + 'setTimeout(() => process.exit(0), 200);';
    const client = runClient(['--state', state, 'run', '--name', 'brief', IMAGE, process.execPath, '-e', script], {}, 'pipe');
    let out = '';
    client.stdout!.on('data', (d: Buffer) => { out += d.toString('utf8'); });
    const code = await new Promise<number | null>((r) => client.once('exit', r));
    unregister(client.pid);
    const [pid, token] = out.trim().split(' ');
    member = { pid: Number(pid), token: token! };
    assert.equal(code, 0);
    assert.ok(Number.isSafeInteger(member.pid) && member.pid > 0, `the member's pid: ${out}`);
    assert.equal(stillRunning(member.pid), false, 'the member went with its container');
    assert.deepEqual(readdirSync(join(state, 'containers')), [], 'and then the record');
  } finally {
    const left = member !== undefined ? identityOf(member.pid, member) : undefined;
    if (left !== undefined) endProcess(left);
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
      const c = await startContainer(state, 'left', registryEnv(registry));
      started.push(c);
      await endClient(c.client);
      assert.equal(stillRunning(c.pid, true), true, 'its client is gone, the container is not');
    }
    assert.equal(readdirSync(registry).length, 2, 'both are in the run\'s registry');
    // One that cannot be shown gone keeps the fixture, records and all.
    for (const outcome of ['still-running', 'unknown']) {
      await assert.rejects(removeFakeDockerFixture(dir, () => outcome, registry),
        new RegExp(`fake containers not shown gone, so ${dir} is kept: pid ${started[0]!.pid} \\(left\\): ${outcome}`));
    }
    assert.equal(existsSync(join(dir, 'docker-state', 'containers', 'left.json')), true);
    assert.equal(readdirSync(registry).length, 2, 'and in the registry');
    await removeFakeDockerFixture(dir, undefined, registryEnv(registry)[REGISTRY_ENV]);
    for (const c of started) assert.equal(stillRunning(c.pid, true), false, `container process ${c.pid} was ended`);
    assert.equal(existsSync(dir), false, 'and then the fixture was removed');
    assert.deepEqual(readdirSync(registry), [], 'and what it ended left the registry');
  } finally {
    for (const c of started) await end(c);
    rmSync(dir, { recursive: true, force: true });
    rmSync(registry, { recursive: true, force: true });
  }
});
