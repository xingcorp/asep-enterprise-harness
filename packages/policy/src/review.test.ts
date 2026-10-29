import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { RiskLevel } from '@asep/contracts';
import {
  REVIEW_POLICY_FILE,
  ReviewPolicyError,
  independentReviewRequirement,
  isEgressEnabled,
  isSensitivePath,
  loadReviewPolicy,
  matchesPathGlob,
  parseReviewPolicy,
  resolveModelFamily,
  reviewerIndependence,
  type ReviewPolicy,
} from './review.js';

console.log('SUITE-ID: asep-suite:review-policy');

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const POLICY_PATH = join(REPO_ROOT, 'policies', REVIEW_POLICY_FILE);
const RISKS: readonly RiskLevel[] = ['R0', 'R1', 'R2', 'R3', 'R4'];

function sha256Hex(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The committed policy document as plain data, for building variants. */
function committedDoc(): Record<string, unknown> {
  return parseYaml(readFileSync(POLICY_PATH, 'utf8')) as Record<string, unknown>;
}

function variant(mutate: (doc: Record<string, any>) => void): string {
  const doc = committedDoc() as Record<string, any>;
  mutate(doc);
  return stringifyYaml(doc);
}

function rejects(text: string, pattern: RegExp): void {
  assert.throws(
    () => parseReviewPolicy(text),
    (err: unknown) => err instanceof ReviewPolicyError && pattern.test(err.message),
    `expected a ReviewPolicyError matching ${pattern}`,
  );
}

test('review policy file parses into the typed policy without loss', () => {
  const bytes = readFileSync(POLICY_PATH);
  const policy = loadReviewPolicy();
  const { sha256, ...rest } = policy;
  assert.equal(sha256, sha256Hex(bytes));
  // Every key of the YAML is represented and nothing is invented: the typed policy is the document.
  assert.deepEqual(rest, parseYaml(bytes.toString('utf8')));
  assert.equal(policy.kind, 'ReviewPolicy');
  assert.equal(policy.apiVersion, 'asep.policy/v1');
  // The committed file is the canonical source: loading it twice gives the same policy.
  assert.deepEqual(loadReviewPolicy(), policy);
});

test('independence requires different resolved model families', () => {
  const policy = loadReviewPolicy();

  // Family is resolved by policy from the pinned model id.
  assert.equal(resolveModelFamily(policy, 'gpt-6.1-sol'), 'openai-gpt');
  assert.equal(resolveModelFamily(policy, 'deepseek-v4-pro'), 'deepseek');
  assert.equal(resolveModelFamily(policy, 'claude-opus-5-5'), 'anthropic-claude');
  assert.equal(resolveModelFamily(policy, 'qwen3.8-max'), 'alibaba-qwen');
  assert.equal(resolveModelFamily(policy, 'grok-4.6'), 'xai-grok');
  assert.equal(resolveModelFamily(policy, 'mistral-large'), null);
  assert.equal(resolveModelFamily(policy, ''), null);

  const implementerModel = 'claude-opus-5-5';
  assert.deepEqual(
    reviewerIndependence(policy, { reviewerModel: 'gpt-6.1-sol', implementerModel, primaryModel: null }),
    { eligible: true, family: 'openai-gpt' },
  );
  assert.deepEqual(
    reviewerIndependence(policy, { reviewerModel: 'deepseek-v4-pro', implementerModel, primaryModel: 'gpt-6.1-sol' }),
    { eligible: true, family: 'deepseek' },
  );

  // A reviewer of the implementer's family is not independent.
  assert.deepEqual(
    reviewerIndependence(policy, { reviewerModel: 'claude-sonnet-5-5', implementerModel, primaryModel: null }),
    { eligible: false, reason: 'same-family-as-implementer' },
  );
  // A comparator of the primary's family adds no independent signal.
  assert.deepEqual(
    reviewerIndependence(policy, { reviewerModel: 'gpt-5.6-sol', implementerModel, primaryModel: 'gpt-6.1-sol' }),
    { eligible: false, reason: 'same-family-as-primary' },
  );

  // Unknown families fail closed, whichever side is unknown.
  assert.deepEqual(
    reviewerIndependence(policy, { reviewerModel: 'mistral-large', implementerModel, primaryModel: null }),
    { eligible: false, reason: 'unknown-reviewer-family' },
  );
  assert.deepEqual(
    reviewerIndependence(policy, { reviewerModel: 'gpt-6.1-sol', implementerModel: 'mystery-coder', primaryModel: null }),
    { eligible: false, reason: 'unknown-implementer-family' },
  );
  assert.deepEqual(
    reviewerIndependence(policy, { reviewerModel: 'deepseek-v4-pro', implementerModel, primaryModel: 'mystery-primary' }),
    { eligible: false, reason: 'unknown-primary-family' },
  );

  // Longest prefix wins, so a narrower family rule overrides a broader one.
  const narrowed = parseReviewPolicy(
    variant((doc) => {
      doc['modelFamilies'].push({ family: 'openai-gpt-six', prefixes: ['gpt-6'] });
    }),
  );
  assert.equal(resolveModelFamily(narrowed, 'gpt-6.1-sol'), 'openai-gpt-six');
  assert.equal(resolveModelFamily(narrowed, 'gpt-5.6-sol'), 'openai-gpt');

  // The loader refuses configured reviewers that cannot be independent.
  rejects(
    variant((doc) => {
      doc['reviewers'][1]['model'] = 'gpt-5.6-sol';
    }),
    /comparator .* same model family as the primary/,
  );
  rejects(
    variant((doc) => {
      doc['reviewers'][0]['model'] = 'mistral-large';
    }),
    /no known model family/,
  );
  rejects(
    variant((doc) => {
      doc['modelFamilies'].push({ family: 'openai-gpt', prefixes: ['o4-'] });
    }),
    /duplicate model family/,
  );
  rejects(
    variant((doc) => {
      doc['modelFamilies'].push({ family: 'other', prefixes: ['gpt-'] });
    }),
    /prefix "gpt-" is declared twice/,
  );
});

test('committed policy accepts only shadow and not-required modes', () => {
  const policy = loadReviewPolicy();
  for (const risk of RISKS) {
    assert.ok(['not-required', 'shadow', 'deferred'].includes(policy.modes[risk]), `${risk}: ${policy.modes[risk]}`);
  }
  assert.equal(policy.modes.R0, 'not-required');
  assert.equal(policy.modes.R1, 'shadow');

  for (const risk of RISKS) {
    rejects(
      variant((doc) => {
        doc['modes'][risk] = 'gating';
      }),
      /gating is not permitted/,
    );
  }
  rejects(
    variant((doc) => {
      doc['modes']['R1'] = 'blocking';
    }),
    /modes\.R1 must be one of/,
  );
  rejects(
    variant((doc) => {
      delete doc['modes']['R4'];
    }),
    /modes\.R4 is required/,
  );
  // A risk that the approval matrix makes reviewable cannot be declared not-required.
  rejects(
    variant((doc) => {
      doc['modes']['R1'] = 'not-required';
    }),
    /modes\.R1 cannot be not-required/,
  );
});

test('a promoted reviewer satisfies R1 only', () => {
  const policy = loadReviewPolicy();
  const promoted = ['primary-gpt-6.1-sol'];

  assert.deepEqual(independentReviewRequirement(policy, 'R1', promoted), {
    kind: 'promoted-model',
    reviewerConfigIds: ['primary-gpt-6.1-sol'],
  });
  assert.deepEqual(independentReviewRequirement(policy, 'R1', []), { kind: 'human' });
  // Ids that are not configured reviewers do not count as promotion.
  assert.deepEqual(independentReviewRequirement(policy, 'R1', ['not-a-reviewer']), { kind: 'human' });
  assert.deepEqual(independentReviewRequirement(policy, 'R0', promoted), { kind: 'not-required' });
  for (const risk of ['R2', 'R3', 'R4'] as const) {
    assert.deepEqual(independentReviewRequirement(policy, risk, promoted), { kind: 'deferred' }, risk);
    assert.deepEqual(independentReviewRequirement(policy, risk, []), { kind: 'deferred' }, risk);
  }

  // A human always satisfies independent review, so every list must keep it.
  rejects(
    variant((doc) => {
      doc['independentReviewSatisfiedBy']['R1'] = ['promoted-model'];
    }),
    /independentReviewSatisfiedBy\.R1 must include human/,
  );
  rejects(
    variant((doc) => {
      doc['independentReviewSatisfiedBy']['R1'] = ['human', 'any-model'];
    }),
    /independentReviewSatisfiedBy\.R1\[1\] must be one of/,
  );
});

test('approval and verification matrices are unchanged', () => {
  // Digests of these files before the review policy existed; the review policy is additive.
  const pinned: Record<string, string> = {
    'policies/approval-matrix.yaml': 'ac346e68fbd1627d698092b83829a99e454d2d416dec3ff1c2f87a178b9353c4',
    'policies/verification-matrix.yaml': '21f1355c731264f7af629e6a1af83c106394bf1666b192393dff5089ecadd4c2',
    'packages/policy/src/parity.test.ts': 'e79cfcb482d7ab41be11282fc21f42f47681f3859bad73bfd9e5bb56ac4f47c8',
    'packages/policy/src/index.test.ts': '7d29926f1273b844dd5dac4ce42dd66c6eedd82b6f447eba9a30e57eb5cb0ab9',
  };
  for (const [path, digest] of Object.entries(pinned)) {
    assert.equal(sha256Hex(readFileSync(join(REPO_ROOT, path))), digest, path);
  }
});

test('egress classification is policy data and fails closed', () => {
  const policy = loadReviewPolicy();

  // No project is opted in by default, so the reviewer is never called.
  assert.deepEqual(policy.egress.enabledProjects, []);
  assert.equal(isEgressEnabled(policy, 'any-project'), false);
  const optedIn = parseReviewPolicy(
    variant((doc) => {
      doc['egress']['enabledProjects'] = ['project-a'];
    }),
  );
  assert.equal(isEgressEnabled(optedIn, 'project-a'), true);
  assert.equal(isEgressEnabled(optedIn, 'project-b'), false);

  const sensitive = [
    '.env',
    'apps/api/.env.local',
    'certs/server.pem',
    'deploy/tls.key',
    'keystore.p12',
    'keystore.pfx',
    'id_rsa',
    'home/.ssh/id_ed25519.pub',
    'config/secrets/db.yaml',
    'src/aws-credentials.ts',
    '.ENV',
    'Config/Secrets/db.yaml',
  ];
  for (const path of sensitive) assert.equal(isSensitivePath(policy, path), true, path);

  const ordinary = ['src/env.ts', 'docs/environment.md', 'src/keys.ts', 'README.md', 'secrets.md', 'src/pem/reader.ts'];
  for (const path of ordinary) assert.equal(isSensitivePath(policy, path), false, path);

  // Paths that are not normalized repo-relative paths are treated as sensitive.
  for (const path of ['', '/etc/passwd', '../outside.ts', 'a/../../b', 'a\\b.ts', './src/x.ts']) {
    assert.equal(isSensitivePath(policy, path), true, JSON.stringify(path));
  }

  // Glob semantics: `**/` spans zero or more directories, `*` and `?` stay within one segment.
  assert.equal(matchesPathGlob('**/.env', '.env'), true);
  assert.equal(matchesPathGlob('**/.env', 'a/b/.env'), true);
  assert.equal(matchesPathGlob('src/*.ts', 'src/a/b.ts'), false);
  assert.equal(matchesPathGlob('src/?.ts', 'src/a.ts'), true);
  assert.equal(matchesPathGlob('src/?.ts', 'src/ab.ts'), false);
  assert.equal(matchesPathGlob('**/secrets/**', 'secrets/x'), true);
  assert.equal(matchesPathGlob('a.b', 'aXb'), false);
  // Deny lists match case-insensitively; grants can ask for an exact-case match.
  assert.equal(matchesPathGlob('src/**', 'SRC/a.ts'), true);
  assert.equal(matchesPathGlob('src/**', 'SRC/a.ts', { caseSensitive: true }), false);
  assert.equal(matchesPathGlob('src/**', 'src/a.ts', { caseSensitive: true }), true);
});

test('malformed review policy fails closed', () => {
  rejects('', /must be a mapping/);
  rejects('- 1\n- 2\n', /must be a mapping/);
  rejects(
    variant((doc) => {
      doc['kind'] = 'ApprovalMatrix';
    }),
    /kind must be "ReviewPolicy"/,
  );
  rejects(
    variant((doc) => {
      doc['surprise'] = true;
    }),
    /unknown key "surprise"/,
  );
  rejects(
    variant((doc) => {
      doc['reviewers'][0]['apiKey'] = 'placeholder';
    }),
    /reviewers\[0\]: unknown key "apiKey"/,
  );
  rejects(
    variant((doc) => {
      doc['reviewers'][1]['id'] = doc['reviewers'][0]['id'];
    }),
    /duplicate reviewer id/,
  );
  rejects(
    variant((doc) => {
      doc['reviewers'][1]['role'] = 'primary';
    }),
    /exactly one primary reviewer/,
  );
  rejects(
    variant((doc) => {
      doc['reviewers'][0]['providerId'] = 'scripted-fake';
    }),
    /providerId must be "openai-responses"/,
  );
  rejects(
    variant((doc) => {
      doc['reviewers'][0]['maxOutputTokens'] = 0;
    }),
    /maxOutputTokens must be a positive integer/,
  );
  rejects(
    variant((doc) => {
      doc['reviewers'][0]['reasoningEffort'] = 'maximum';
    }),
    /reasoningEffort must be one of/,
  );
  rejects(
    variant((doc) => {
      doc['reviewers'][0]['pricing'] = { inputUsdPerMillionTokens: 1 };
    }),
    /pricing/,
  );
  rejects(
    variant((doc) => {
      delete doc['maxRounds']['R1'];
    }),
    /maxRounds\.R1 is required/,
  );
  rejects(
    variant((doc) => {
      doc['blockingSeverities']['R1'] = ['HIGH', 'SEVERE'];
    }),
    /blockingSeverities\.R1\[1\] must be one of/,
  );
  rejects(
    variant((doc) => {
      doc['repairOrderLimits']['perFieldBytes'] = 100000;
    }),
    /perFieldBytes must not exceed totalBytes/,
  );
  rejects(
    variant((doc) => {
      doc['egress']['denyPathGlobs'] = [];
    }),
    /denyPathGlobs must be a non-empty list/,
  );
  rejects(
    variant((doc) => {
      doc['credential']['maxCredentialAgeMs'] = -1;
    }),
    /maxCredentialAgeMs must be a positive integer/,
  );

  // A well-formed priced reviewer is accepted.
  const priced = parseReviewPolicy(
    variant((doc) => {
      doc['reviewers'][0]['pricing'] = {
        inputUsdPerMillionTokens: 1.25,
        cachedInputUsdPerMillionTokens: 0.125,
        outputUsdPerMillionTokens: 10,
        source: 'https://example.com/pricing',
        asOf: '2026-10-29',
      };
    }),
  );
  assert.equal(priced.reviewers[0]?.pricing?.outputUsdPerMillionTokens, 10);
});

test('loaded policy is immutable', () => {
  const policy: ReviewPolicy = loadReviewPolicy();
  assert.throws(() => {
    (policy.modes as Record<string, string>)['R1'] = 'gating';
  }, TypeError);
  assert.throws(() => {
    (policy.reviewers as unknown as unknown[]).push({});
  }, TypeError);
  assert.equal(loadReviewPolicy().modes.R1, 'shadow');
});
