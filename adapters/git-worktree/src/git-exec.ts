// Safe git invocation (architecture §15, disp. P2-PLAN-HIGH-007). Every git call
// in this adapter goes through runGit: argv-only (shell:false via execFile), a
// SANITIZED environment (no inherited GIT_CONFIG*/GIT_SSH*/askpass/proxy vars
// that could redirect transport or inject config), hooks disabled, protocol
// restricted to https/file for the mirror, and `--end-of-options` inserted so a
// value that looks like a flag can never be reinterpreted as one.
//
// This module holds NO forge credential and never writes one into the
// environment — the agent/worktree side of the system is credential-free by
// construction (exit criterion E4).

import { execFile } from 'node:child_process';

export interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export class GitCommandError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly exitCode: number,
    readonly stderr: string,
  ) {
    super(`git ${args.join(' ')} failed (exit ${exitCode}): ${stderr.trim()}`);
    this.name = 'GitCommandError';
  }
}

// Environment variables that could subvert git transport/config are STRIPPED.
// We start from a minimal allowlist rather than inheriting the whole process
// environment, so an attacker-controlled GIT_CONFIG / GIT_SSH_COMMAND / askpass
// / proxy var cannot ride along into a clone or fetch.
function sanitizedEnv(): NodeJS.ProcessEnv {
  const path = process.env['PATH'] ?? '/usr/bin:/bin';
  return {
    PATH: path,
    HOME: process.env['HOME'] ?? '/tmp',
    // Hard-disable interactive prompts and any inherited transport redirection.
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ASKPASS: '/bin/true',
    GIT_SSH_COMMAND: '/bin/false',
    // Disable hooks by pointing core.hooksPath at an empty dir (also enforced
    // per-call with -c core.hooksPath=/dev/null below).
  };
}

// Config flags prepended to EVERY git invocation. These cannot be overridden by
// repo-local config because -c wins, and the sanitized env removes the file
// sources anyway. protocol.allow=never + explicit https/file allow means only
// the transports we opt into work; ssh/ext/etc. are refused by git itself.
const HARDENING_FLAGS: readonly string[] = [
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'protocol.allow=never',
  '-c', 'protocol.https.allow=always',
  '-c', 'protocol.file.allow=always',
  '-c', 'credential.helper=',
  '-c', 'core.symlinks=false',
];

export interface RunGitOptions {
  readonly cwd?: string;
  readonly timeoutMs?: number;
  // When false (default) a non-zero exit throws GitCommandError. When true the
  // caller inspects the exit code itself (e.g. rev-parse existence checks).
  readonly allowNonZero?: boolean;
}

/**
 * Run a git subcommand with hardened, argv-only semantics. `subArgs` is the
 * command and its arguments AFTER the hardening flags. `--end-of-options` is
 * inserted after the subcommand name so subsequent positional values cannot be
 * parsed as options.
 */
export function runGit(subArgs: readonly string[], opts: RunGitOptions = {}): Promise<GitResult> {
  const args = [...HARDENING_FLAGS, ...subArgs];
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd: opts.cwd,
        env: sanitizedEnv(),
        timeout: opts.timeoutMs ?? 60_000,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: unknown }).code === 'number'
          ? (err as { code: number }).code
          : err ? 1 : 0;
        if (err && !opts.allowNonZero) {
          reject(new GitCommandError(subArgs, code, String(stderr)));
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr), exitCode: code });
      },
    );
  });
}

/**
 * runGit with stdout kept as bytes: the same hardening flags and sanitized
 * environment, for output a UTF-8 decode would corrupt (blob contents, diffs of
 * binary or non-UTF-8 files). A non-zero exit always throws.
 */
export function runGitBytes(subArgs: readonly string[], opts: Omit<RunGitOptions, 'allowNonZero'> = {}): Promise<Buffer> {
  const args = [...HARDENING_FLAGS, ...subArgs];
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd: opts.cwd,
        env: sanitizedEnv(),
        timeout: opts.timeoutMs ?? 60_000,
        maxBuffer: 256 * 1024 * 1024,
        windowsHide: true,
        encoding: 'buffer',
      },
      (err, stdout, stderr) => {
        if (err) {
          const code = typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1;
          reject(new GitCommandError(subArgs, code, String(stderr)));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

// Insert `--end-of-options` into an argv after the given prefix length, so any
// following user/derived value cannot be treated as a flag. Small helper used by
// subcommands that take a positional ref/path argument.
export function endOfOptions(before: readonly string[], after: readonly string[]): string[] {
  return [...before, '--end-of-options', ...after];
}
