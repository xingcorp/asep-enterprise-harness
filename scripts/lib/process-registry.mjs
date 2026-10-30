// A run-scoped registry of the long-lived processes that tests start — the
// fake docker's containers and the egress proxies tests run — kept outside
// every test process, so that what a test process leaves behind when it dies
// can still be found and ended. The canonical runner (run-canonical-tests.mjs)
// opens a run, hands its directory to the tests in ASEP_PROCESS_REGISTRY, and
// ends whatever is still recorded when the tests are done; at its start it does
// the same for every run whose runner is gone.
//
//   <root>/<run>/owner.json   the runner that owns the run: { pid, marker }
//   <root>/<run>/<pid>.json   one process: { pid, group, marker }
//
// <root> belongs to one checkout (tmpdir()/asep-process-registry/<hash of its
// real path>), so a run never touches another checkout's processes. Without
// ASEP_PROCESS_REGISTRY (a test run by hand) nothing is recorded.
//
// A process is ended only while it is still the one recorded: its command line
// must contain the marker it was recorded with. A group entry (a detached
// process that leads its own group) ends the whole group.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const REGISTRY_ENV = 'ASEP_PROCESS_REGISTRY';

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

// Every process that is not a zombie, as { pid, pgid, args }; a zombie has
// exited and only waits to be reaped.
function processes(select) {
  const r = spawnSync('ps', ['-ww', '-o', 'pid=,pgid=,stat=,args=', ...select], { encoding: 'utf8' });
  return (r.stdout ?? '').split('\n').flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s?(.*)$/.exec(line);
    if (!m || m[3].startsWith('Z')) return [];
    return [{ pid: Number(m[1]), pgid: Number(m[2]), args: m[4] }];
  });
}

const commandOf = (pid) => processes(['-p', String(pid)])[0]?.args;

// Whether `target` (a pid, or a negated group id) is there to be signalled.
function signalled(target) {
  try {
    process.kill(target, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * Whether `pid` still runs — or, with `group`, anything in the process group it
 * leads. A process that has exited and only waits to be reaped does not.
 */
export function stillRunning(pid, group = false) {
  if (!signalled(pid) && !(group && signalled(-pid))) return false;
  return processes(['-A']).some((p) => p.pid === pid || (group && p.pgid === pid));
}

/**
 * End `pid` — with `group`, the whole process group it leads — if it is still
 * the process recorded with `marker`, and wait until it is shown gone. 'gone':
 * nothing was left to end; 'ended': it was killed and is gone; 'not-ours':
 * something else has that pid now, and was left alone; 'still-running': killed,
 * but not shown gone within `waitMs`.
 */
export function endProcess({ pid, group = false, marker }, waitMs = END_WAIT_MS) {
  if (!stillRunning(pid, group)) return 'gone';
  // A group outlives its leader while any member runs, and its id is not
  // reused while it exists: what is left of it is what was recorded.
  const command = commandOf(pid);
  if (command !== undefined && !command.includes(marker)) return 'not-ours';
  for (const target of group ? [-pid, pid] : [pid]) {
    try {
      process.kill(target, 'SIGKILL');
    } catch { /* not a group leader, or gone meanwhile */ }
  }
  const until = Date.now() + waitMs;
  for (let i = 1; ; i++) {
    // One that has exited but is not reaped yet is gone too; ps is asked now
    // and then, since the signal alone cannot tell.
    if (!(signalled(pid) || (group && signalled(-pid))) || (i % 10 === 0 && !stillRunning(pid, group))) return 'ended';
    if (Date.now() > until) return stillRunning(pid, group) ? 'still-running' : 'ended';
    pause(10);
  }
}

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
    if (outcome !== 'still-running') rmSync(join(dir, name), { force: true });
    out.push({ ...entry, outcome });
  }
  return out;
}

/** Record `pid` in the current run, if there is one. */
export function register(pid, { marker, group = false }, dir = process.env[REGISTRY_ENV]) {
  if (!dir || !Number.isSafeInteger(pid)) return;
  writeWhole(join(dir, `${pid}.json`), { pid, group, marker });
}

/** Forget `pid`: it has been shown gone. */
export function unregister(pid, dir = process.env[REGISTRY_ENV]) {
  if (!dir || !Number.isSafeInteger(pid)) return;
  rmSync(join(dir, `${pid}.json`), { force: true });
}

/** A shell line handing the current run to a shim's command; empty without one. */
export function registryShimLine(dir = process.env[REGISTRY_ENV]) {
  return dir ? `export ${REGISTRY_ENV}='${dir.replace(/'/g, `'\\''`)}'` : '';
}

// A run's directory is created whole, owner included, so a sweep never sees a
// run without its owner.
function openRun(root, marker) {
  mkdirSync(root, { recursive: true });
  const partial = join(root, `.${process.pid}-${Date.now()}`);
  mkdirSync(partial);
  writeWhole(join(partial, 'owner.json'), { pid: process.pid, marker });
  const dir = join(root, partial.slice(root.length + 2));
  renameSync(partial, dir);
  return dir;
}

function closeRun(dir) {
  const ended = endRecorded(dir);
  if (ended.every((e) => e.outcome !== 'still-running')) rmSync(dir, { recursive: true, force: true });
  return ended;
}

/**
 * Run `fn` with a run of its own: first every run under this checkout whose
 * runner is gone is ended and removed, then `fn` gets the environment that
 * hands its run to the tests, and when it is done whatever is still recorded
 * in its run is ended. `marker` is in the runner's own command line.
 */
export function withProcessRegistry(repoRoot, marker, fn) {
  const root = registryRoot(repoRoot);
  const earlier = [];
  let runs = [];
  try {
    runs = readdirSync(root).filter((n) => !n.startsWith('.'));
  } catch { /* no run yet */ }
  for (const run of runs) {
    const owner = readEntry(join(root, run, 'owner.json'));
    if (owner !== undefined && (commandOf(owner.pid) ?? '').includes(owner.marker)) continue;
    earlier.push(...closeRun(join(root, run)).map((e) => ({ run, ...e })));
  }
  const dir = openRun(root, marker);
  let result;
  try {
    result = fn({ ...process.env, [REGISTRY_ENV]: dir });
  } catch (err) {
    closeRun(dir);
    throw err;
  }
  return { result, earlier, left: closeRun(dir) };
}
