// A run-scoped registry of the long-lived processes that tests start — the
// fake docker's containers, the egress proxies tests run — kept outside every
// test process, so that what a test process leaves behind when it dies can
// still be found and ended. The canonical runner (run-canonical-tests.mjs)
// opens a run, hands its directory to the tests in ASEP_PROCESS_REGISTRY, and
// ends whatever is still recorded when the tests are done; at its start it does
// the same for every run whose runner is gone.
//
//   <root>/<run>/owner.json   the runner that owns the run: { pid, startedAt }
//   <root>/<run>/<pid>.json   one process: { pid, group, token, startedAt }
//
// <root> belongs to one checkout (tmpdir()/asep-process-registry/<hash of its
// real path>), so a run never touches another checkout's processes. Without
// ASEP_PROCESS_REGISTRY (a test run by hand) nothing is recorded.
//
// Identity. A recorded process is started with a token of its own in its
// environment (ASEP_PROCESS_TOKEN, a random UUID), and recorded with that
// token and its start time as the process table shows them. It is signalled
// only while the process at its pid shows both; a pid that another process has
// now is left alone. A group entry (a detached process that leads its own
// group) ends the whole group; once its leader has exited, what is left of the
// group is ended only if every member shows the token (members inherit it) and
// started no earlier than the leader.
//
// Unknown is not absence. When the process table cannot be read — `ps` fails,
// by its status, a spawn error or a signal, or a process's environment cannot
// be read — nothing is signalled, the record stays, and the cleanup fails. On
// macOS `ps` shows no environment for the system's own binaries (/bin/sleep,
// /bin/sh), so such a process cannot be recorded: recording it fails.

import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const REGISTRY_ENV = 'ASEP_PROCESS_REGISTRY';
export const TOKEN_ENV = 'ASEP_PROCESS_TOKEN';
// For this module's own tests: the `ps` the process table is read with.
export const PS_ENV = 'ASEP_PROCESS_TABLE_PS';

// How long a killed process may take to be shown gone.
export const END_WAIT_MS = 2_000;

export function registryRoot(repoRoot) {
  const hash = createHash('sha256').update(realpathSync(repoRoot)).digest('hex').slice(0, 12);
  return join(tmpdir(), 'asep-process-registry', hash);
}

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function writeWhole(path, value) {
  const partial = `${path}.${process.pid}.partial`;
  writeFileSync(partial, JSON.stringify(value));
  renameSync(partial, path);
}

