// `asep task execute` runnable entrypoint (composition root). Wires a concrete
// coding provider + git change inspector to the CLI seam in cli.ts and prints
// the result. This is the local/dev wiring: it uses the mock coding provider
// and a null inspector so the command is exercisable end-to-end without a live
// PG/GitHub. A production wire swaps in the Claude adapter + real
// GitChangeInspector against a leased worktree, unchanged above the seam.

import { MockCodingAgentProvider } from '@asep/agent-mock';
import type { GitChangeInspector, GitChangeObservation } from '@asep/ports';
import type { ArtifactRef } from '@asep/contracts';
import { parseArgs, runExecute, formatResult, localDeps, CliUsageError } from './cli.js';

// A local inspector stub for the mock run: the mock provider makes no change,
// so the inspector reports a clean tree. A real deployment injects the trusted
// git inspector that derives these facts from the leased worktree.
class NullGitChangeInspector implements GitChangeInspector {
  async inspect(): Promise<GitChangeObservation> {
    return {
      headSha: '0'.repeat(40),
      changedFiles: [],
      createdRefs: [],
      touchedGitDir: false,
      diff: { artifactId: ('0'.repeat(26) as unknown as ArtifactRef['artifactId']), sha256: '0'.repeat(64), kind: 'git-diff' },
    };
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const deps = localDeps(new MockCodingAgentProvider(), new NullGitChangeInspector());
  const result = await runExecute(args, deps);
  // eslint-disable-next-line no-console
  console.log(formatResult(args.taskId, result));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  if (err instanceof CliUsageError) {
    console.error(err.message);
  } else {
    console.error('asep task execute failed:', err);
  }
  process.exitCode = 1;
});
