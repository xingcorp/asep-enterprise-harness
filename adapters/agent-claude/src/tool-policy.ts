// Tool policy → Claude CLI tool grant (exit criterion G3).
//
// The harness speaks a small CLOSED vocabulary of capabilities; this file is
// the only place that knows which Claude tools each one means. A word outside
// the vocabulary is refused rather than passed through, so a typo or an
// unvetted capability can never reach the CLI as a tool name it might honour.
//
// The grant is what the CLI is told three ways at once:
//   --tools            the ONLY built-in tools that exist for the session;
//   --allowedTools     those same tools, runnable without a prompt;
//   --disallowedTools  every tool of a denied word, plus the network tools.
// The provider then checks the tool list the CLI reports in system/init against
// `tools`, so a CLI that exposes more than it was granted fails closed.

import type { ToolPolicyProfile } from '@asep/ports';

export const TOOL_VOCABULARY = {
  read: ['Read', 'Glob', 'Grep'],
  write: ['Edit', 'Write'],
  bash: ['Bash'],
  network: ['WebFetch', 'WebSearch'],
} as const satisfies Record<string, readonly string[]>;

export type ToolWord = keyof typeof TOOL_VOCABULARY;

// Denied in every session. The agent's only route out is the model egress
// proxy, which forwards nothing but the model API, so a network tool could only
// fail — and it is not a capability any work order is granted.
const ALWAYS_DENIED: readonly string[] = TOOL_VOCABULARY.network;

export class ToolPolicyError extends Error {
  constructor(reason: string) {
    super(`tool policy refused: ${reason}`);
    this.name = 'ToolPolicyError';
  }
}

export interface ClaudeToolGrant {
  readonly tools: readonly string[];
  readonly disallowed: readonly string[];
}

function isWord(w: string): w is ToolWord {
  return Object.prototype.hasOwnProperty.call(TOOL_VOCABULARY, w);
}

function wordsOf(list: readonly string[], field: string): ToolWord[] {
  return list.map((w) => {
    if (!isWord(w)) {
      throw new ToolPolicyError(
        `${field} names '${w}', which is not in the tool vocabulary (${Object.keys(TOOL_VOCABULARY).join(', ')})`,
      );
    }
    return w;
  });
}

/** Translate a harness tool policy into the exact Claude tool grant. */
export function claudeToolGrant(policy: ToolPolicyProfile): ClaudeToolGrant {
  if (policy.networkProfile !== 'restricted-egress') {
    // The agent cannot work without reaching the model, and quietly granting
    // egress the caller did not ask for would be worse than refusing.
    throw new ToolPolicyError(
      `network profile '${policy.networkProfile}' leaves the agent no route to the model API; ` +
        "the Claude provider runs only under 'restricted-egress' (model API through the egress proxy)",
    );
  }
  const allowed = wordsOf(policy.allowedTools, 'allowedTools');
  const denied = new Set(wordsOf(policy.disallowedTools, 'disallowedTools'));
  if (allowed.includes('network')) {
    throw new ToolPolicyError("'network' cannot be allowed: the egress proxy carries the model API only");
  }
  const tools = [...new Set(allowed.filter((w) => !denied.has(w)).flatMap((w) => TOOL_VOCABULARY[w]))];
  const disallowed = [...new Set([...[...denied].flatMap((w) => TOOL_VOCABULARY[w]), ...ALWAYS_DENIED])];
  return { tools, disallowed };
}