function readEntry(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

// `ps` with `args`: its output, or undefined when it failed — a spawn error, a
// signal, or a status other than 0.
function ps(args) {
  const r = spawnSync(process.env[PS_ENV] || 'ps', args, { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
  if (r.error !== undefined || r.signal !== null || r.status !== 0) return undefined;
  return r.stdout;
}

// Whether `target` (a pid, or a negated group id) can be signalled: 'absent'
// when there is no such process, 'foreign' when it is another user's.
function probe(target) {
  try {
    process.kill(target, 0);
    return 'present';
  } catch (err) {
    if (err.code === 'ESRCH') return 'absent';
    return err.code === 'EPERM' ? 'foreign' : 'present';
  }
}

// What the process table shows of `pid`: { state } with 'absent', 'foreign'
// (another user's, so never one started here), 'exited' (it waits to be
// reaped), 'running' (with its startedAt), or 'unknown' (the table could not be
// read).
function look(pid) {
  const first = probe(pid);
  if (first !== 'present') return { state: first };
  const out = ps(['-o', 'pid=,stat=,lstart=', '-p', String(pid)]);
  const m = out === undefined ? null : /^\s*(\d+)\s+(\S+)\s+(.*?)\s*$/m.exec(out);
  if (!m || Number(m[1]) !== pid) {
    // Gone meanwhile — `ps` fails for a missing pid too — or not readable.
    return { state: probe(pid) === 'absent' ? 'absent' : 'unknown' };
  }
  if (m[2].startsWith('Z')) return { state: 'exited' };
  return { state: 'running', startedAt: m[3] };
}

const PROC_ENVIRON = existsSync('/proc/self/environ');

// The token in `pid`'s environment: its value, null when the environment the
// table shows has none, undefined when its environment cannot be read.
function tokenOf(pid) {
  if (PROC_ENVIRON) {
    let raw;
    try {
      raw = readFileSync(`/proc/${pid}/environ`, 'utf8');
    } catch {
      return undefined;
    }
    const entry = raw.split('\0').find((e) => e.startsWith(`${TOKEN_ENV}=`));
    return entry === undefined ? null : entry.slice(TOKEN_ENV.length + 1);
  }
  // macOS: `ps -E` shows the environment after the command line, where it
  // shows one at all; the same command line alone means it showed none.
  const withEnv = ps(['-E', '-ww', '-o', 'command=', '-p', String(pid)]);
  const without = ps(['-ww', '-o', 'command=', '-p', String(pid)]);
  if (withEnv === undefined || without === undefined || withEnv.trim() === without.trim()) return undefined;
  const found = [...withEnv.slice(without.trimEnd().length).matchAll(new RegExp(`(?:^|\\s)${TOKEN_ENV}=(\\S+)`, 'g'))];
  return found.length === 0 ? null : found.at(-1)[1];
}

// The members of process group `pgid` that have not exited, as { pid,
// startedAt }; undefined when the table cannot be read.
function membersOf(pgid) {
  const out = ps(['-A', '-o', 'pid=,pgid=,stat=,lstart=']);
  if (out === undefined) return undefined;
  return out.split('\n').flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*?)\s*$/.exec(line);
    if (!m || Number(m[2]) !== pgid || m[3].startsWith('Z')) return [];
    return [{ pid: Number(m[1]), startedAt: m[4] }];
  });
}

/**
 * What identifies `pid`, started with `token` in its environment — with
 * `group`, as the leader of its own group: { pid, group, token, startedAt }.
 * Throws when the process table does not show it with that token, so that it
 * could not be told apart from another process later. A process that has
 * already exited is identified by its token alone if it led a group (its
 * members carry it), and not at all otherwise: nothing of it is left.
 */
export function identityOf(pid, { token, group = false }) {
  const leader = look(pid);
  if (leader.state === 'running') {
    const shown = tokenOf(pid);
    if (shown === token) return { pid, group, token, startedAt: leader.startedAt };
    // Unless it exited meanwhile, it cannot be told apart.
    if (['running', 'unknown', 'foreign'].includes(look(pid).state)) {
      throw new Error(`process ${pid} does not show its token in the process table `
        + `(${shown === undefined ? 'its environment cannot be read' : 'it shows another, or none'}), so it cannot be recorded`);
    }
  } else if (leader.state === 'unknown' || leader.state === 'foreign') {
    throw new Error(`process ${pid} cannot be read in the process table, so it cannot be recorded`);
  }
  return group ? { pid, group, token } : undefined;
}

// Whether anything of `entry` still runs: 'absent', 'present' or 'unknown'.
// A pid that shows another start time is another process's now.
function presence({ pid, group = false, startedAt }) {
  const leader = look(pid);
  if (leader.state === 'unknown') return 'unknown';
  // A pid is not reused while a group of that id exists: one that is another
  // process's now has no group of ours left either.
  if (leader.state === 'running') return startedAt === undefined || leader.startedAt === startedAt ? 'present' : 'absent';
  if (leader.state === 'foreign' || !group || probe(-pid) === 'absent') return 'absent';
  const members = membersOf(pid);
  if (members === undefined) return 'unknown';
  return members.length > 0 ? 'present' : 'absent';
}

