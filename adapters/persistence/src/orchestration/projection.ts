// The projection writer (migration 0101): tasks, attempts and runs show what
// their workflow decided, and are never a second source of decisions.
//
// A status projection carries the workflow's own monotonic sequence number and
// applies only when it is higher than the row's (an engine retry of an older
// write changes nothing) and only for the row's workflow: a task or run is bound
// to the first workflow that projects it, an attempt belongs to its task's
// workflow, and a write from any other workflow is ProjectionOwnershipError
// whatever its number, because it means two orchestrators. A task or run write
// is one UPDATE; when it changes no row, a read says which of the three cases it
// was. An attempt write binds an unbound task to its workflow first.
//
// Facts that are written once (the attempt's result commit, its evidence) are
// set when empty and must be equal otherwise: the same value again is a no-op,
// another one is ProjectionFactConflictError. These replace the version-checked
// updates an engine retry would trip over.

import type {
  ArtifactRef, AttemptId, AttemptStatus, RunId, RunStatus, TaskId, TaskStatus, TenantScope,
} from '@asep/contracts';
import { ScopeViolationError, type SqlClient } from '../sql.js';
import { isUlid } from '../ulid.js';

export interface ProjectionWrite<S extends string> {
  readonly workflowId: string;
  /** The workflow's own monotonic counter, deterministic on replay; a positive integer. */
  readonly seq: number;
  readonly status: S;
}

export interface ProjectionResult {
  /** False: the row already shows this or a later projection, or already holds this fact. */
  readonly applied: boolean;
}

/** Another workflow projects this row: two orchestrators for one task or run. Not retryable. */
export class ProjectionOwnershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectionOwnershipError';
  }
}

/** A set-once fact already holds another value. Not retryable. */
export class ProjectionFactConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectionFactConflictError';
  }
}

const UNIQUE_VIOLATION = '23505';
const SHA40 = /^[0-9a-f]{40}$/;
const SHA64 = /^[0-9a-f]{64}$/;

function checkWrite(entity: string, id: string, write: ProjectionWrite<string>): void {
  if (typeof id !== 'string' || !isUlid(id)) throw new RangeError(`${entity} projection refused: ${String(id)} is not an id`);
  if (!Number.isSafeInteger(write.seq) || write.seq <= 0) {
    throw new RangeError(`${entity} projection refused: sequence number ${String(write.seq)} is not a positive integer`);
  }
  if (typeof write.workflowId !== 'string' || write.workflowId.length === 0 || write.workflowId.length > 255) {
    throw new RangeError(`${entity} projection refused: the workflow id is empty or too long`);
  }
}

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  if ((err as { code?: unknown }).code === UNIQUE_VIOLATION) return true;
  const message = (err as { message?: unknown }).message;
  return typeof message === 'string' && /(tasks|runs)_workflow_id_uq/.test(message);
}

export class SqlProjectionWriter {
  constructor(private readonly client: SqlClient) {}

  async projectTask(scope: TenantScope, taskId: TaskId, write: ProjectionWrite<TaskStatus>): Promise<ProjectionResult> {
    return this.projectBound('tasks', 'task', scope, taskId, write);
  }

  async projectRun(scope: TenantScope, runId: RunId, write: ProjectionWrite<RunStatus>): Promise<ProjectionResult> {
    return this.projectBound('runs', 'run', scope, runId, write);
  }

  /**
   * An attempt belongs to its task's workflow. A task that no workflow projects yet is bound to the writing workflow
   * first, under a lock on the task row, so two workflows can never both write one attempt.
   */
  async projectAttempt(scope: TenantScope, attemptId: AttemptId, write: ProjectionWrite<AttemptStatus>): Promise<ProjectionResult> {
    checkWrite('attempt', attemptId, write);
    return this.client.transaction(async (tx) => {
      const owner = await tx.query(
        `select t.id as task_id, t.workflow_id from attempts a
           join tasks t on t.id = a.task_id and t.organization_id = a.organization_id and t.project_id = a.project_id
          where a.id = $1 and a.organization_id = $2 and a.project_id = $3
          for update of t`,
        [attemptId, scope.organizationId, scope.projectId],
      );
      if (owner.rowCount === 0) throw new ScopeViolationError('attempt', attemptId);
      const bound = owner.rows[0]!['workflow_id'];
      if (bound === null || bound === undefined) {
        try {
          await tx.query(
            `update tasks set workflow_id = $4, version = version + 1
              where id = $1 and organization_id = $2 and project_id = $3 and workflow_id is null`,
            [owner.rows[0]!['task_id'] as string, scope.organizationId, scope.projectId, write.workflowId],
          );
        } catch (err) {
          if (isUniqueViolation(err)) {
            throw new ProjectionOwnershipError(
              `workflow ${write.workflowId} already projects another task; it cannot project attempt ${attemptId}`,
            );
          }
          throw err;
        }
      } else {
        this.assertOwner('attempt', attemptId, bound, write.workflowId);
      }
      const r = await tx.query(
        `update attempts
            set status = $4, projection_seq = $5, projection_updated_at = now(), version = version + 1
          where id = $1 and organization_id = $2 and project_id = $3 and projection_seq < $5
          returning id`,
        [attemptId, scope.organizationId, scope.projectId, write.status, write.seq],
      );
      return { applied: r.rowCount > 0 };
    });
  }

