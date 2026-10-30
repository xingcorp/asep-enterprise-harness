// Container teardown by identity (exit criteria F3/G3).
//
// Killing a `docker run` client does not stop its container: the daemon keeps
// it running, and `--rm` only applies once it exits on its own. So every
// container the harness starts carries labels naming it, and whoever started it
// removes it BY THOSE LABELS when the client ends — however it ends — and then
// confirms none is left. A container that cannot be shown gone is reported, so
// the caller can fail closed instead of carrying on beside it.

import { spawn } from 'node:child_process';

export interface DockerResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  // The signal that ended the client, when one did.
  readonly signal?: string | null;
  // The call as its caller timed it. A result made by a test double has none.
  readonly call?: DockerCallRecord;
}

/**
 * One docker client call as its caller saw it, every moment read from
 * monotonicNow(): when it was spawned, how long the spawn itself took (it is
 * synchronous), how long until the client closed, the bound it was given, and
 * — when its caller killed it at that bound — how long after the spawn the
 * kill ran. A kill that runs well after its bound shows the caller's event
 * loop was held, not the client.
 */
export interface DockerCallRecord {
  // Its first words: `ps -aq`, `rm -f`, `network create`.
  readonly argv: string;
  readonly startedAt: number;
  readonly spawnMs: number;
  readonly durationMs: number;
  readonly cutMs: number;
  readonly cutAfterMs?: number;
  readonly spawned: boolean;
}

/**
 * Runs one docker client invocation; never throws. `timeoutMs` cuts this call
 * sooner than the caller's own bound (never later).
 */
export type DockerCall = (
  args: readonly string[], opts?: { readonly timeoutMs?: number },
) => Promise<DockerResult>;

const MAX_OUTPUT = 64 * 1024;

/**
 * How long one docker client call of a sandbox may take before its client is
 * killed. Every stop and removal is made of such calls, so this is what bounds
 * how long a container can outlive the decision to stop it.
 */
export const DOCKER_CALL_TIMEOUT_MS = 30_000;

// The docker client gets only what it needs to find its daemon. None of it
// reaches a container: a container's environment is exactly its `-e` list.
const DOCKER_CLIENT_ENV = [
  'PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY',
];

/** The environment every docker client call of a sandbox runs with. */
export function dockerClientEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of DOCKER_CLIENT_ENV) {
    const v = process.env[k];
    if (typeof v === 'string' && v !== '') env[k] = v;
  }
  if (env['PATH'] === undefined) env['PATH'] = '/usr/bin:/bin';
  return env;
}

/** The first words of a docker call, which name what it does. */
export function dockerArgvHead(args: readonly string[]): string {
  return args.slice(0, 2).join(' ');
}

/**
 * A bounded docker client call with a fixed environment, shell-free. Its
 * result carries the signal that ended the client, if any, and the call's
 * timing (DockerCallRecord).
 */
export function dockerCaller(
  binary: string, env: Readonly<Record<string, string>>, timeoutMs = DOCKER_CALL_TIMEOUT_MS,
): DockerCall {
  return (args, opts = {}) => new Promise((resolve) => {
    const startedAt = monotonicNow();
    const child = spawn(binary, [...args], { env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const spawnMs = monotonicNow() - startedAt;
    let stdout = '';
    let stderr = '';
    const cutMs = Math.max(1, Math.min(timeoutMs, opts.timeoutMs ?? timeoutMs));
    let cutAfterMs: number | undefined;
    const timer = setTimeout(() => {
      cutAfterMs = monotonicNow() - startedAt;
      child.kill('SIGKILL');
    }, cutMs);
    const call = (): DockerCallRecord => ({
      argv: dockerArgvHead(args), startedAt, spawnMs, durationMs: monotonicNow() - startedAt, cutMs,
      ...(cutAfterMs !== undefined ? { cutAfterMs } : {}), spawned: child.pid !== undefined,
    });
    child.stdout.on('data', (d: Buffer) => { if (stdout.length < MAX_OUTPUT) stdout += d.toString('utf8'); });
    child.stderr.on('data', (d: Buffer) => { if (stderr.length < MAX_OUTPUT) stderr += d.toString('utf8'); });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, signal: null, stdout: '', stderr: e.message, call: call() });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, call: call() });
    });
  });
}