// Whether `entry` is still the process recorded: 'ours' when its pid shows its
// start time and its token — or, for a group whose leader has exited, every
// member left shows the token and started no earlier; 'gone' when nothing of
// it is left; 'not-ours' when its pid is another process's now; 'unknown' when
// the table does not tell.
function identify({ pid, group = false, token, startedAt }) {
  let leader = look(pid);
  if (leader.state === 'running') {
    if (startedAt === undefined || leader.startedAt !== startedAt) return 'not-ours';
    const shown = tokenOf(pid);
    if (shown === token) return 'ours';
    leader = look(pid);
    if (leader.state === 'running' && leader.startedAt === startedAt) return shown === undefined ? 'unknown' : 'not-ours';
    // Otherwise it exited meanwhile, and what is left is judged below.
  }
  if (leader.state === 'unknown') return 'unknown';
  if (leader.state === 'foreign') return 'not-ours';
  if (leader.state === 'running') return 'not-ours';
  if (!group || probe(-pid) === 'absent') return 'gone';
  const members = membersOf(pid);
  if (members === undefined) return 'unknown';
  if (members.length === 0) return 'gone';
  const since = startedAt === undefined ? -Infinity : Date.parse(startedAt);
  for (const m of members) {
    const at = Date.parse(m.startedAt);
    if (Number.isNaN(since) || Number.isNaN(at) || at < since || tokenOf(m.pid) !== token) return 'unknown';
  }
  return 'ours';
}

/**
 * Whether `pid` still runs — or, with `group`, anything in the process group
 * it leads. A process that has exited and only waits to be reaped does not.
 * When the process table cannot be read the answer is true: unknown is never
 * absence.
 */
export function stillRunning(pid, group = false) {
  return presence({ pid, group }) !== 'absent';
}

/**
 * End the process `entry` records — with `group`, the whole process group it
 * leads — if it is still that process (see the header), and wait until it is
 * shown gone. 'gone': nothing was left to end; 'ended': it was killed and is
 * gone; 'not-ours': its pid is another process's now, which was left alone;
 * 'unknown': the process table did not tell, and nothing was signalled — or,
 * after the signal, whether it is gone; 'still-running': killed, but not shown
 * gone within `waitMs`. `kill` sends the signal.
 */
export function endProcess(entry, { waitMs = END_WAIT_MS, kill = (target, signal) => process.kill(target, signal) } = {}) {
  const who = identify(entry);
  if (who !== 'ours') return who;
  for (const target of entry.group ? [-entry.pid, entry.pid] : [entry.pid]) {
    try {
      kill(target, 'SIGKILL');
    } catch { /* not a group leader, or gone meanwhile */ }
  }
  const until = performance.now() + waitMs;
  for (let i = 1; ; i++) {
    // Nothing left to signal is gone. One that has exited but is not reaped
    // yet is gone too; the table is read now and then, since the signal alone
    // cannot tell.
    if (probe(entry.pid) === 'absent' && (!entry.group || probe(-entry.pid) === 'absent')) return 'ended';
    if (i % 10 === 0 && presence(entry) === 'absent') return 'ended';
    if (performance.now() > until) break;
    pause(10);
  }
  const last = presence(entry);
  return last === 'absent' ? 'ended' : last === 'unknown' ? 'unknown' : 'still-running';
}

/** Whether an outcome of endProcess shows nothing of the process left to end. */
export const shownGone = (outcome) => outcome === 'gone' || outcome === 'ended' || outcome === 'not-ours';

/**
 * End every process recorded in `dir` (one `<pid>.json` each) with `end`,
 * removing the record of each one shown gone; returns each record with what
 * became of it.
 */
export function endRecorded(dir, end = endProcess) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names.filter((n) => n.endsWith('.json') && n !== 'owner.json')) {
    const entry = readEntry(join(dir, name));
    if (entry === undefined || !Number.isSafeInteger(entry.pid)) continue;
    const outcome = end(entry);
    if (shownGone(outcome)) rmSync(join(dir, name), { force: true });
    out.push({ ...entry, outcome });
  }
  return out;
}