  /** The attempt's result commit, written once. */
  async setResultSha(scope: TenantScope, attemptId: AttemptId, resultSha: string): Promise<ProjectionResult> {
    if (typeof attemptId !== 'string' || !isUlid(attemptId)) throw new RangeError(`result refused: ${String(attemptId)} is not an id`);
    if (typeof resultSha !== 'string' || !SHA40.test(resultSha)) throw new RangeError('result refused: not a 40-hex commit id');
    const r = await this.client.query(
      `update attempts set result_sha = $4, version = version + 1
        where id = $1 and organization_id = $2 and project_id = $3 and result_sha is null
        returning id`,
      [attemptId, scope.organizationId, scope.projectId, resultSha],
    );
    if (r.rowCount > 0) return { applied: true };
    const now = await this.client.query(
      'select result_sha from attempts where id = $1 and organization_id = $2 and project_id = $3',
      [attemptId, scope.organizationId, scope.projectId],
    );
    if (now.rowCount === 0) throw new ScopeViolationError('attempt', attemptId);
    if (now.rows[0]!['result_sha'] !== resultSha) {
      throw new ProjectionFactConflictError(`attempt ${attemptId} already has another result commit — it is written once`);
    }
    return { applied: false };
  }

  /** The attempt's evidence bundle, attached once; the database binds it to a reservation of this attempt (0018). */
  async attachEvidence(scope: TenantScope, attemptId: AttemptId, evidence: ArtifactRef): Promise<ProjectionResult> {
    if (typeof attemptId !== 'string' || !isUlid(attemptId)) throw new RangeError(`evidence refused: ${String(attemptId)} is not an id`);
    if (typeof evidence?.artifactId !== 'string' || !isUlid(evidence.artifactId) || typeof evidence.sha256 !== 'string'
      || !SHA64.test(evidence.sha256) || evidence.kind !== 'evidence-bundle') {
      throw new RangeError('evidence refused: not an evidence-bundle reference');
    }
    const r = await this.client.query(
      `update attempts set evidence_artifact_id = $4, evidence_sha256 = $5, version = version + 1
        where id = $1 and organization_id = $2 and project_id = $3 and evidence_artifact_id is null
        returning id`,
      [attemptId, scope.organizationId, scope.projectId, evidence.artifactId, evidence.sha256],
    );
    if (r.rowCount > 0) return { applied: true };
    const now = await this.client.query(
      'select evidence_artifact_id, evidence_sha256 from attempts where id = $1 and organization_id = $2 and project_id = $3',
      [attemptId, scope.organizationId, scope.projectId],
    );
    if (now.rowCount === 0) throw new ScopeViolationError('attempt', attemptId);
    const row = now.rows[0]!;
    if (row['evidence_artifact_id'] !== evidence.artifactId || row['evidence_sha256'] !== evidence.sha256) {
      throw new ProjectionFactConflictError(`attempt ${attemptId} already has other evidence attached — it is attached once`);
    }
    return { applied: false };
  }

  /** A task or run: bound once to its workflow, which this write binds when the row has none yet. */
  private async projectBound(
    table: 'tasks' | 'runs',
    entity: string,
    scope: TenantScope,
    id: string,
    write: ProjectionWrite<string>,
  ): Promise<ProjectionResult> {
    checkWrite(entity, id, write);
    let applied: boolean;
    try {
      const r = await this.client.query(
        `update ${table}
            set status = $4, projection_seq = $5, projection_updated_at = now(), workflow_id = $6, version = version + 1
          where id = $1 and organization_id = $2 and project_id = $3
            and (workflow_id is null or workflow_id = $6) and projection_seq < $5
          returning id`,
        [id, scope.organizationId, scope.projectId, write.status, write.seq, write.workflowId],
      );
      applied = r.rowCount > 0;
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ProjectionOwnershipError(`workflow ${write.workflowId} already projects another ${entity}; it cannot project ${entity} ${id}`);
      }
      throw err;
    }
    if (applied) return { applied: true };
    const now = await this.client.query(
      `select workflow_id from ${table} where id = $1 and organization_id = $2 and project_id = $3`,
      [id, scope.organizationId, scope.projectId],
    );
    if (now.rowCount === 0) throw new ScopeViolationError(entity, id);
    this.assertOwner(entity, id, now.rows[0]!['workflow_id'], write.workflowId);
    return { applied: false };
  }

  private assertOwner(entity: string, id: string, owner: unknown, workflowId: string): void {
    if (owner !== null && owner !== undefined && owner !== workflowId) {
      throw new ProjectionOwnershipError(
        `${entity} ${id} is projected by workflow ${String(owner)}; workflow ${workflowId} may not write it (two orchestrators)`,
      );
    }
  }
}
