// Tearing down a test fixture that ran fake docker containers (fake-docker.mjs).
// A container's record in the fixture's docker state is what finds its
// process, so every container still recorded under the fixture is ended — its
// whole process group — and shown gone before the fixture's files are deleted.
// One that cannot be shown gone — it runs on, or the process table cannot tell
// — fails the teardown and leaves the fixture, records and all, in place. What
// it ends leaves the run's process registry too.

import { readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { endProcess, endRecorded, REGISTRY_ENV, shownGone, unregister } from '../lib/process-registry.mjs';

export { registryShimLine } from '../lib/process-registry.mjs';

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