const ms = (n: number): string => `${Math.round(n)}ms`;

/**
 * One docker call, for the reason a caller reports: what it was, when it
 * started relative to `since`, how it ended and how long it took, against its
 * bound — `ps -aq at +12ms: signal SIGKILL after 30004ms (spawn 3ms, bound
 * 30000ms, cut at 30001ms)`. A result with no record says so.
 */
export function describeDockerCall(args: readonly string[], r: DockerResult, since: number): string {
  const end = r.signal ? `signal ${r.signal}` : `exit ${r.code}`;
  const c = r.call;
  if (c === undefined) return `${dockerArgvHead(args)}: ${end} (untimed)`;
  const cut = c.cutAfterMs !== undefined ? `, cut at ${ms(c.cutAfterMs)}` : '';
  return `${c.argv} at +${ms(c.startedAt - since)}: ${end} after ${ms(c.durationMs)} `
    + `(spawn ${ms(c.spawnMs)}, bound ${ms(c.cutMs)}${cut})`;
}

/**
 * The calls a removal made, oldest first, for its failure reason; a long one
 * keeps its first and its latest calls.
 */
export class DockerCallTimeline {
  private readonly calls: string[] = [];
  private dropped = 0;
  private since: number | undefined;

  constructor(private readonly keep = 12) {}

  add(args: readonly string[], r: DockerResult): void {
    this.since ??= r.call?.startedAt ?? 0;
    this.calls.push(describeDockerCall(args, r, this.since));
    if (this.calls.length > this.keep) {
      this.calls.splice(1, 1);
      this.dropped++;
    }
  }

  toString(): string {
    if (this.calls.length === 0) return 'no docker call was made';
    const [first, ...rest] = this.calls;
    const gap = this.dropped > 0 ? [`(${this.dropped} more)`] : [];
    return [first, ...gap, ...rest].join('; ');
  }
}

// What `docker rm -f` says when the container is already going or gone.
const ALREADY_GONE = /no such container|already in progress/i;
// What `docker inspect` answers for a container that does not exist.
const NO_SUCH_CONTAINER = /no such container/i;

const brief = (r: DockerResult): string => r.stderr.trim().slice(0, 200)
  || (r.signal ? `killed by ${r.signal}${r.call?.cutAfterMs !== undefined ? ' at its bound' : ''}` : `exit ${r.code}`);

/**
 * Epoch milliseconds that only move forward: the wall clock at the process's
 * start plus monotonic time since. Unlike Date.now(), a wall-clock adjustment
 * during a run does not move it, so the interval between two readings is what
 * the timers bounding it measured. Every bounded moment of a sandbox — its
 * deadlines and the lifecycle moments it reports — is read from it.
 */
export function monotonicNow(): number {
  return performance.timeOrigin + performance.now();
}

