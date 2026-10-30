// The run-scoped registry of the processes tests start (process-registry.mjs):
// what it ends, what it leaves alone, what it does when it cannot tell, and
// which runs it sweeps.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  endProcess, endRecorded, identityOf, register, registryRoot, registryShimLine, spawnRecorded, stillRunning,
  withProcessRegistry,
  PS_ENV, REGISTRY_ENV, TOKEN_ENV,
  // @ts-expect-error — .mjs helper has no type declarations; we test its runtime contract.
} from './process-registry.mjs';

// What identifies a recorded process.
interface Entry { pid: number; group: boolean; token: string; startedAt?: string }

// What the processes here run: they hold for a minute at most, so that one a
// failed test leaves behind does not outlive it by long.
const HOLD = 'setTimeout(() => {}, 60_000)';
// A start time no process here has.
const LONG_AGO = 'Thu Jan  1 00:00:00 1970';

// When `pid` started, as the process table shows it.
const startOf = (pid: number) =>
  spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } }).stdout.trim();

// A process of its own group that runs until it is killed, started with `env`
// (and PATH) as its whole environment.
function lone(env: NodeJS.ProcessEnv = {}): ChildProcess {
  const child = spawn(process.execPath, ['-e', HOLD], {
    detached: true, stdio: 'ignore', env: { PATH: process.env['PATH'], ...env },
  });
  child.unref();
  return child;
}

// The same, with a token of its own: what identifies it.
function recorded(): Entry {
  const token = randomUUID();
  return identityOf(lone({ [TOKEN_ENV]: token }).pid, { token, group: true }) as Entry;
}

// A process that leads its own group, with a member in that group: the member
// inherits its environment, token included, unless `memberToken` gives it one
// of its own. With `leaderExits` the leader then exits.
async function group(o: { leaderExits?: boolean; memberToken?: string } = {}): Promise<{ entry: Entry; member: number }> {
  const token = randomUUID();
  const memberEnv = o.memberToken === undefined ? '' : `, env: { PATH: process.env.PATH, ${TOKEN_ENV}: '${o.memberToken}' }`;
  const script = `const c = require('node:child_process').spawn(process.execPath, ['-e', '${HOLD}'], { stdio: 'ignore'${memberEnv} }); `
    + `process.stdout.write(c.pid + '\\n'); ${o.leaderExits ? 'setTimeout(() => process.exit(0), 100);' : `${HOLD};`}`;
  const leader = spawn(process.execPath, ['-e', script], {
    detached: true, stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: process.env['PATH'], [TOKEN_ENV]: token },
  });
  const entry = identityOf(leader.pid, { token, group: true }) as Entry;
  const member = await new Promise<number>((resolve, reject) => {
    leader.stdout!.once('data', (d: Buffer) => resolve(Number(d.toString('utf8').trim())));
    leader.once('error', reject);
  });
  leader.stdout!.destroy();
  if (o.leaderExits) await new Promise((r) => leader.once('exit', r));
  leader.unref();
  return { entry, member };
}

test('a process that is still the one recorded — its pid, start time and token — is ended with its whole group', async () => {
  const g = await group();
  try {
    assert.equal(stillRunning(g.entry.pid, true), true);
    assert.equal(endProcess(g.entry), 'ended');
    assert.equal(stillRunning(g.entry.pid, true), false, 'nothing of its group runs');
    assert.equal(stillRunning(g.member), false, 'its member went with it');
    assert.equal(endProcess(g.entry), 'gone', 'and there is nothing left to end');
  } finally {
    endProcess(g.entry);
  }
});

