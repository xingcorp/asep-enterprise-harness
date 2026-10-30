// The run-scoped registry of the processes tests start (process-registry.mjs):
// what it ends, what it leaves alone, what it does when it cannot tell, and
// which runs it sweeps.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  endProcess, endRecorded, identityOf, nestRegistry, register, registryRoot, registryShimLine, shownGone, spawnRecorded,
  stillRunning, unregister, withProcessRegistry,
  PROC_ENV, PS_ENV, RECORD_VERSION, REGISTRY_ENV, TOKEN_ENV,
  // @ts-expect-error — .mjs helper has no type declarations; we test its runtime contract.
} from './process-registry.mjs';
// @ts-expect-error — .mjs helper has no type declarations; we test its runtime contract.
import { TEST_ROOTS } from './canonical-tests.mjs';

// What identifies a recorded process.
interface Entry { version: number; pid: number; group: boolean; token: string; startedAt: string }

// What the processes here run: they hold for a minute at most, so that one a
// failed test leaves behind does not outlive it by long.
const HOLD = 'setTimeout(() => {}, 60_000)';
// A start time no process here has.
const LONG_AGO = 'Thu Jan  1 00:00:00 1970';

// When `pid` started, as the process table shows it.
const startOf = (pid: number) =>
  spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } }).stdout.trim();

// Sets `name` in this process's environment to `value`, or removes it.
function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

// A process of its own group that runs until it is killed, started with `env`
// (and PATH) as its whole environment: one that shows no token of ours, or
// another one, so that it cannot be recorded by one. Its test kills it.
function lone(env: NodeJS.ProcessEnv = {}): ChildProcess {
  const child = spawn(process.execPath, ['-e', HOLD], {
    detached: true, stdio: 'ignore', env: { PATH: process.env['PATH'], ...env },
  });
  child.unref();
  return child;
}

// The same, with a token of its own and recorded in the run's registry: what
// identifies it.
function recorded(): Entry {
  const { child, entry } = spawnRecorded(process.execPath, ['-e', HOLD], { detached: true, stdio: 'ignore' }) as {
    child: ChildProcess; entry: Entry;
  };
  child.unref();
  return entry;
}

// Ends `entry` by its identity, and once it is shown gone, forgets it in the
// run's registry.
function finish(entry: Entry | undefined): void {
  if (entry !== undefined && shownGone(endProcess(entry))) unregister(entry.pid);
}

// A process that leads its own group, recorded in the run's registry, with a
// member in that group: the member inherits its environment, token included,
// unless `memberToken` gives it one of its own. With `leaderExits` the leader
// then exits.
async function group(o: { leaderExits?: boolean; memberToken?: string } = {}): Promise<{ entry: Entry; member: number }> {
  const memberEnv = o.memberToken === undefined ? '' : `, env: { PATH: process.env.PATH, ${TOKEN_ENV}: '${o.memberToken}' }`;
  const script = `const c = require('node:child_process').spawn(process.execPath, ['-e', '${HOLD}'], { stdio: 'ignore'${memberEnv} }); `
    + `process.stdout.write(c.pid + '\\n'); ${o.leaderExits ? 'setTimeout(() => process.exit(0), 100);' : `${HOLD};`}`;
  const { child: leader, entry } = spawnRecorded(process.execPath, ['-e', script], {
    detached: true, stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: process.env['PATH'] },
  }) as { child: ChildProcess; entry: Entry };
  const member = await new Promise<number>((resolve, reject) => {
    leader.stdout!.once('data', (d: Buffer) => resolve(Number(d.toString('utf8').trim())));
    leader.once('error', reject);
  });
  leader.stdout!.destroy();
  if (o.leaderExits) await new Promise((r) => leader.once('exit', r));
  leader.unref();
  return { entry, member };
}

