import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ANNOTATIONS_FILE,
  EXCLUSION_ORDER,
  MANIFEST_FILE,
  MAPPING_DIR,
  freezeCorpus,
  isLeakagePath,
  mappingSection,
  priorText,
  treeInputs,
  type FreezeInputs,
  type ManifestBody,
} from './freeze.js';
import type { CorpusItem } from './collect.js';

console.log('SUITE-ID: asep-suite:review-corpus');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const utf8 = (text: string) => new TextEncoder().encode(text);

/** Canonical JSON as the manifest defines it, stated independently: keys sorted, no whitespace. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
}

function committedManifest(): { bytes: Uint8Array; body: ManifestBody; corpusSha256: string } {
  const bytes = new Uint8Array(readFileSync(join(ROOT, MANIFEST_FILE)));
  const { corpusSha256, ...body } = JSON.parse(new TextDecoder().decode(bytes)) as ManifestBody & { corpusSha256: string };
  return { bytes, body, corpusSha256 };
}

test('a second freeze of the same tree is byte-identical and equals the committed manifest', () => {
  const first = freezeCorpus(treeInputs(ROOT));
  const second = freezeCorpus(treeInputs(ROOT));
  assert.deepEqual(second.bytes, first.bytes);
  assert.equal(second.corpusSha256, first.corpusSha256);

  // What is committed is what the freeze writes, the stored diff sections included.
  const committed = committedManifest();
  assert.deepEqual(first.bytes, committed.bytes);
  assert.equal(committed.corpusSha256, first.corpusSha256);
  assert.deepEqual(readdirSync(join(ROOT, MAPPING_DIR)).sort(), [...first.mappingBlobs.keys()].sort());
  for (const [sha, bytes] of first.mappingBlobs) assert.deepEqual(new Uint8Array(readFileSync(join(ROOT, MAPPING_DIR, sha))), bytes, sha);

  // The digest is the sha256 of the body's canonical JSON, and it covers every input.
  assert.equal(committed.corpusSha256, sha256(canonical(committed.body)));
  const inputs = treeInputs(ROOT);
  const [name, bytes] = [...inputs.itemFiles].find(([n]) => n.startsWith('P2-FINAL-HIGH-003@2e61f24'))!;
  const edited: FreezeInputs = { ...inputs, itemFiles: new Map([...inputs.itemFiles, [name, utf8(`${new TextDecoder().decode(bytes)} `)]]) };
  assert.notEqual(freezeCorpus(edited).corpusSha256, first.corpusSha256, 'an item byte');
  const reannotated: FreezeInputs = { ...inputs, annotationsBytes: utf8(`${new TextDecoder().decode(inputs.annotationsBytes)} `) };
  assert.notEqual(freezeCorpus(reannotated).corpusSha256, first.corpusSha256, 'an annotation byte');
});

test('the committed manifest is a provenance-stage freeze that nothing binds to', () => {
  const { body, corpusSha256 } = committedManifest();
  assert.equal(body.stage, 'provenance');
  assert.equal(
    body.stageNote,
    'A provenance-stage freeze. The final freeze (packet eligibility with not-in-packet and egress-stopped, the full packet sources, the packet-dependent synthetic fields and the final corpusSha256) is made once the evals package is bound to the runtime packet code. Nothing may bind to this corpusSha256.',
  );
  // No tracked file but the manifest names its digest: no preregistration or fixture binds to it.
  const named = spawnSync('git', ['grep', '-l', '-F', corpusSha256], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(named.status, 0);
  assert.deepEqual(named.stdout.trim().split('\n'), [MANIFEST_FILE]);
});

test('an item without a fix commit is used for its residual status only', () => {
  const { body } = committedManifest();
  const inputs = treeInputs(ROOT);
  const itemOf = (id: string) => JSON.parse(new TextDecoder().decode(inputs.itemFiles.get(`${id}.json`)!)) as CorpusItem;

  // Each included item's uses, by the protocol's rules stated here: rule P scores a first occurrence, rule C a
  // residual's status, and an item resolved at the next re-review with a known post-fix tree is also a negative.
  for (const entry of body.items) {
    const item = itemOf(entry.id);
    if (entry.excluded !== null) {
      assert.equal(entry.uses, null, entry.id);
      continue;
    }
    const negative = item.confirmation?.status === 'RESOLVED' && item.postFixSha !== null;
    assert.deepEqual(entry.uses, [item.instanceKind === 'first-occurrence' ? 'rediscovery' : 'residual-status', ...(negative ? ['post-fix-negative'] : [])], entry.id);
  }

  // Seven included items name no fix commit (the review counted 15; the eight after Phase 2 re-review v4 have no
  // rule C repair base and are excluded). Each is a residual used for its status only.
  const without = body.items.filter((i) => i.excluded === null && itemOf(i.id).fixCommits.length === 0);
  assert.equal(without.length, 7);
  for (const entry of without) assert.deepEqual([entry.instanceKind, entry.uses, entry.mapping], ['residual', ['residual-status'], null], entry.id);

  // Fix commits never decide a use: without any fix commit, every item keeps its uses.
  const stripped: FreezeInputs = {
    ...inputs,
    itemFiles: new Map(
      [...inputs.itemFiles].map(([name, bytes]) => [name, utf8(JSON.stringify({ ...(JSON.parse(new TextDecoder().decode(bytes)) as CorpusItem), fixCommits: [] }))] as const),
    ),
  };
  assert.deepEqual(
    freezeCorpus(stripped).body.items.map((i) => [i.id, i.uses]),
    body.items.map((i) => [i.id, i.uses]),
  );
});

test('every included item carries the synthetic fields its provenance determines', () => {
  const { body } = committedManifest();
  const entry = (id: string) => body.items.find((i) => i.id === id)!;
  const [B, R1, R2] = ['e046885ad9f800f8d0c7a1fee965f9e670baee96', '2e61f2447f6812f9ed795a5195a25861ada1c50b', '061ec236dacb985c77afa29205bf8bc0a185a49e'];
  const objective = (phase: number, title: string) =>
    `Phase ${phase} (${title}) at the reviewed commit. The phase plan, exit criteria and code are part of the change; review the change against them.`;
  const workOrder = (phase: number, title: string) => ({
    objective: objective(phase, title),
    requirementIds: [],
    requirements: [],
    allowedPaths: ['**'],
    forbiddenChanges: [],
    architectureInvariants: [],
    acceptanceCheckIds: [],
  });

  // The fields every packet shares. Ids are reference values computed outside this code base (Python).
  assert.deepEqual(
    { ...body.synthetic, pendingPacketFields: undefined },
    {
      identity: {
        organizationId: { label: 'corpus:org', id: '28RYVJXRSBE47VFTM1VZ39R9HY' },
        projectId: { label: 'corpus:project', id: '0W0462GQ0GRREABGMCXRH0C0D2' },
        repositoryBindingId: { label: 'corpus:binding', id: '69CA9EKP8SJZWA8AJB3VBF6QJP' },
        runId: { label: 'corpus:run', id: '7GYQTFNF1WJ8ER0KAQ83XDXRF9' },
      },
      risk: 'R1',
      workOrders: { '1': workOrder(1, 'Evaluation and contracts'), '2': workOrder(2, 'Single-agent vertical slice') },
      execution: { verdict: 'NOT_RECORDED', environment: null, checks: [] },
      pendingPacketFields: undefined,
    },
  );
  // Only the fields that need the runtime packet code; a prior's evidence and required fix come from its label.
  assert.deepEqual(body.synthetic.pendingPacketFields, [
    'identity.attemptId and roundKey: the chunk id of each packet',
    'priorFindings: the chunk filter on the prior candidates (a prior is shown when its file is in the chunk)',
    'priorFindings[].fingerprint: the runtime finding code',
    'the masks applied to each packet part',
    'the packet sources: chunk diffs, repair-delta sections and post-images',
  ]);

  // A first occurrence: rule P, a fresh review of its reviewed tree, and its post-fix negative.
  assert.deepEqual(entry('P2-FINAL-HIGH-003@2e61f24').synthetic, {
    rule: 'P',
    cycle: 'p2-final',
    taskId: { label: 'corpus:task:p2-final', id: '0E64H7H23NFT2605AYZM46V86H' },
    round: 1,
    reviewKind: 'fresh',
    taskBaseSha: B,
    resultSha: R1,
    repairBaseSha: null,
    repairDelta: null,
    priorCandidates: [],
    negative: { taskBaseSha: B, resultSha: R2 },
  });

  // A residual: rule C, a re-review of round 2 on the previous cycle's tree, every included item labelled there a
  // prior candidate (the 14 first occurrences of the final review; P2-FINAL-MED-005 there is excluded).
  const residual = entry('P2-FINAL-HIGH-005@061ec23').synthetic!;
  assert.deepEqual(residual, {
    rule: 'C',
    cycle: 'p2-rereview-2',
    taskId: { label: 'corpus:task:p2-rereview-2', id: '68CW73FPC9QGCZ2Z12HSPHG18R' },
    round: 2,
    reviewKind: 're-review',
    taskBaseSha: B,
    resultSha: R2,
    repairBaseSha: R1,
    repairDelta: { from: R1, to: R2 },
    priorCandidates: [
      ...['HIGH-001', 'HIGH-002', 'HIGH-003', 'HIGH-004', 'HIGH-005', 'HIGH-006', 'HIGH-007', 'HIGH-008', 'HIGH-009'],
      ...['MED-001', 'MED-002', 'MED-003', 'MED-004', 'MED-006'],
    ].map((s) => `P2-FINAL-${s}@2e61f24`),
    negative: null,
  });
  // The prior's record, stored once for every residual that shows it; its evidence and required fix are pinned in
  // their own test.
  const { evidence, requiredFix, ...record } = body.priorCandidates['P2-FINAL-HIGH-003@2e61f24']!;
  assert.ok(evidence !== '' && requiredFix !== '');
  assert.deepEqual(record, {
    itemId: 'P2-FINAL-HIGH-003@2e61f24',
    id: '32MW0CQNND1C648HZZEEZ4SCXG',
    source: 'model',
    raisedBy: 'labeller:codex-gpt-5.6-sol',
    severity: 'HIGH',
    category: 'CORRECTNESS',
    file: 'apps/control-plane-api/src/vertical-integration.test.ts',
    lineStart: 183,
    lineEnd: 199,
    grounded: true,
    lifecycleState: 'OPEN',
  });

  // Every included item: the rule follows the instance kind; an excluded item has no record.
  const inputs = treeInputs(ROOT);
  for (const e of body.items) {
    if (e.excluded !== null) {
      assert.equal(e.synthetic, null, e.id);
      continue;
    }
    const item = JSON.parse(new TextDecoder().decode(inputs.itemFiles.get(`${e.id}.json`)!)) as CorpusItem;
    const s = e.synthetic!;
    const ruleC = item.instanceKind === 'residual';
    assert.deepEqual([s.rule, s.round, s.reviewKind], ruleC ? ['C', 2, 're-review'] : ['P', 1, 'fresh'], e.id);
    assert.deepEqual([s.taskBaseSha, s.resultSha], [item.baseSha, item.reviewedSha], e.id);
    assert.equal(s.taskId.label, `corpus:task:${s.cycle}`, e.id);
    assert.equal(s.negative === null, e.mapping === null, e.id);
    // A rule C packet always has its repair base.
    if (ruleC) assert.deepEqual([typeof s.repairBaseSha, s.repairDelta?.to], ['string', item.reviewedSha], e.id);
  }
  assert.deepEqual(
    [body.items.filter((i) => i.synthetic?.rule === 'P').length, body.items.filter((i) => i.synthetic?.rule === 'C').length],
    [17, 20],
  );
});

test("a prior candidate's evidence and required fix come from its label by one fixed rule, masked", () => {
  const { body } = committedManifest();
  const textOf = (residualId: string, priorId: string) => {
    assert.ok(body.items.find((i) => i.id === residualId)!.synthetic!.priorCandidates.includes(priorId), `${residualId} shows ${priorId}`);
    const prior = body.priorCandidates[priorId]!;
    return [prior.evidence, prior.requiredFix];
  };

  // A list label (Phase 2 final review v1, lines 26–35): its `- Sửa: ` line gives the required fix after the marker,
  // every other line the evidence. Written out by hand from the document, the finding-id token replaced by X.
  assert.deepEqual(textOf('P2-FINAL-HIGH-005@061ec23', 'P2-FINAL-HIGH-003@2e61f24'), [
    [
      `- ID: ${'X'.repeat(17)}`,
      '  - Severity: HIGH — Risk admission có thể bị gọi sau khi workspace đã được tạo',
      '  - File:line:',
      '    - `packages/application/src/execute-task.ts:143-148` nhận sẵn `WorkspaceCapability`; use case không sở hữu bước tạo workspace.',
      '    - `packages/application/src/execute-task.ts:160-172` admission chỉ đứng trước agent trong use case rút gọn.',
      '    - `apps/control-plane-api/src/vertical-integration.test.ts:183-199` acquire lease và tạo worktree trước admission.',
      '    - `apps/control-plane-api/src/vertical-integration.test.ts:211-213` admission chỉ chạy sau các side effect đó.',
      '    - `packages/application/src/execute-task.test.ts:113-125` chỉ chứng minh agent không được gọi, không chứng minh workspace/push không xảy ra.',
      '  - Vấn đề: Vi phạm BR1, BR2 và I4: unsupported risk phải dừng trước workspace creation, agent invocation và push.',
    ].join('\n'),
    'Top-level execution use case phải nhận task identity, chạy admission trước mọi lease/workspace; test R0–R4 bằng spy trên workspace, agent và forge.',
  ]);

  // A re-review table row (Phase 2 re-review v2, line 15): the evidence cell, and the note, which says what is still
  // missing, as the required fix; the short id in the note is masked too.
  assert.deepEqual(textOf('P2-FINAL-HIGH-002@594b628', 'P2-FINAL-MED-002@061ec23'), [
    '`adapters/github-app/src/credential-provider.ts:87-93`; `adapters/github-app/src/forge-provider.ts:66-76`; `adapters/github-app/src/forge-provider.ts:191-276`; `adapters/github-app/src/github-app.test.ts:289-370`',
    `Bounded re-mint cho push/PR đã có. Nhưng \`isExpired()\` không được dùng; token vừa mint nhưng đã hết hạn vẫn được đem dùng. Mọi HTTP 403 bị coi là auth expiry, kể cả rate limit/permission. Recovery “không replay completed side effect” còn phụ thuộc ${'X'.repeat(8)} chưa đóng.`,
  ]);

  // A new finding's list label (Phase 2 re-review v2, lines 31–35), with its blank line kept and the trailing one dropped.
  assert.deepEqual(textOf('P2-FINAL-HIGH-002@594b628', 'P2-REREVIEW-MED-NEW-001@061ec23'), [
    [
      `- \`${'X'.repeat(23)}\` — MinIO là backend liveness-only, chưa được dùng bởi artifact path.`,
      '',
      '  - Bằng chứng: `scripts/integration/run-integration.mjs:158-179` chỉ health-check và truyền `ASEP_S3_*`; không file test/runtime nào đọc các biến này. `adapters/persistence/src/object-store.ts:31-44` chỉ có `ObjectStore` seam và `FilesystemObjectStore`; K1 cũng dùng filesystem tại `vertical-slice.ts:249-253`.',
      '  - Hệ quả: gate vẫn xanh nếu MinIO health endpoint hoạt động nhưng PUT/GET/create-only/checksum semantics hỏng.',
    ].join('\n'),
    'thêm S3-compatible `ObjectStore`, chạy artifact/evidence contract suite trực tiếp trên MinIO và register marker bắt buộc.',
  ]);

  // The 20 rule C items show 26 distinct priors in 260 references; each record is stored once, has both texts, and no
  // finding-id token survives in either.
  const findingId = /\bP[0-9]+-[A-Z0-9]+(?:-[A-Z0-9]+)*-[0-9]{3}\b|\b(?:CRIT|CRITICAL|HIGH|MED|MEDIUM|LOW)-[0-9]{3}\b/;
  const references = body.items.flatMap((i) => i.synthetic?.priorCandidates ?? []);
  assert.equal(references.length, 260);
  assert.deepEqual([...new Set(references)].sort(), Object.keys(body.priorCandidates).sort());
  assert.equal(Object.keys(body.priorCandidates).length, 26);
  for (const [id, p] of Object.entries(body.priorCandidates)) {
    assert.equal(p.itemId, id);
    for (const text of [p.evidence, p.requiredFix]) {
      assert.notEqual(text.trim(), '', id);
      assert.doesNotMatch(text, findingId, id);
    }
  }

  // Any other shape is refused: no required-fix line, two of them, a fix that runs on, a row without four cells.
  for (const [label, text] of [
    ['no fix', '- ID: A\n  - Vấn đề: x'],
    ['two fixes', '- ID: A\n  - Sửa: x\n  - Sửa: y'],
    ['a fix over two lines', '- ID: A\n  - Sửa: x\n    y'],
    ['three cells', '| A | PARTIAL | e |'],
    ['five cells', '| A | PARTIAL | e | n | m |'],
  ] as const) {
    assert.throws(() => priorText(text, 'A'), /review-corpus freeze/, label);
  }
  assert.deepEqual(priorText('- ID: A\n  - Sửa: x', 'A'), { evidence: '- ID: A', requiredFix: 'x' });
  assert.deepEqual(priorText('| A | PARTIAL | e | n |', 'A'), { evidence: 'e', requiredFix: 'n' });
  assert.deepEqual(priorText('| A | PARTIAL | see HIGH-001 | fix P2-FINAL-MED-002 |', 'A'), { evidence: `see ${'X'.repeat(8)}`, requiredFix: `fix ${'X'.repeat(16)}` });
});

test('a residual whose re-reviewed cycle has an unknown tree is excluded, on its own line', () => {
  const { body } = committedManifest();
  const inputs = treeInputs(ROOT);
  const itemOf = (id: string) => JSON.parse(new TextDecoder().decode(inputs.itemFiles.get(`${id}.json`)!)) as CorpusItem;

  // Rule C re-reviews a residual against the cycle before its own. The first Phase 1 final review (cycle 1) and Phase 2
  // re-review v4 (cycle 4) have no known tree, so the residuals labelled at the cycles after them, listed here from
  // the review documents, have no repair base. Rule 2 comes before `no-location` and `leakage-filtered`, so it
  // excludes the six of them that cite no location and the one that cites only the phase report too.
  const noRepairBase = [
    ...['CRIT-001', 'HIGH-001', 'HIGH-002', 'HIGH-003', 'MED-001', 'MED-002', 'MED-003'].map((s) => `P1-FINAL-${s}@7dea09c`),
    ...['HIGH-002', 'HIGH-005', 'HIGH-006', 'HIGH-008', 'HIGH-009', 'MED-003', 'MED-004', 'MED-005', 'MED-006'].map((s) => `P2-FINAL-${s}@bb11d00`),
  ];
  for (const id of noRepairBase) {
    const entry = body.items.find((i) => i.id === id)!;
    assert.deepEqual(
      [entry.instanceKind, entry.excluded, entry.uses, entry.synthetic],
      ['residual', { reason: 'reviewed-tree-unknown', level: 'provenance' }, null, null],
      id,
    );
  }

  // Exactly these are excluded for an unknown tree although their own tree is known, and they have their own line.
  const ownTreeKnown = body.items.filter((i) => i.excluded?.reason === 'reviewed-tree-unknown' && itemOf(i.id).reviewedSha !== null);
  assert.deepEqual(ownTreeKnown.map((i) => i.id).sort(), [...noRepairBase].sort());
  assert.equal(body.counts.excludedRepairBaseUnknown, 16);
  assert.equal(body.counts.excluded['reviewed-tree-unknown'], 19 + 16);

  // The residuals of the other cycles keep their repair base.
  assert.equal(body.items.find((i) => i.id === 'P2-FINAL-HIGH-005@061ec23')!.excluded, null);
});

test('the freeze rules apply in order and every exclusion is counted', () => {
  const { body } = committedManifest();
  const reason = (id: string) => body.items.find((i) => i.id === id)!.excluded?.reason ?? null;

  // Counts tallied from the collected items outside the freeze code.
  assert.deepEqual(body.counts.excluded, { 'leakage-filtered': 2, 'no-location': 10, 'plan-defect': 69, 'reviewed-tree-unknown': 35 });
  assert.equal(body.counts.excludedRepairBaseUnknown, 16);
  assert.equal(body.counts.items, 153);
  assert.equal(body.counts.included, 37);
  assert.deepEqual(body.counts.noLocationByPhase, { '1': 9, '2': 1 });
  assert.deepEqual(body.counts.includedBySet, { 'prompt-development': 1, reporting: 36 });
  assert.deepEqual(body.counts.includedByInstanceKind, { 'first-occurrence': 17, residual: 20 });
  assert.equal(body.counts.includedPrivateBundleOnly, 0);
  assert.equal(body.counts.includedDependsOnPrivateBundle, 4);
  assert.equal(body.counts.negativeCandidates, 8);

  // The first rule that applies wins: a plan label, an unknown tree or repair base, no location, then the leakage filter.
  assert.equal(reason('P1-ARCH-001@unknown'), 'plan-defect');
  assert.equal(reason('P2-FINAL-HIGH-005@unknown'), 'reviewed-tree-unknown', 'an unknown tree, though it cites no location');
  assert.equal(reason('P1-FINAL-CRIT-001@7dea09c'), 'reviewed-tree-unknown', 'an unknown repair base, though it cites no location');
  assert.equal(reason('P2-FINAL-MED-005@bb11d00'), 'reviewed-tree-unknown', 'an unknown repair base, though it cites only the phase report');
  assert.equal(reason('P2-CYCLE6-HIGH-001@ebaf519'), 'no-location');
  assert.equal(reason('P2-FINAL-MED-005@2e61f24'), 'leakage-filtered', 'it cites only the phase report');
  assert.equal(reason('P2-FINAL-MED-005@594b628'), null, 'it also cites the exit criteria');
  assert.equal(reason('P2-FINAL-HIGH-003@2e61f24'), null);

  // Every reason is in the protocol's order; the packet plan's two rules are named, never counted.
  for (const item of body.items) if (item.excluded !== null) assert.ok(EXCLUSION_ORDER.includes(item.excluded.reason), item.id);
  assert.deepEqual(body.protocol.appliedByPacketPlan, ['not-in-packet', 'egress-stopped']);
  assert.deepEqual(body.items.filter((i) => i.excluded !== null && body.protocol.appliedByPacketPlan.includes(i.excluded.reason)), []);
  assert.equal(
    Object.values(body.counts.excluded).reduce((n, v) => n + v, 0) + body.counts.included,
    body.counts.items,
  );

  // Gold annotations exist exactly for the included items; excluded items carry none.
  for (const item of body.items) {
    const annotated = item.goldCategory !== null && item.goldCategoryRationale !== null && item.defectClass !== null;
    assert.equal(annotated, item.excluded === null, item.id);
  }
});

test('the leakage filter removes the protocol paths only', () => {
  const removed = [
    'docs/implementation/phases/phase-02-final-review-codex-v1.md',
    'docs/implementation/phases/phase-02-report.md',
    'artifacts/phase-02/run.json',
    'build.log',
    'logs/nested/run.log',
  ];
  const kept = [
    'docs/implementation/phases/phase-02-exit-criteria.md',
    'docs/implementation/phases/sub/phase-02-report.md',
    'docs/implementation/review-notes.md',
    'packages/artifacts/index.ts',
    'build.log.ts',
    'docs/implementation/phases/phase-02-report.mdx',
  ];
  for (const path of removed) assert.equal(isLeakagePath(path), true, path);
  for (const path of kept) assert.equal(isLeakagePath(path), false, path);
});

test('a diff section follows a rename and a deletion, and an unnamed file is unchanged', () => {
  const diff = utf8(
    [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1111111..2222222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,2 +1,3 @@',
      ' one',
      '+two',
      ' three',
      'diff --git a/src/old.ts b/src/new.ts',
      'similarity index 90%',
      'rename from src/old.ts',
      'rename to src/new.ts',
      'diff --git a/src/gone.ts b/src/gone.ts',
      'deleted file mode 100644',
      'index 3333333..0000000',
      '--- a/src/gone.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-x',
      '',
    ].join('\n'),
  );
  const a = mappingSection(diff, 'src/a.ts');
  assert.equal(a.newPath, 'src/a.ts');
  assert.equal(new TextDecoder().decode(a.bytes!), 'diff --git a/src/a.ts b/src/a.ts\nindex 1111111..2222222 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,3 @@\n one\n+two\n three\n');
  assert.equal(mappingSection(diff, 'src/old.ts').newPath, 'src/new.ts');
  assert.equal(mappingSection(diff, 'src/new.ts').bytes, null, 'a rename is found by its old path only');
  assert.equal(mappingSection(diff, 'src/gone.ts').newPath, null);
  assert.deepEqual(mappingSection(diff, 'src/other.ts'), { path: 'src/other.ts', newPath: 'src/other.ts', bytes: null });
  // A byte that is not UTF-8 comes back unchanged.
  const raw = new Uint8Array([...utf8('diff --git a/b.bin b/b.bin\n--- a/b.bin\n+++ b/b.bin\n@@ -1 +1 @@\n-'), 0xff, 0x0a]);
  assert.deepEqual(mappingSection(raw, 'b.bin').bytes, raw);
});

test('the freeze refuses annotations that do not cover exactly the included findings', () => {
  const inputs = treeInputs(ROOT);
  const annotations = JSON.parse(readFileSync(join(ROOT, ANNOTATIONS_FILE), 'utf8')) as { findings: Record<string, Record<string, string>> };
  const withFindings = (findings: Record<string, unknown>): FreezeInputs => ({ ...inputs, annotationsBytes: utf8(JSON.stringify({ ...annotations, findings })) });
  const { ['P2-FINAL-HIGH-003']: golden, ...others } = annotations.findings;
  const cases: readonly (readonly [string, Record<string, unknown>])[] = [
    ['an included finding without an annotation', others],
    ['an annotation without an included finding', { ...annotations.findings, 'P2-FINAL-MED-999': golden }],
    ['a category outside the table', { ...annotations.findings, 'P2-FINAL-HIGH-003': { ...golden, goldCategory: 'STYLE' } }],
    ['an unknown defect class', { ...annotations.findings, 'P2-FINAL-HIGH-003': { ...golden, defectClass: 'docs' } }],
    ['a rationale of two lines', { ...annotations.findings, 'P2-FINAL-HIGH-003': { ...golden, rationale: 'one\ntwo' } }],
    ['an empty rationale', { ...annotations.findings, 'P2-FINAL-HIGH-003': { ...golden, rationale: '' } }],
    ['an extra key', { ...annotations.findings, 'P2-FINAL-HIGH-003': { ...golden, model: 'x' } }],
  ];
  for (const [label, findings] of cases) assert.throws(() => freezeCorpus(withFindings(findings)), /review-corpus freeze/, label);
});

test('a diff section that fails a publication gate is withheld, never stored', () => {
  const inputs = treeInputs(ROOT);
  const clean = freezeCorpus(inputs);
  const [blocked] = [...clean.mappingBlobs.keys()].sort();
  const failing: FreezeInputs = { ...inputs, gates: () => new Map([[blocked!, ['secret-scan']]]) };
  const frozen = freezeCorpus(failing);
  assert.equal(frozen.mappingBlobs.has(blocked!), false);
  const entries = frozen.body.items.flatMap((i) => i.mapping ?? []).filter((m) => m.withheldGates.length > 0);
  assert.ok(entries.length > 0);
  for (const m of entries) assert.deepEqual([m.diffSha256, m.withheldGates], [null, ['secret-scan']]);
  assert.equal(frozen.body.mappingDiffs.includes(blocked!), false);
});