test('a pid whose process does not show the recorded start time and token is left alone, though it runs the same command line', () => {
  const ours = recorded();
  const bare = lone();
  const tokenAlike = `${ours.token.slice(0, -1)}${ours.token.endsWith('0') ? '1' : '0'}`;
  const near = lone({ [TOKEN_ENV]: tokenAlike });
  try {
    // The same executable and arguments: only the token and start time tell
    // them apart.
    const args = (pid: number) => spawnSync('ps', ['-ww', '-o', 'args=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
    assert.equal(args(bare.pid!), args(ours.pid));
    assert.equal(args(near.pid!), args(ours.pid));
    const others: readonly [string, Entry][] = [
      ['no token at all', { pid: bare.pid!, group: true, token: ours.token, startedAt: startOf(bare.pid!) }],
      ['a token that differs in its last character', { pid: near.pid!, group: true, token: ours.token, startedAt: startOf(near.pid!) }],
      ['the token, but another start time', { pid: ours.pid, group: true, token: ours.token, startedAt: LONG_AGO }],
      ['the token, but no start time recorded', { pid: ours.pid, group: true, token: ours.token }],
    ];
    for (const [what, entry] of others) {
      assert.equal(endProcess(entry), 'not-ours', what);
      assert.equal(stillRunning(entry.pid), true, `${what}: it still runs`);
    }
    assert.throws(() => identityOf(bare.pid!, { token: ours.token, group: true }),
      /does not show its token in the process table \(it shows another, or none\), so it cannot be recorded/);
    assert.equal(endProcess(ours), 'ended', 'the one recorded is ended');
    assert.equal(stillRunning(bare.pid!), true);
    assert.equal(stillRunning(near.pid!), true);
  } finally {
    endProcess(ours);
    bare.kill('SIGKILL');
    near.kill('SIGKILL');
  }
});

test('a group whose leader has exited is ended only while every member left shows its token', async () => {
  const memberToken = randomUUID();
  const ours = await group({ leaderExits: true });
  const unproven = await group({ leaderExits: true, memberToken });
  try {
    assert.equal(stillRunning(unproven.entry.pid, true), true, 'its member runs on in its group');
    assert.equal(endProcess(unproven.entry), 'unknown', 'a member that shows another token is not shown to be ours');
    assert.equal(stillRunning(unproven.member), true, 'and is left alone');
    assert.equal(endProcess(ours.entry), 'ended');
    assert.equal(stillRunning(ours.member), false);
  } finally {
    endProcess(ours.entry);
    endProcess(identityOf(unproven.member, { token: memberToken }) ?? { pid: unproven.member, group: false, token: memberToken });
  }
});

test('an unreadable process table is not absence: nothing is signalled, the record stays, and recording fails', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'asep-registry-ps-'));
  const script = (name: string, body: string) => {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  };
  const failures: readonly [string, string][] = [
    ['ps exits 1', script('ps-fails', 'exit 1')],
    ['ps is killed by a signal', script('ps-killed', 'kill -9 $$')],
    ['ps cannot be started', join(dir, 'no-such-ps')],
  ];
  const ours = recorded();
  const leaderless = await group({ leaderExits: true });
  const run = join(dir, 'run');
  mkdirSync(run);
  register(ours, run);
  const before = process.env[PS_ENV];
  const restore = () => {
    if (before === undefined) delete process.env[PS_ENV];
    else process.env[PS_ENV] = before;
  };
  try {
    for (const [what, ps] of failures) {
      process.env[PS_ENV] = ps;
      try {
        assert.equal(endProcess(ours), 'unknown', what);
        assert.equal(endProcess(leaderless.entry), 'unknown', `${what}: a group whose leader has exited`);
        assert.equal(stillRunning(ours.pid, true), true, `${what}: unknown is not absence`);
        assert.deepEqual(endRecorded(run).map((e: Entry & { outcome: string }) => e.outcome), ['unknown'], what);
        assert.deepEqual(readdirSync(run), [`${ours.pid}.json`], `${what}: the record stays`);
        assert.throws(() => identityOf(ours.pid, { token: ours.token, group: true }),
          /cannot be read in the process table, so it cannot be recorded/, what);
      } finally {
        restore();
      }
      assert.equal(stillRunning(ours.pid, true), true, `${what}: nothing was signalled`);
      assert.equal(stillRunning(leaderless.member), true, `${what}: nothing of the group was signalled`);
    }
  } finally {
    restore();
    endProcess(ours);
    endProcess(leaderless.entry);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a process whose environment the table does not show cannot be shown to be ours, nor recorded', () => {
  // On macOS `ps` shows no environment for the system's own binaries. Where
  // /proc shows every environment, the token shows, and the process is ours.
  const hidden = !existsSync('/proc/self/environ');
  const token = randomUUID();
  const sleeper = spawn('/bin/sleep', ['600'], { stdio: 'ignore', env: { [TOKEN_ENV]: token } });
  try {
    const entry = { pid: sleeper.pid!, group: false, token, startedAt: startOf(sleeper.pid!) };
    if (hidden) {
      assert.throws(() => identityOf(sleeper.pid, { token }), /its environment cannot be read/);
      assert.equal(endProcess(entry), 'unknown');
      assert.equal(stillRunning(sleeper.pid!), true, 'it was not signalled');
    } else {
      assert.deepEqual(identityOf(sleeper.pid, { token }), entry);
      assert.equal(endProcess(entry), 'ended');
    }
  } finally {
    sleeper.kill('SIGKILL');
  }
});