/** Record `entry` (identityOf) in the current run, if there is one. */
export function register(entry, dir = process.env[REGISTRY_ENV]) {
  if (!dir || entry === undefined) return;
  writeWhole(join(dir, `${entry.pid}.json`), entry);
}

/** Forget `pid`: it has been shown gone. */
export function unregister(pid, dir = process.env[REGISTRY_ENV]) {
  if (!dir || !Number.isSafeInteger(pid)) return;
  rmSync(join(dir, `${pid}.json`), { force: true });
}

/**
 * child_process.spawn, with a token of the child's own in its environment,
 * and the child recorded in the current run — as a group when `detached`.
 * Returns the child and what identifies it (undefined when it never started,
 * or has already exited and leads no group). A child that cannot be recorded
 * is killed, and the error thrown.
 */
export function spawnRecorded(command, args, options = {}, dir = process.env[REGISTRY_ENV]) {
  const token = randomUUID();
  const child = spawn(command, args, { ...options, env: { ...(options.env ?? process.env), [TOKEN_ENV]: token } });
  if (child.pid === undefined) return { child, entry: undefined };
  const group = options.detached === true;
  try {
    const entry = identityOf(child.pid, { token, group });
    register(entry, dir);
    return { child, entry };
  } catch (err) {
    try {
      process.kill(group ? -child.pid : child.pid, 'SIGKILL');
    } catch { /* gone already */ }
    throw err;
  }
}

/** A shell line handing the current run to a shim's command; empty without one. */
export function registryShimLine(dir = process.env[REGISTRY_ENV]) {
  return dir ? `export ${REGISTRY_ENV}='${dir.replace(/'/g, `'\\''`)}'` : '';
}

// A run's directory is created whole, owner included, so a sweep never sees a
// run without its owner. The owner is this process, by its pid and start time.
function openRun(root) {
  const self = look(process.pid);
  if (self.state !== 'running') throw new Error('the process table does not show this runner, so it cannot own a run');
  mkdirSync(root, { recursive: true });
  const partial = join(root, `.${process.pid}-${Date.now()}`);
  mkdirSync(partial);
  writeWhole(join(partial, 'owner.json'), { pid: process.pid, startedAt: self.startedAt });
  const dir = join(root, partial.slice(root.length + 2));
  renameSync(partial, dir);
  return dir;
}

function closeRun(dir) {
  const ended = endRecorded(dir);
  if (ended.every((e) => shownGone(e.outcome))) rmSync(dir, { recursive: true, force: true });
  return ended;
}

/**
 * Run `fn` with a run of its own under `root` (registryRoot): first every run
 * there whose runner is gone is ended and removed, then `fn` gets the
 * environment that hands its run to the tests, and when it is done whatever is
 * still recorded in its run is ended. A run whose runner cannot be read in the
 * process table is left as it is, and listed with its runner's pid, `owner`,
 * and the outcome 'unknown'.
 */
export function withProcessRegistry(root, fn) {
  const earlier = [];
  let runs = [];
  try {
    runs = readdirSync(root).filter((n) => !n.startsWith('.'));
  } catch { /* no run yet */ }
  for (const run of runs) {
    const owner = readEntry(join(root, run, 'owner.json'));
    if (owner !== undefined && Number.isSafeInteger(owner.pid)) {
      const runner = look(owner.pid);
      if (runner.state === 'unknown') {
        earlier.push({ run, pid: owner.pid, owner: true, outcome: 'unknown' });
        continue;
      }
      if (runner.state === 'running' && runner.startedAt === owner.startedAt) continue;
    }
    earlier.push(...closeRun(join(root, run)).map((e) => ({ run, ...e })));
  }
  const dir = openRun(root);
  let result;
  try {
    result = fn({ ...process.env, [REGISTRY_ENV]: dir });
  } catch (err) {
    closeRun(dir);
    throw err;
  }
  return { result, earlier, left: closeRun(dir) };
}
