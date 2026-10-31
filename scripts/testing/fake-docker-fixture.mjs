// Tearing down a test fixture that ran fake docker containers (fake-docker.mjs).
// A container's record in the fixture's docker state is what finds its
// process, so every container still recorded under the fixture is ended — its
// whole process group — and shown gone before the fixture's files are deleted.
// One that cannot be shown gone — it runs on, or the process table cannot tell
// — fails the teardown and leaves the fixture, records and all, in place. What
// it ends leaves the run's process registry too. makeFixtureDir makes one,
// outside the containers' /tmp.

import { readdirSync, realpathSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { endProcess, endRecorded, REGISTRY_ENV, shownGone, unregister } from '../lib/process-registry.mjs';

export { registryShimLine } from '../lib/process-registry.mjs';

// The agent and sandbox containers get a tmpfs on /tmp, and the fake docker, as
// the daemon does, resolves a container's command and paths inside the
// container's mounts. A fixture stands in for the image with host paths — the
// fake CLI is one — so under /tmp the tmpfs hides them and nothing starts.
// os.tmpdir() is /tmp on Linux unless TMPDIR says otherwise; macOS gives a
// directory under /var/folders.
export const CONTAINER_TMPFS = '/tmp';
// Where a fixture goes when the temporary directory lies under /tmp: the
// system's other temporary directory.
export const OUTSIDE_TMPFS = '/var/tmp';

const within = (path, dir) => path === dir || path.startsWith(`${dir}/`);

/** The directory fixtures are made in: `base`, unless it lies at or under CONTAINER_TMPFS. */
export function fixtureTmpdir(base = realpathSync(tmpdir())) {
  return within(base, CONTAINER_TMPFS) ? OUTSIDE_TMPFS : base;
}

/**
 * A new fixture directory, `prefix` and a random suffix, by its real path —
 * which the provider resolves a worktree to — and never under CONTAINER_TMPFS.
 */
export async function makeFixtureDir(prefix, base) {
  const dir = await realpath(await mkdtemp(join(fixtureTmpdir(base), prefix)));
  if (within(dir, CONTAINER_TMPFS)) {
    await rm(dir, { recursive: true, force: true });
    throw new Error(`fixture ${dir} lies under ${CONTAINER_TMPFS}, where the containers' tmpfs would hide it`);
  }
  return dir;
}

// The fake docker state directories under `dir`, as fixtures lay them out: a
// `docker-state` directory at most three levels down, outside any git
// repository. A directory that cannot be read is not one without them: it
// fails the teardown.
function dockerStates(dir, depth = 3) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw new Error(`${dir} cannot be read (${err.code ?? err.message}), so the fake containers under it cannot be ended`);
  }
  return entries.filter((e) => e.isDirectory()).flatMap((e) => {
    if (e.name === 'docker-state') return [join(dir, e.name)];
    if (depth <= 1 || e.name.endsWith('.git') || e.name === 'node_modules') return [];
    return dockerStates(join(dir, e.name), depth - 1);
  });
}

/**
 * End every fake container recorded under `dir`, then remove `dir`. `end` is
 * how one recorded process is ended (process-registry.mjs, endProcess), and
 * `registry` the run whose records of them go once they are shown gone.
 */
export async function removeFakeDockerFixture(dir, end = endProcess, registry = process.env[REGISTRY_ENV]) {
  const ended = dockerStates(dir).flatMap((state) => endRecorded(join(state, 'containers'), end));
  for (const e of ended) if (shownGone(e.outcome)) unregister(e.pid, registry);
  const left = ended.filter((e) => !shownGone(e.outcome));
  if (left.length > 0) {
    throw new Error(`fake containers not shown gone, so ${dir} is kept: `
      + left.map((e) => `${e.directory !== undefined ? `directory ${e.directory}` : `pid ${e.pid}`}`
        + `${e.name !== undefined ? ` (${e.name})` : ''}: ${e.outcome}${e.why !== undefined ? ` (${e.why})` : ''}`).join(', '));
  }
  await rm(dir, { recursive: true, force: true });
}