// The registries of the run this test process is in, as the canonical runner
// hands them to it; run by hand, outside a run, `standIn` stands in for one.
// With what restores the environment.
function runRegistries(standIn: string): { runs: string[]; restore: () => void } {
  mkdirSync(standIn, { recursive: true });
  const restore = process.env[REGISTRY_ENV] ? () => undefined : nestRegistry(standIn);
  return { runs: process.env[REGISTRY_ENV]!.split(delimiter).filter((d) => d !== ''), restore };
}

// Which of the record files `names` `dir` holds.
const heldIn = (dir: string, names: string[]) => names.filter((n) => readdirSync(dir).includes(n));

test('what this file\'s helpers start is in the run\'s registry, and in a registry of a test\'s own added beside it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'asep-registry-helpers-'));
  const own = join(dir, 'own');
  mkdirSync(own);
  const run = runRegistries(join(dir, 'run'));
  const restore = nestRegistry(own);
  const started: Entry[] = [];
  try {
    assert.deepEqual(process.env[REGISTRY_ENV]!.split(delimiter), [own, ...run.runs],
      'a registry of a test\'s own is added to the run\'s, never put in its place');
    started.push(recorded());
    started.push((await group()).entry);
    const names = started.map((e) => `${e.pid}.json`).sort();
    assert.deepEqual(readdirSync(own).sort(), names, 'both helpers record what they start in the test\'s own registry');
    for (const r of run.runs) assert.deepEqual(heldIn(r, names), names, `and in the run's, ${r}`);
    for (const e of started) finish(e);
    assert.deepEqual(readdirSync(own), [], 'and forget it in each once it is shown gone');
    for (const r of run.runs) assert.deepEqual(heldIn(r, names), [], `the run's too, ${r}`);
  } finally {
    for (const e of started) finish(e);
    restore();
    run.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a process that is still the one recorded — its pid, start time and token — is ended with its whole group', async () => {
  const g = await group();
  try {
    assert.equal(stillRunning(g.entry.pid, true), true);
    assert.equal(endProcess(g.entry), 'ended');
    assert.equal(stillRunning(g.entry.pid, true), false, 'nothing of its group runs');
    assert.equal(stillRunning(g.member), false, 'its member went with it');
    assert.equal(endProcess(g.entry), 'gone', 'and there is nothing left to end');
  } finally {
    finish(g.entry);
  }
});

