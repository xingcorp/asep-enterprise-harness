// Transport-level request-body validation (exit criterion B5: validation is an
// allowed composition-root responsibility; domain/policy decisions are NOT).
// These are structural guards on the JSON a client sends — they never make a
// business decision, run a policy, or touch persistence. A handler calls the
// matching parse* function, gets a typed value or a ValidationFailure, and
// forwards the value to a repository/use case.

export interface ValidationFailure {
  readonly ok: false;
  readonly errors: readonly string[];
}
export interface ValidationOk<T> {
  readonly ok: true;
  readonly value: T;
}
export type Parsed<T> = ValidationOk<T> | ValidationFailure;

function fail(...errors: string[]): ValidationFailure {
  return { ok: false, errors };
}
function ok<T>(value: T): ValidationOk<T> {
  return { ok: true, value };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// A non-empty, bounded, control-char-free string field.
function str(body: Record<string, unknown>, field: string, max = 200): string | null {
  const v = body[field];
  if (typeof v !== 'string') return null;
  if (v.length === 0 || v.length > max) return null;
  if (/[\x00-\x1f\x7f]/.test(v)) return null;
  return v;
}

const RISK = new Set(['R0', 'R1', 'R2', 'R3', 'R4']);
// GitHub identity grammar — mirrors the adapter's stricter-than-GitHub rule so a
// binding cannot smuggle an option-like or path-bearing segment into the store.
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const HOST = /^[A-Za-z0-9]([A-Za-z0-9-]{0,62}\.)+[A-Za-z]{2,63}$/;

export interface CreateOrganizationBody { readonly name: string; }
export function parseCreateOrganization(raw: unknown): Parsed<CreateOrganizationBody> {
  if (!isRecord(raw)) return fail('body must be a JSON object');
  const name = str(raw, 'name');
  if (name === null) return fail('name: required non-empty string (<=200 chars)');
  return ok({ name });
}

export interface CreateProjectBody { readonly name: string; readonly defaultBranch: string; }
export function parseCreateProject(raw: unknown): Parsed<CreateProjectBody> {
  if (!isRecord(raw)) return fail('body must be a JSON object');
  const name = str(raw, 'name');
  const defaultBranch = str(raw, 'defaultBranch', 255);
  const errors: string[] = [];
  if (name === null) errors.push('name: required non-empty string');
  if (defaultBranch === null) errors.push('defaultBranch: required non-empty string');
  if (errors.length) return { ok: false, errors };
  return ok({ name: name!, defaultBranch: defaultBranch! });
}

export interface CreateBindingBody {
  readonly githubHost: string;
  readonly githubOwner: string;
  readonly githubRepo: string;
  readonly defaultBaseBranch: string;
}
export function parseCreateBinding(raw: unknown): Parsed<CreateBindingBody> {
  if (!isRecord(raw)) return fail('body must be a JSON object');
  const errors: string[] = [];
  const host = str(raw, 'githubHost', 253);
  const owner = str(raw, 'githubOwner');
  const repo = str(raw, 'githubRepo');
  const base = str(raw, 'defaultBaseBranch', 255);
  if (host === null || !HOST.test(host)) errors.push('githubHost: valid DNS host required');
  if (owner === null || !SEGMENT.test(owner)) errors.push('githubOwner: valid GitHub owner required');
  if (repo === null || !SEGMENT.test(repo.replace(/\.git$/, ''))) errors.push('githubRepo: valid GitHub repo required');
  if (base === null) errors.push('defaultBaseBranch: required non-empty string');
  if (errors.length) return { ok: false, errors };
  return ok({ githubHost: host!, githubOwner: owner!, githubRepo: repo!, defaultBaseBranch: base! });
}

export interface CreateRunBody { readonly repositoryBindingId: string; readonly risk: string; }
export function parseCreateRun(raw: unknown): Parsed<CreateRunBody> {
  if (!isRecord(raw)) return fail('body must be a JSON object');
  const errors: string[] = [];
  const binding = str(raw, 'repositoryBindingId', 26);
  const risk = raw['risk'];
  if (binding === null || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(binding)) errors.push('repositoryBindingId: ULID required');
  if (typeof risk !== 'string' || !RISK.has(risk)) errors.push('risk: one of R0..R4');
  if (errors.length) return { ok: false, errors };
  return ok({ repositoryBindingId: binding!, risk: risk as string });
}

export interface CreateTaskBody {
  readonly repositoryBindingId: string;
  readonly risk: string;
  readonly baseSha?: string;
}
export function parseCreateTask(raw: unknown): Parsed<CreateTaskBody> {
  if (!isRecord(raw)) return fail('body must be a JSON object');
  const errors: string[] = [];
  const binding = str(raw, 'repositoryBindingId', 26);
  const risk = raw['risk'];
  if (binding === null || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(binding)) errors.push('repositoryBindingId: ULID required');
  if (typeof risk !== 'string' || !RISK.has(risk)) errors.push('risk: one of R0..R4');
  const baseShaRaw = raw['baseSha'];
  let baseSha: string | undefined;
  if (baseShaRaw !== undefined) {
    if (typeof baseShaRaw !== 'string' || !/^[0-9a-f]{40}$/.test(baseShaRaw)) {
      errors.push('baseSha: 40-char hex when present');
    } else {
      baseSha = baseShaRaw;
    }
  }
  if (errors.length) return { ok: false, errors };
  return ok(baseSha === undefined
    ? { repositoryBindingId: binding!, risk: risk as string }
    : { repositoryBindingId: binding!, risk: risk as string, baseSha });
}
