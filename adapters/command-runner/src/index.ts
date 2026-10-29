// @asep/command-runner — trusted sandboxed command + verification runner (S5).
//
// PUBLIC SURFACE. A trusted command runner that executes verification commands
// as argv (shell:false), preserves exact exit/signal, kills the whole process
// group on timeout/cancel, and streams raw output into immutable artifacts
// before returning. Plus two SandboxProviders: a hardened Docker adapter
// (production-parity, fails closed when Docker is absent) and an honest
// no-isolation local fallback labelled pilot-only.

export type { BoundedCaptureResult } from './bounded-capture.js';
export { BoundedCapture, TRUNCATION_MARKER } from './bounded-capture.js';

export {
  ENVIRONMENT_PROFILES, resolveEnvironment, UnknownEnvironmentProfileError,
} from './environment-profiles.js';

export type { CommandRunnerConfig } from './command-runner.js';
export { TrustedCommandRunner } from './command-runner.js';

export type { SandboxHandleEx, DockerSandboxConfig } from './sandbox.js';
export {
  DockerSandboxProvider, LocalUnsandboxedProvider, SandboxUnavailableError,
  buildSandboxRunFlags, isDigestPinned,
} from './sandbox.js';
