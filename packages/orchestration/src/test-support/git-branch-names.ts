// Branch names with Git's own answer, the oracle for the base-branch input rule (test support, not a test file;
// excluded from the purity scan with the tests).
//
// `git` is the result of `git check-ref-format --branch <name>`, recorded with git 2.55.0 on 2026-10-30 in a directory
// outside any repository (inside one, `--branch` expands `@{-N}` to a previous branch). A test re-runs git on this
// table when git is available, so the record cannot drift from Git unnoticed. The input rule's 255-character bound is
// stricter than Git and is tested on its own, outside this table.

export interface GitBranchName {
  readonly name: string;
  readonly git: 'valid' | 'invalid';
}

export const GIT_BRANCH_NAMES: readonly GitBranchName[] = [
  { name: 'main', git: 'valid' },
  { name: 'release/2026.10', git: 'valid' },
  { name: 'feature/x-y', git: 'valid' },
  { name: 'a.b', git: 'valid' },
  { name: 'v1.0', git: 'valid' },
  { name: 'a/b/c', git: 'valid' },
  { name: 'user@host', git: 'valid' },
  { name: 'refs/heads/x', git: 'valid' },
  { name: 'x/HEAD', git: 'valid' },
  { name: 'head', git: 'valid' },
  { name: 'origin/main', git: 'valid' },
  { name: '@', git: 'valid' },
  { name: 'a@b', git: 'valid' },
  { name: 'a./b', git: 'valid' },
  { name: 'a/-b', git: 'valid' },
  { name: 'x.lockx', git: 'valid' },
  { name: 'a]b', git: 'valid' },
  { name: 'a{b', git: 'valid' },
  { name: 'a}b', git: 'valid' },
  { name: 'é', git: 'valid' },
  { name: '', git: 'invalid' },
  { name: 'HEAD', git: 'invalid' },
  { name: '/main', git: 'invalid' },
  { name: '.hidden', git: 'invalid' },
  { name: 'release/.hidden', git: 'invalid' },
  { name: 'a.lock/b', git: 'invalid' },
  { name: 'a/b.lock/c', git: 'invalid' },
  { name: 'a.lock', git: 'invalid' },
  { name: 'main..evil', git: 'invalid' },
  { name: 'a..b/c', git: 'invalid' },
  { name: '.', git: 'invalid' },
  { name: '..', git: 'invalid' },
  { name: 'a/..', git: 'invalid' },
  { name: 'a/./b', git: 'invalid' },
  { name: 'a/.b', git: 'invalid' },
  { name: 'a//b', git: 'invalid' },
  { name: 'a/', git: 'invalid' },
  { name: 'a.', git: 'invalid' },
  { name: 'release/a.', git: 'invalid' },
  { name: '-', git: 'invalid' },
  { name: '-x', git: 'invalid' },
  { name: 'a b', git: 'invalid' },
  { name: 'a\tb', git: 'invalid' },
  { name: 'a\u0001b', git: 'invalid' },
  { name: 'a\u007fb', git: 'invalid' },
  { name: 'a~b', git: 'invalid' },
  { name: 'a^b', git: 'invalid' },
  { name: 'a:b', git: 'invalid' },
  { name: 'a?b', git: 'invalid' },
  { name: 'a*b', git: 'invalid' },
  { name: 'a[b', git: 'invalid' },
  { name: 'a\\b', git: 'invalid' },
  { name: 'a@{b', git: 'invalid' },
  { name: '@{-1}', git: 'invalid' },
];