test('a pid whose process does not show the recorded start time and token is left alone, though it runs the same command line', () => {
  const ours = recorded();
  const bare = lone();
  const tokenAlike = `${ours.token.slice(0, -1)}${ours.token.endsWith('0') ? '1' : '0'}`;
  const near = lone({ [TOKEN_ENV]: tokenAlike });
  const nearEntry = identityOf(near.pid, { token: tokenAlike, group: true }) as Entry;
  register(nearEntry);
  try {
    // The same executable and arguments: only the token and start time tell
    // them apart.
    const args = (pid: number) => spawnSync('ps', ['-ww', '-o', 'args=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
    assert.equal(args(bare.pid!), args(ours.pid));
    assert.equal(args(near.pid!), args(ours.pid));
    const entryOf = (pid: number, startedAt: string): Entry => ({ version: RECORD_VERSION, pid, group: true, token: ours.token, startedAt });
    const others: readonly [string, Entry][] = [
      ['no token at all', entryOf(bare.pid!, startOf(bare.pid!))],
      ['a token that differs in its last character', entryOf(near.pid!, startOf(near.pid!))],
      ['the token, but another start time', entryOf(ours.pid, LONG_AGO)],
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
    finish(ours);
    bare.kill('SIGKILL');
    finish(nearEntry);
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
    finish(ours.entry);
    // Its stranger first, by the stranger's own identity; then nothing of the
    // group is left, and its record goes.
    endProcess(identityOf(unproven.member, { token: memberToken }) ?? { pid: unproven.member, group: false, token: memberToken });
    finish(unproven.entry);
  }
});

test('a group whose leader still runs is signalled only while every other member shows its token too', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'asep-registry-members-'));
  const strangerToken = randomUUID();
  // The reviewer's two probes: a member with another token, and a member
  // whose environment cannot be read, each beside a leader that runs and shows
  // the recorded token.
  const stranger = await group({ memberToken: strangerToken });
  const hidden = await group();
  const ours = await group();
  const proc = join(dir, 'proc');
  const run = join(dir, 'run');
  mkdirSync(run);
  register(hidden.entry, run);
  const before = process.env[PROC_ENV];
  try {
    assert.equal(endProcess(stranger.entry), 'unknown', 'a member that shows another token');
    assert.equal(stillRunning(stranger.entry.pid), true, 'its leader was not signalled');
    assert.equal(stillRunning(stranger.member), true, 'nor its member');

    // Through a /proc where the leader shows its token and the member's
    // environment cannot be read (it is a directory).
    mkdirSync(join(proc, String(hidden.entry.pid)), { recursive: true });
    writeFileSync(join(proc, String(hidden.entry.pid), 'environ'), `PATH=/usr/bin\0${TOKEN_ENV}=${hidden.entry.token}\0`);
    mkdirSync(join(proc, String(hidden.member), 'environ'), { recursive: true });
    process.env[PROC_ENV] = proc;
    try {
      assert.equal(endProcess(hidden.entry), 'unknown', 'a member whose environment cannot be read');
      assert.deepEqual(endRecorded(run).map((e: Entry & { outcome: string }) => [e.pid, e.outcome]), [[hidden.entry.pid, 'unknown']]);
      assert.deepEqual(readdirSync(run), [`${hidden.entry.pid}.json`], 'the record stays');
    } finally {
      setEnv(PROC_ENV, before);
    }
    assert.equal(stillRunning(hidden.entry.pid), true, 'its leader was not signalled');
    assert.equal(stillRunning(hidden.member), true, 'nor its member');

    // A table whose list of the group's members cannot be read: unknown too.
    const listing = join(dir, 'ps-no-listing');
    writeFileSync(listing, '#!/bin/sh\ncase " $* " in *" -A "*) exit 1;; esac\nexec ps "$@"\n');
    chmodSync(listing, 0o755);
    const ps = process.env[PS_ENV];
    process.env[PS_ENV] = listing;
    try {
      assert.equal(endProcess(ours.entry), 'unknown', 'members that cannot be listed');
    } finally {
      setEnv(PS_ENV, ps);
    }
    assert.equal(stillRunning(ours.member), true, 'and nothing was signalled');

    // Every member shows the token: the group is ended whole.
    assert.equal(endProcess(ours.entry), 'ended');
    assert.equal(stillRunning(ours.member), false);
  } finally {
    setEnv(PROC_ENV, before);
    // The stranger by its own identity first; then nothing of its group is
    // left that is not ours.
    endProcess(identityOf(stranger.member, { token: strangerToken }) ?? { pid: stranger.member, group: false, token: strangerToken });
    for (const g of [stranger, hidden, ours]) finish(g.entry);
    rmSync(dir, { recursive: true, force: true });
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
    finish(ours);
    finish(leaderless.entry);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a process whose environment the table does not show cannot be shown to be ours, nor recorded', () => {
  // On macOS `ps` shows no environment for the system's own binaries. Where
  // /proc shows every environment, the token shows, and the process is ours.
  const hidden = !existsSync('/proc/self/environ');
  const token = randomUUID();
  const sleeper = spawn('/bin/sleep', ['60'], { stdio: 'ignore', env: { [TOKEN_ENV]: token } });
  try {
    const entry = { version: RECORD_VERSION, pid: sleeper.pid!, group: false, token, startedAt: startOf(sleeper.pid!) };
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

test('a record that does not fully identify its process — one of an earlier format among them — is never acted on, and stays', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'asep-registry-records-'));
  const live = recorded();
  const leaderless = await group({ leaderExits: true });
  // A `ps` that cannot read any process's environment, and a /proc that shows
  // none.
  const ps = join(dir, 'ps-no-environment');
  writeFileSync(ps, '#!/bin/sh\ncase " $* " in *" -E "*) exit 1;; esac\nexec ps "$@"\n');
  chmodSync(ps, 0o755);
  const proc = join(dir, 'proc');
  mkdirSync(proc);
  // As the format before the token wrote a record: a marker, no token, no
  // start time.
  const marked = (pid: number) => JSON.stringify({ pid, group: true, marker: `asep-fake-container-${randomUUID()}` });
  const unversioned = { pid: live.pid, group: live.group, token: live.token, startedAt: live.startedAt };
  const records: readonly { what: string; pid: number; text: string; why: string }[] = [
    { what: 'an earlier format, for a leader that runs', pid: live.pid, text: marked(live.pid),
      why: `its record is not of format version ${RECORD_VERSION}` },
    { what: 'an earlier format, for a group whose leader has exited and whose member\'s environment cannot be read',
      pid: leaderless.entry.pid, text: marked(leaderless.entry.pid), why: `its record is not of format version ${RECORD_VERSION}` },
    { what: 'the format before the version: token and start time, no version', pid: live.pid, text: JSON.stringify(unversioned),
      why: `its record is not of format version ${RECORD_VERSION}` },
    { what: 'no token', pid: live.pid, text: JSON.stringify({ ...live, token: undefined }), why: 'its record has no token' },
    { what: 'an empty token', pid: live.pid, text: JSON.stringify({ ...live, token: '' }), why: 'its record has no token' },
    { what: 'no start time', pid: live.pid, text: JSON.stringify({ ...live, startedAt: undefined }), why: 'its record has no start time' },
    { what: 'a start time that is none', pid: live.pid, text: JSON.stringify({ ...live, startedAt: 'soon' }),
      why: 'its record has no start time' },
    { what: 'no word on its group', pid: live.pid, text: JSON.stringify({ ...live, group: undefined }),
      why: 'its record does not say whether it leads a group' },
    { what: 'no pid', pid: live.pid, text: JSON.stringify({ ...live, pid: undefined }), why: 'its record has no pid' },
    { what: 'a record that cannot be read', pid: live.pid, text: '{"pid": ', why: 'its record cannot be read' },
  ];
  const before = { ps: process.env[PS_ENV], proc: process.env[PROC_ENV] };
  try {
    process.env[PS_ENV] = ps;
    process.env[PROC_ENV] = proc;
    try {
      for (const [i, r] of records.entries()) {
        const run = join(dir, `run-${i}`);
        mkdirSync(run);
        writeFileSync(join(run, `${r.pid}.json`), r.text);
        if (r.text.endsWith('}')) assert.equal(endProcess(JSON.parse(r.text)), 'unknown', r.what);
        const found = endRecorded(run) as Record<string, unknown>[];
        assert.deepEqual(found.map((e) => [e['record'], e['outcome'], e['why']]), [[`${r.pid}.json`, 'unknown', r.why]], r.what);
        assert.deepEqual(readdirSync(run), [`${r.pid}.json`], `${r.what}: the record stays`);
      }
    } finally {
      setEnv(PS_ENV, before.ps);
      setEnv(PROC_ENV, before.proc);
    }
    assert.equal(stillRunning(live.pid, true), true, 'nothing was signalled');
    assert.equal(stillRunning(leaderless.member), true, 'nothing of the group was signalled');
  } finally {
    finish(live);
    finish(leaderless.entry);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a process is recorded only by a token it shows, and never by an empty one', () => {
  const empty = lone({ [TOKEN_ENV]: '' });
  try {
    assert.throws(() => identityOf(empty.pid!, { token: '', group: true }),
      /does not show its token in the process table \(it shows another, or none\), so it cannot be recorded/);
    const entry = { version: RECORD_VERSION, pid: empty.pid!, group: true, token: '', startedAt: startOf(empty.pid!) };
    assert.equal(endProcess(entry), 'unknown', 'a record with an empty token is never acted on');
    assert.equal(stillRunning(empty.pid!), true, 'and it was not signalled');
  } finally {
    empty.kill('SIGKILL');
  }
});

test('a group whose leader exited before it was recorded is recorded by the start time the leader still shows, and ended', () => {
  // The leader starts a member of its group and exits at once. This process
  // does not reap it while it does not return to its event loop, so until then
  // the table shows it exited, with its start time.
  const token = randomUUID();
  const script = `require('node:child_process').spawn(process.execPath, ['-e', '${HOLD}'], { stdio: 'ignore' }); process.exit(0);`;
  const leader = spawn(process.execPath, ['-e', script], {
    detached: true, stdio: 'ignore', env: { PATH: process.env['PATH'], [TOKEN_ENV]: token },
  });
  let entry: Entry | undefined;
  try {
    const exited = () => spawnSync('ps', ['-o', 'stat=', '-p', String(leader.pid)], { encoding: 'utf8' }).stdout.trim().startsWith('Z');
    const until = Date.now() + 10_000;
    while (!exited() && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    assert.ok(exited(), 'the leader has exited, and waits to be reaped');
    entry = identityOf(leader.pid!, { token, group: true }) as Entry;
    register(entry);
    assert.deepEqual(entry, { version: RECORD_VERSION, pid: leader.pid, group: true, token, startedAt: startOf(leader.pid!) });
    assert.equal(stillRunning(leader.pid!, true), true, 'its member runs on in its group');
    assert.equal(endProcess(entry), 'ended');
    assert.equal(stillRunning(leader.pid!, true), false, 'nothing of its group runs');
  } finally {
    finish(entry);
  }
});

test('where /proc shows environments, one that cannot be read is not absence: nothing is signalled, and the record stays', () => {
  const dir = mkdtempSync(join(tmpdir(), 'asep-registry-proc-'));
  const proc = join(dir, 'proc');
  const ours = recorded();
  const run = join(dir, 'run');
  mkdirSync(run);
  register(ours, run);
  const before = process.env[PROC_ENV];
  try {
    process.env[PROC_ENV] = proc;
    // Its environment as /proc shows it: entries ended by NUL.
    mkdirSync(join(proc, String(ours.pid)), { recursive: true });
    writeFileSync(join(proc, String(ours.pid), 'environ'), `PATH=/usr/bin\0${TOKEN_ENV}=${ours.token}\0HOME=/nowhere\0`);
    assert.deepEqual(identityOf(ours.pid, { token: ours.token, group: true }), ours, 'read there, it shows its token');
    // Now it cannot be read: its environ is a directory.
    rmSync(join(proc, String(ours.pid), 'environ'));
    mkdirSync(join(proc, String(ours.pid), 'environ'));
    assert.throws(() => identityOf(ours.pid, { token: ours.token, group: true }),
      /does not show its token in the process table \(its environment cannot be read\), so it cannot be recorded/);
    assert.equal(endProcess(ours), 'unknown');
    assert.deepEqual(endRecorded(run).map((e: Entry & { outcome: string }) => [e.pid, e.outcome]), [[ours.pid, 'unknown']]);
    assert.deepEqual(readdirSync(run), [`${ours.pid}.json`], 'the record stays');
    setEnv(PROC_ENV, before);
    assert.equal(stillRunning(ours.pid, true), true, 'and nothing was signalled');
  } finally {
    setEnv(PROC_ENV, before);
    finish(ours);
    rmSync(dir, { recursive: true, force: true });
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
  const outer = runRegistries(join(repo, 'outer-run'));
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
      const [first, ...rest] = env[REGISTRY_ENV]!.split(delimiter);
      ownRun = first!;
      assert.deepEqual(rest, outer.runs, 'a run started inside a run keeps the outer run\'s registry');
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
    for (const entry of entries) finish(entry);
    outer.restore();
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
    finish(runner);
    finish(leftover);
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

// --- what the tests themselves do with processes ---------------------------------

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Every test source — test files of each kind under the canonical roots, and
// the test tooling — as its repo-relative path and its lines.
function testSources(): [string, string[]][] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir).sort()) {
      if (['node_modules', 'dist', 'build', 'coverage', '.git'].includes(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(test|itest|live)\.ts$/.test(entry)) found.push(full);
    }
  };
  for (const root of TEST_ROOTS as string[]) if (existsSync(join(REPO, root))) walk(join(REPO, root));
  const tooling = join(REPO, 'scripts', 'testing');
  found.push(...readdirSync(tooling).filter((f) => f.endsWith('.mjs')).map((f) => join(tooling, f)));
  return found.map((f) => [relative(REPO, f), readFileSync(f, 'utf8').split('\n')]);
}

// A line that is a comment, not code.
const comment = (line: string) => /^\s*(\/\/|\*|\/\*)/.test(line);

// Where a test may signal a process group by a pid alone, and why that pid is
// still the process meant.
const GROUP_SIGNALS_BY_PID: readonly { file: string; match: string; why: string }[] = [
  {
    file: 'scripts/testing/fake-docker.mjs', match: 'kill(-child.pid',
    why: 'a container process just started that could not be recorded: this process has not reaped it, so its pid is not reused',
  },
];

test('no test signals a process group by a pid alone, without the identity the registry records', () => {
  const found = testSources().flatMap(([file, lines]) => lines.flatMap((line, i) => (
    !comment(line) && /process\.kill\(\s*-/.test(line)
      && !GROUP_SIGNALS_BY_PID.some((a) => a.file === file && line.includes(a.match))
      ? [`${file}:${i + 1}: ${line.trim()}`] : [])));
  assert.deepEqual(found, [], 'end a recorded process with endProcess(entry), by its pid, start time and token');
  for (const a of GROUP_SIGNALS_BY_PID) {
    assert.ok(testSources().some(([file, lines]) => file === a.file && lines.some((l) => l.includes(a.match))),
      `${a.file}: '${a.match}' is no longer there; drop it from the list`);
  }
});

// Where a test starts a process without recording it in the run's registry,
// and why that is safe. No match names the call itself, so that this list is
// not one of the places it lists.
const SPAWNS_NOT_RECORDED: readonly { file: string; match: string; why: string }[] = [
  {
    file: 'adapters/agent-claude/src/agent-claude.test.ts', match: "(h.docker, ['run'",
    why: 'a docker client through the harness shim, which ends with its container; the fake docker records the container',
  },
  {
    file: 'adapters/agent-claude/src/agent-claude.test.ts', match: "const proxy = spawn",
    why: 'in the proxy starter\'s source: the starter is recorded, and the test records the proxy by the token it hands it',
  },
  {
    file: 'adapters/agent-claude/src/claude-live.live.ts', match: "(process.execPath, [join(TESTING, 'fake-model-api.mjs')",
    why: 'run by pnpm test:live:claude, outside the canonical run and its registry; the test kills it',
  },
  {
    file: 'adapters/command-runner/src/command-runner.test.ts', match: 'const child = spawn',
    why: 'the docker client of the code under test, through its spawn seam; it ends with its container, which the fake docker records',
  },
  {
    file: 'adapters/command-runner/src/command-runner.test.ts', match: "(join(dir, 'no-such-docker')",
    why: 'a binary that does not exist: nothing starts',
  },
  {
    file: 'adapters/command-runner/src/command-runner.test.ts', match: 'const orphan = spawn',
    why: 'a docker client through the fake daemon\'s shim, killed by the test at once; the fake docker records its container',
  },
  {
    file: 'apps/control-plane-api/src/crash-takeover.itest.ts', match: "(process.execPath, ['--import', 'tsx'",
    why: 'run by run-integration.mjs, which keeps no process registry; the test kills it',
  },
  {
    file: 'scripts/forbidden-imports.test.ts', match: "('git', ['status'])",
    why: 'source text under test, not a call',
  },
  {
    file: 'scripts/lib/process-registry.test.ts', match: "(process.execPath, ['-e', HOLD], {",
    why: 'lone(): by design it shows no token of ours, or another one, so it cannot be recorded by one; '
      + 'it holds a minute at most, and its test kills it',
  },
  {
    file: 'scripts/lib/process-registry.test.ts', match: "child_process').spawn",
    why: 'a member of a recorded group',
  },
  {
    file: 'scripts/lib/process-registry.test.ts', match: "(process.execPath, ['-e', script], {",
    why: 'a leader that exits at once, recorded by its test with identityOf after it has exited and before it is reaped — '
      + 'the test\'s point; its member holds a minute at most',
  },
  {
    file: 'scripts/lib/process-registry.test.ts', match: "('/bin/sleep'",
    why: 'a system binary whose environment ps on macOS does not show, so it cannot be recorded there — the test\'s point; '
      + 'it ends by itself within a minute, and its test kills it',
  },
  {
    file: 'scripts/run-canonical-tests.test.ts', match: "child_process').spawn",
    why: 'a member of the group its fixture records',
  },
  {
    file: 'scripts/testing/fake-docker.mjs', match: 'const child = spawn',
    why: 'a container process, recorded at once with identityOf and register, before its container record',
  },
  {
    file: 'scripts/testing/fake-docker.test.ts', match: "child_process').spawn",
    why: "a member of a recorded container's group",
  },
];

// Where a test hands a registry to a process it starts, in an environment it
// makes, and why the run's registry is kept in it.
const REGISTRIES_IN_ENVIRONMENTS: readonly { file: string; match: string; why: string }[] = [
  {
    file: 'scripts/testing/fake-docker.test.ts', match: 'dirs.join(delimiter) }',
    why: 'registryEnv(): a registry of the test\'s own joined with the run\'s, read from this process\'s environment',
  },
];

test('no test drops the run\'s registry: one of its own is added with nestRegistry, never put in its place', () => {
  const env = String.raw`process\.env(?:\[\s*REGISTRY_ENV\s*\]|\.ASEP_PROCESS_REGISTRY|\[\s*['"]ASEP_PROCESS_REGISTRY['"]\s*\])`;
  const changed = new RegExp(`${env}\\s*=(?!=)|delete\\s+${env}`);
  const handed = /\[\s*REGISTRY_ENV\s*\]\s*:|\bASEP_PROCESS_REGISTRY['"]?\s*:/;
  const found = testSources().flatMap(([file, lines]) => lines.flatMap((line, i) => (
    !comment(line) && (changed.test(line)
      || (handed.test(line) && !REGISTRIES_IN_ENVIRONMENTS.some((a) => a.file === file && line.includes(a.match))))
      ? [`${file}:${i + 1}: ${line.trim()}`] : [])));
  assert.deepEqual(found, [], 'add a registry of a test\'s own with nestRegistry, which keeps the run\'s');
  for (const a of REGISTRIES_IN_ENVIRONMENTS) {
    assert.ok(testSources().some(([file, lines]) => file === a.file && lines.some((l) => l.includes(a.match))),
      `${a.file}: '${a.match}' is no longer there; drop it from the list`);
  }
});

test('every process a test starts is recorded in the run\'s registry, or the list here says why it need not be', () => {
  const calls = testSources().flatMap(([file, lines]) => lines.flatMap((line, i) => (
    !comment(line) && /(?<![\w$])spawn\(/.test(line) ? [{ file, at: `${file}:${i + 1}: ${line.trim()}`, line }] : [])));
  const unlisted = calls.filter((c) => !SPAWNS_NOT_RECORDED.some((s) => s.file === c.file && c.line.includes(s.match)));
  assert.deepEqual(unlisted.map((c) => c.at), [],
    'start a long-lived process with spawnRecorded, or say here why it need not be recorded');
  for (const s of SPAWNS_NOT_RECORDED) {
    assert.ok(calls.some((c) => c.file === s.file && c.line.includes(s.match)), `${s.file}: '${s.match}' is no longer there`);
  }
});
