// Secret patterns, kept in lockstep with scripts/lib/secret-patterns.sh (the single
// source the repository scanners use). A parity test compares the two lists, so a
// pattern added there and not here turns the gate red.

export interface SecretPattern {
  /** POSIX ERE exactly as written in scripts/lib/secret-patterns.sh; also valid JavaScript. */
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
  { pattern: 'sk-ant-[A-Za-z0-9-]{20,}', label: 'Anthropic-style key' },
  { pattern: 'sk-[A-Za-z0-9]{20,}', label: 'OpenAI-style secret key' },
  { pattern: 'AIza[0-9A-Za-z_-]{35}', label: 'Google API key' },
  { pattern: 'eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}', label: 'JSON web token' },
  { pattern: 'glpat-[A-Za-z0-9_-]{20}', label: 'GitLab token' },
]);

const COMPILED: readonly RegExp[] = SECRET_PATTERNS.map((p) => new RegExp(p.pattern, 'g'));

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
