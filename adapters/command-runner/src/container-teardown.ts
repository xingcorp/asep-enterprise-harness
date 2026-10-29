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
}

/** Runs one docker client invocation; never throws. */
export type DockerCall = (args: readonly string[]) => Promise<DockerResult>;

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

/** A bounded docker client call with a fixed environment, shell-free. */
export function dockerCaller(
  binary: string, env: Readonly<Record<string, string>>, timeoutMs = DOCKER_CALL_TIMEOUT_MS,
): DockerCall {
  return (args) => new Promise((resolve) => {
    const child = spawn(binary, [...args], { env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d: Buffer) => { if (stdout.length < MAX_OUTPUT) stdout += d.toString('utf8'); });
    child.stderr.on('data', (d: Buffer) => { if (stderr.length < MAX_OUTPUT) stderr += d.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stdout: '', stderr: e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

// What `docker rm -f` says when the container is already going or gone.
const ALREADY_GONE = /no such container|already in progress/i;

/**
 * Remove every container carrying `label` (`key=value`) and confirm that none
 * is left. Returns undefined once `docker ps -a` lists none, or the reason it
 * could not be shown gone after `attempts` tries.
 */
export async function removeLabelledContainers(
  docker: DockerCall,
  label: string,
  opts: { readonly attempts?: number; readonly intervalMs?: number } = {},
): Promise<string | undefined> {
  const attempts = opts.attempts ?? 20;
  const intervalMs = opts.intervalMs ?? 250;
  let last = 'not checked';
  for (let i = 0; i < attempts; i++) {
    if (i > 1) await new Promise((r) => setTimeout(r, intervalMs));
    const ps = await docker(['ps', '-aq', '--filter', `label=${label}`]);
    if (ps.code !== 0) {
      last = `docker ps failed: ${ps.stderr.trim().slice(0, 200) || `exit ${ps.code}`}`;
      continue;
    }
    const ids = ps.stdout.split(/\s+/).filter((x) => x !== '');
    if (ids.length === 0) return undefined;
    const rm = await docker(['rm', '-f', ...ids]);
    last = rm.code === 0 || ALREADY_GONE.test(rm.stderr)
      ? `${ids.join(', ')} still listed`
      : `docker rm failed: ${rm.stderr.trim().slice(0, 200) || `exit ${rm.code}`}`;
  }
  return `container(s) labelled ${label} could not be shown removed: ${last}`;
}

export class SandboxTeardownError extends Error {
  constructor(what: string, reason: string) {
    super(`${what} could not be removed — refusing to continue beside it: ${reason}`);
    this.name = 'SandboxTeardownError';
  }
}
