import test from 'node:test';
import assert from 'node:assert/strict';
import { validate } from '@asep/contracts';
import { generateEvidenceBundle, type EvidenceInput } from './evidence.js';

const base: EvidenceInput = {
  taskId: 'task-1',
  attemptId: 'attempt-1',
  baseSha: '0000000000000000000000000000000000000000',
  resultSha: '1111111111111111111111111111111111111111',
  createdAt: '2026-07-14T00:00:00Z',
  environment: { imageDigest: 'sha256:img', lockfileHash: 'sha256:lock', nodeVersion: '24.6.0' },
  diff: { artifactId: 'artifact-diff', sha256: 'sha256:diff' },
  checks: [
    {
      id: 'typecheck',
      category: 'static',
      command: 'pnpm typecheck',
      exitCode: 0,
      durationMs: 1200,
      stdoutArtifactId: 'artifact-out',
      stderrArtifactId: 'artifact-err',
    },
  ],
};

test('generated bundle validates against the EvidenceBundle schema (E5)', () => {
  const bundle = generateEvidenceBundle(base);
  const result = validate('evidence-bundle', bundle);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test('generator references raw output by artifact id, never embeds it', () => {
  const bundle = generateEvidenceBundle(base);
  // The bundle must carry artifact ids, not raw stdout/stderr text.
  const check = bundle.checks[0]!;
  assert.equal(check.stdoutArtifactId, 'artifact-out');
  assert.equal(check.stderrArtifactId, 'artifact-err');
  // No raw-output field exists on the check shape.
  assert.ok(!('stdout' in check));
  assert.ok(!('stderr' in check));
});

test('a bundle with a bad exitCode type is rejected by assertValid (drift guard)', () => {
  assert.throws(() =>
    generateEvidenceBundle({
      ...base,
      checks: [
        {
          ...base.checks[0]!,
          // @ts-expect-error intentionally wrong type to prove validation bites
          exitCode: 'zero',
        },
      ],
    }),
  );
});

test('optional nodeVersion is omitted cleanly when absent', () => {
  const noNode: EvidenceInput = {
    ...base,
    environment: { imageDigest: 'sha256:img', lockfileHash: 'sha256:lock' },
  };
  const bundle = generateEvidenceBundle(noNode);
  assert.equal(validate('evidence-bundle', bundle).valid, true);
  assert.ok(!('nodeVersion' in bundle.environment));
});