/** The clock a removal is timed by; a test may run it on virtual time. */
export interface TeardownClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const REAL_CLOCK: TeardownClock = {
  now: monotonicNow,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/**
 * Remove every container carrying `label` (`key=value`) and confirm that none
 * is left. Returns undefined once `docker ps -a` lists none, or the reason it
 * could not be shown gone after `attempts` tries — or by `until` (a clock
 * instant), when given: no try starts after it, and every call is cut at what
 * is left of it.
 */
export async function removeLabelledContainers(
  docker: DockerCall,
  label: string,
  opts: {
    readonly attempts?: number; readonly intervalMs?: number; readonly until?: number; readonly clock?: TeardownClock;
  } = {},
): Promise<string | undefined> {
  const attempts = opts.attempts ?? 20;
  const intervalMs = opts.intervalMs ?? 250;
  const clock = opts.clock ?? REAL_CLOCK;
  const left = (): number => (opts.until === undefined ? Infinity : opts.until - clock.now());
  const cut = (): { timeoutMs?: number } => (opts.until === undefined ? {} : { timeoutMs: left() });
  let last = 'not checked';
  const calls = new DockerCallTimeline();
  const call = async (args: readonly string[]): Promise<DockerResult> => {
    const r = await docker(args, cut());
    calls.add(args, r);
    return r;
  };
  for (let i = 0; i < attempts && left() > 0; i++) {
    if (i > 1) await clock.sleep(Math.min(intervalMs, left()));
    if (left() <= 0) break;
    const ps = await call(['ps', '-aq', '--filter', `label=${label}`]);
    if (ps.code !== 0) {
      last = `docker ps failed: ${brief(ps)}`;
      continue;
    }
    const ids = ps.stdout.split(/\s+/).filter((x) => x !== '');
    if (ids.length === 0) return undefined;
    if (left() <= 0) {
      last = `${ids.join(', ')} still listed`;
      break;
    }
    const rm = await call(['rm', '-f', ...ids]);
    last = rm.code === 0 || ALREADY_GONE.test(rm.stderr)
      ? `${ids.join(', ')} still listed`
      : `docker rm failed: ${brief(rm)}`;
  }
  const when = opts.until === undefined ? '' : ' in time';
  return `container(s) labelled ${label} could not be shown removed${when}: ${last}; calls: ${calls}`;
}

/**
 * Remove the container `name` and show it gone by `until` (a clock instant):
 * `docker rm -f`, then `docker inspect`, which must answer that no such
 * container exists — after an rm that succeeded or one that failed alike. While
 * the container is still shown, or a call failed, both are tried again, up to
 * `attempts` times; no try starts after `until`, and every call is cut at what
 * is left of it. Returns undefined once the container is shown gone, else why
 * it could not be.
 */
export async function removeContainerShownGone(
  docker: DockerCall,
  name: string,
  until: number,
  opts: { readonly attempts?: number; readonly intervalMs?: number; readonly clock?: TeardownClock } = {},
): Promise<string | undefined> {
  const attempts = opts.attempts ?? 20;
  const intervalMs = opts.intervalMs ?? 250;
  const clock = opts.clock ?? REAL_CLOCK;
  const left = (): number => until - clock.now();
  let last = 'no time was left to try';
  const calls = new DockerCallTimeline();
  const call = async (args: readonly string[]): Promise<DockerResult> => {
    const r = await docker(args, { timeoutMs: left() });
    calls.add(args, r);
    return r;
  };
  for (let i = 0; i < attempts && left() > 0; i++) {
    if (i > 0) await clock.sleep(Math.min(intervalMs, left()));
    if (left() <= 0) break;
    const rm = await call(['rm', '-f', name]);
    if (left() <= 0) {
      last = rm.code === 0 ? 'docker rm returned at the bound, leaving no time to show it gone'
        : `docker rm did not finish within the bound: ${brief(rm)}`;
      break;
    }
    const shown = await call(['inspect', '--type', 'container', '--format', '{{.Id}}', name]);
    if (shown.code !== 0 && NO_SUCH_CONTAINER.test(shown.stderr)) return undefined;
    last = shown.code === 0
      ? `docker inspect still shows it${rm.code === 0 ? '' : ` after docker rm failed: ${brief(rm)}`}`
      : `docker inspect failed: ${brief(shown)}`;
  }
  return `container ${name} could not be shown removed in time: ${last}; calls: ${calls}`;
}

export class SandboxTeardownError extends Error {
  constructor(what: string, reason: string) {
    super(`${what} could not be removed — refusing to continue beside it: ${reason}`);
    this.name = 'SandboxTeardownError';
  }
}
