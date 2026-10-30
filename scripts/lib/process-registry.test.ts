// The run-scoped registry of the processes tests start (process-registry.mjs):
// what it ends, what it leaves alone, and which runs it sweeps.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  endProcess, endRecorded, register, registryRoot, registryShimLine, stillRunning, withProcessRegistry, REGISTRY_ENV,
  // @ts-expect-error — .mjs helper has no type declarations; we test its runtime contract.
} from './process-registry.mjs';

// A process that leads its own group and runs until it is killed, with a
// member in that group; `tag` is in both command lines.
async function group(tag: string): Promise<{ leader: number; member: number }> {
  const script = "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)', "
    + "process.argv[1]], { stdio: 'ignore' }); process.stdout.write(c.pid + '\\n'); setInterval(() => {}, 1e9);";
  const leader = spawn(process.execPath, ['-e', script, tag], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const member = await new Promise<number>((resolve, reject) => {
    leader.stdout.once('data', (d: Buffer) => resolve(Number(d.toString('utf8').trim())));
    leader.once('error', reject);
  });
  leader.stdout.destroy();
  leader.unref();
  return { leader: leader.pid!, member };
}

// A process of its own group that runs until it is killed.
function lone(tag: string): number {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)', tag], { detached: true, stdio: 'ignore' });
  child.unref();
  return child.pid!;
}

const tagged = () => `asep-registry-test-${randomUUID()}`;

test('a process still the one recorded is ended with its whole group, and shown gone', async () => {
  const tag = tagged();
  const g = await group(tag);
  try {
    assert.equal(stillRunning(g.leader, true), true);
    assert.equal(endProcess({ pid: g.leader, group: true, marker: tag }), 'ended');
    assert.equal(stillRunning(g.leader, true), false, 'nothing of its group runs');
    assert.equal(stillRunning(g.member), false, 'its member went with it');
    assert.equal(endProcess({ pid: g.leader, group: true, marker: tag }), 'gone', 'and there is nothing left to end');
  } finally {
    endProcess({ pid: g.leader, group: true, marker: tag });
  }
});

test('a pid that another process has now is left alone', async () => {
  const tag = tagged();
  const g = await group(tag);
  try {
    assert.equal(endProcess({ pid: g.leader, group: true, marker: 'asep-some-other-process' }), 'not-ours');
    assert.equal(stillRunning(g.leader), true, 'it still runs');
    assert.equal(stillRunning(g.member), true);
  } finally {
    endProcess({ pid: g.leader, group: true, marker: tag });
  }
});

test('records are ended and forgotten; a run whose runner is gone is swept at the next start; a run ends what it recorded', () => {
  // A checkout of its own, so that only this test's runs are under its root.
  const repo = mkdtempSync(join(tmpdir(), 'asep-registry-repo-'));
  const root = registryRoot(repo);
  const pids: number[] = [];
  const marks = new Map<number, string>();
  const start = () => {
    const tag = tagged();
    const pid = lone(tag);
    pids.push(pid);
    marks.set(pid, tag);
    return { pid, tag };
  };
  try {
    // A run whose runner died: its owner is a process that has exited.
    const dead = spawnSync(process.execPath, ['-e', '']).pid;
    const stale = join(root, 'stale');
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, 'owner.json'), JSON.stringify({ pid: dead, marker: 'run-canonical-tests' }));
    const leftover = start();
    register(leftover.pid, { marker: leftover.tag, group: true }, stale);
    // A run whose runner is alive: this test process, by a word of its own
    // command line.
    const live = join(root, 'live');
    mkdirSync(live, { recursive: true });
    writeFileSync(join(live, 'owner.json'), JSON.stringify({ pid: process.pid, marker: 'process-registry.test' }));
    const running = start();
    register(running.pid, { marker: running.tag, group: true }, live);

    let own: { pid: number; tag: string } | undefined;
    let ownRun = '';
    const { result, earlier, left } = withProcessRegistry(repo, 'process-registry.test', (env: NodeJS.ProcessEnv) => {
      ownRun = env[REGISTRY_ENV]!;
      own = start();
      register(own.pid, { marker: own.tag, group: true }, ownRun);
      assert.deepEqual(readdirSync(ownRun).sort(), [`${own.pid}.json`, 'owner.json']);
      return 'done';
    });
    assert.equal(result, 'done');
    assert.deepEqual(earlier.map((e: { pid: number; outcome: string; run: string }) => [e.run, e.pid, e.outcome]),
      [['stale', leftover.pid, 'ended']], 'the dead runner\'s leftover was ended');
    assert.equal(stillRunning(leftover.pid), false);
    assert.equal(existsSync(stale), false, 'and its run removed');
    assert.equal(stillRunning(running.pid), true, 'a live runner\'s run is not touched');
    assert.equal(existsSync(join(live, `${running.pid}.json`)), true);
    assert.deepEqual(left.map((e: { pid: number; outcome: string }) => [e.pid, e.outcome]), [[own!.pid, 'ended']],
      'the run ended what it recorded');
    assert.equal(stillRunning(own!.pid), false);
    assert.equal(existsSync(ownRun), false, 'and removed its run');

    // A record stays while its process cannot be shown gone; once it is
    // ended, its record goes.
    assert.deepEqual(endRecorded(live, () => 'still-running').map((e: { pid: number; outcome: string }) => [e.pid, e.outcome]),
      [[running.pid, 'still-running']]);
    assert.deepEqual(readdirSync(live).sort(), [`${running.pid}.json`, 'owner.json']);
    assert.deepEqual(endRecorded(live).map((e: { pid: number; outcome: string }) => [e.pid, e.outcome]),
      [[running.pid, 'ended']]);
    assert.deepEqual(readdirSync(live), ['owner.json']);
  } finally {
    for (const pid of pids) endProcess({ pid, group: true, marker: marks.get(pid) });
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('the shim line hands the run to a shell, quoted, and is empty without a run', () => {
  const dir = "/tmp/asep registry/it's here";
  const r = spawnSync('/bin/sh', ['-c', `${registryShimLine(dir)}\nprintf %s "$${REGISTRY_ENV}"`], { encoding: 'utf8' });
  assert.equal(r.stdout, dir);
  assert.equal(registryShimLine(''), '');
});
