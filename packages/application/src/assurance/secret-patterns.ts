// Secret patterns, kept in lockstep with scripts/lib/secret-patterns.sh (the single
// source the repository scanners use). A parity test compares the two lists, so a
// pattern added there and not here turns the gate red.
//
// The `sk-` keys must stand on their own: the shell patterns start with
// `(^|[^A-Za-z0-9_])`, the start of a line or a character that cannot be part of a
// word, so the `sk-` at the tail of every `asep-task-<ULID>` workflow id is no key.
// Here that boundary is read as a lookbehind, so a match starts at the key itself,
// and it also holds after an escaped line break or tab and after a `\uXXXX` escape:
// the packet and the reviewer request carry text as JSON strings, once or twice
// escaped, where a key at the start of a line follows `\n`, never a line start.

export interface SecretPattern {
  /** POSIX ERE exactly as written in scripts/lib/secret-patterns.sh. */
  readonly pattern: string;
  readonly label: string;
}

export const SECRET_PATTERNS: readonly SecretPattern[] = Object.freeze([
  { pattern: 'AKIA[0-9A-Z]{16}', label: 'AWS access key id' },
  { pattern: 'ASIA[0-9A-Z]{16}', label: 'AWS temporary access key id' },
  { pattern: '-----BEGIN [A-Z ]*PRIVATE KEY-----', label: 'PEM private key' },
  { pattern: 'ghp_[A-Za-z0-9]{36}', label: 'GitHub personal token' },
  { pattern: 'gho_[A-Za-z0-9]{36}', label: 'GitHub OAuth token' },
  { pattern: 'github_pat_[A-Za-z0-9_]{22,}', label: 'GitHub fine-grained token' },
  { pattern: 'xox[baprs]-[A-Za-z0-9-]{10,}', label: 'Slack token' },
  { pattern: '(^|[^A-Za-z0-9_])sk-ant-[A-Za-z0-9_-]{20,}', label: 'Anthropic-style key' },
  { pattern: '(^|[^A-Za-z0-9_])sk-[A-Za-z0-9]{20,}', label: 'OpenAI-style secret key' },
  { pattern: 'AIza[0-9A-Za-z_-]{35}', label: 'Google API key' },
  { pattern: 'eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}', label: 'JSON web token' },
  { pattern: 'glpat-[A-Za-z0-9_-]{20}', label: 'GitLab token' },
]);

/** The shell patterns' leading word boundary: the start of a line or one character outside the class. */
const SHELL_BOUNDARY = /^\(\^\|\[\^([^\]]+)\]\)/;

/**
 * The JavaScript form of a shell pattern. A leading `(^|[^C])` becomes a lookbehind that holds where no character
 * of C comes before, or where an escaped line break or tab or a `\uXXXX` escape does; every other pattern is used
 * as written.
 */
export function javascriptPattern(pattern: string): string {
  const boundary = SHELL_BOUNDARY.exec(pattern);
  if (boundary === null) {
    if (pattern.includes('(^|')) throw new Error(`secret patterns: unsupported boundary in ${pattern}`);
    return pattern;
  }
  const word = boundary[1]!;
  return `(?:(?<![${word}])|(?<=\\\\[nrtbf])|(?<=\\\\u[0-9A-Fa-f]{4}))${pattern.slice(boundary[0].length)}`;
}

const COMPILED: readonly RegExp[] = SECRET_PATTERNS.map((p) => new RegExp(javascriptPattern(p.pattern), 'g'));

export interface SecretHit {
  readonly patternIndex: number;
  readonly label: string;
  /** UTF-16 offset of the match; the matched text itself is never returned. */
  readonly offset: number;
}

/** Every secret-pattern match in `text`, ordered by offset then pattern. */
export function findSecrets(text: string): readonly SecretHit[] {
  const hits: SecretHit[] = [];
  COMPILED.forEach((re, patternIndex) => {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      hits.push({ patternIndex, label: SECRET_PATTERNS[patternIndex]!.label, offset: m.index });
    }
  });
  return hits.sort((a, b) => a.offset - b.offset || a.patternIndex - b.patternIndex);
}