test('a process that cannot be recorded is not left running', () => {
  const dir = mkdtempSync(join(tmpdir(), 'asep-registry-ps-'));
  const failing = join(dir, 'ps-fails');
  writeFileSync(failing, '#!/bin/sh\nexit 1\n');
  chmodSync(failing, 0o755);
  const tag = `asep-registry-unrecorded-${randomUUID()}`;
  const before = process.env[PS_ENV];
  process.env[PS_ENV] = failing;
  try {
    assert.throws(() => spawnRecorded(process.execPath, ['-e', HOLD, tag], { detached: true, stdio: 'ignore' }, dir),
      /cannot be read in the process table, so it cannot be recorded/);
  } finally {
    if (before === undefined) delete process.env[PS_ENV];
    else process.env[PS_ENV] = before;
  }
  try {
    assert.deepEqual(readdirSync(dir), ['ps-fails'], 'nothing was recorded');
    const shown = () => spawnSync('ps', ['-A', '-ww', '-o', 'args='], { encoding: 'utf8' }).stdout.includes(tag);
    const end = Date.now() + 5_000;
    while (shown() && Date.now() < end) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    assert.equal(shown(), false, 'the process was killed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('records are ended and forgotten; a run whose runner is gone is swept at the next start; a run ends what it recorded', () => {
  // A registry root of its own, so that only this test's runs are under it.
  const repo = mkdtempSync(join(tmpdir(), 'asep-registry-repo-'));
  const root = registryRoot(repo);
  const entries: Entry[] = [];
  const start = () => {
    const entry = recorded();
    entries.push(entry);
    return entry;
  };
  const runWith = (name: string, owner: { pid: number; startedAt: string }) => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'owner.json'), JSON.stringify(owner));
    return dir;
  };
  try {
    // A run whose runner died: its owner is a process that has exited.
    const dead = spawnSync(process.execPath, ['-e', '']).pid;
    const stale = runWith('stale', { pid: dead, startedAt: LONG_AGO });
    const leftover = start();
    register(leftover, stale);
    // A run whose runner's pid is another process's now: another start time.
    const reused = runWith('reused', { pid: process.pid, startedAt: LONG_AGO });
    const leftoverToo = start();
    register(leftoverToo, reused);
    // A run whose runner is alive: this test process, by its pid and start time.
    const live = runWith('live', { pid: process.pid, startedAt: startOf(process.pid) });
    const running = start();
    register(running, live);

    let own: Entry | undefined;
    let ownRun = '';
    const { result, earlier, left } = withProcessRegistry(root, (env: NodeJS.ProcessEnv) => {
      ownRun = env[REGISTRY_ENV]!;
      own = start();
      register(own, ownRun);
      assert.deepEqual(readdirSync(ownRun).sort(), [`${own.pid}.json`, 'owner.json']);
      return 'done';
    });
    assert.equal(result, 'done');
    const outcomes = (records: (Entry & { outcome: string; run?: string })[]) =>
      records.map((e) => [e.run, e.pid, e.outcome]).sort();
    assert.deepEqual(outcomes(earlier), [['reused', leftoverToo.pid, 'ended'], ['stale', leftover.pid, 'ended']].sort(),
      'the leftovers of runs whose runner is gone were ended');
    assert.equal(stillRunning(leftover.pid), false);
    assert.equal(stillRunning(leftoverToo.pid), false);
    assert.equal(existsSync(stale), false, 'and their runs removed');
    assert.equal(existsSync(reused), false);
    assert.equal(stillRunning(running.pid), true, 'a live runner\'s run is not touched');
    assert.equal(existsSync(join(live, `${running.pid}.json`)), true);
    assert.deepEqual(outcomes(left), [[undefined, own!.pid, 'ended']], 'the run ended what it recorded');
    assert.equal(stillRunning(own!.pid), false);
    assert.equal(existsSync(ownRun), false, 'and removed its run');

    // A record stays while its process cannot be shown gone, or cannot be told
    // apart; once it is ended, its record goes.
    for (const outcome of ['still-running', 'unknown']) {
      assert.deepEqual(endRecorded(live, () => outcome).map((e: Entry & { outcome: string }) => [e.pid, e.outcome]),
        [[running.pid, outcome]]);
      assert.deepEqual(readdirSync(live).sort(), [`${running.pid}.json`, 'owner.json']);
    }
    assert.deepEqual(endRecorded(live).map((e: Entry & { outcome: string }) => [e.pid, e.outcome]),
      [[running.pid, 'ended']]);
    assert.deepEqual(readdirSync(live), ['owner.json']);
  } finally {
    for (const entry of entries) endProcess(entry);
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a run whose runner cannot be read in the process table is left in place, and listed as unknown', () => {
  const repo = mkdtempSync(join(tmpdir(), 'asep-registry-repo-'));
  const root = registryRoot(repo);
  const runner = recorded();
  const leftover = recorded();
  // A `ps` that cannot read the runner alone.
  const ps = join(repo, 'ps-not-the-runner');
  writeFileSync(ps, `#!/bin/sh\ncase " $* " in *" -p ${runner.pid} "*) exit 1;; esac\nexec ps "$@"\n`);
  chmodSync(ps, 0o755);
  const run = join(root, 'unread');
  mkdirSync(run, { recursive: true });
  writeFileSync(join(run, 'owner.json'), JSON.stringify({ pid: runner.pid, startedAt: runner.startedAt }));
  register(leftover, run);
  const before = process.env[PS_ENV];
  process.env[PS_ENV] = ps;
  try {
    const { earlier } = withProcessRegistry(root, () => undefined);
    assert.deepEqual(earlier, [{ run: 'unread', pid: runner.pid, owner: true, outcome: 'unknown' }]);
  } finally {
    if (before === undefined) delete process.env[PS_ENV];
    else process.env[PS_ENV] = before;
  }
  try {
    assert.deepEqual(readdirSync(run).sort(), [`${leftover.pid}.json`, 'owner.json'], 'the run is left as it was');
    assert.equal(stillRunning(leftover.pid), true, 'and what it recorded was not signalled');
  } finally {
    endProcess(runner);
    endProcess(leftover);
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
