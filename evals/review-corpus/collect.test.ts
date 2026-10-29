import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BLOBS_DIR,
  CYCLES,
  GitReader,
  ITEMS_DIR,
  PROVENANCE_EXCLUSIONS,
  baseShaAt,
  cycleLabels,
  extractLocations,
  failingExcerpts,
  findingIdForms,
  itemId,
  longFindingId,
  namesFinding,
  severityFromId,
  sha256Hex,
  type CorpusItem,
} from './collect.js';

console.log('SUITE-ID: asep-suite:review-corpus-collect');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function readItems(): CorpusItem[] {
  return readdirSync(join(ROOT, ITEMS_DIR))
    .sort()
    .map((name) => {
      const item = JSON.parse(readFileSync(join(ROOT, ITEMS_DIR, name), 'utf8')) as CorpusItem;
      assert.equal(name, `${item.id}.json`);
      return item;
    });
}

test('collected provenance and excerpts verify against the repository', () => {
  const git = new GitReader(ROOT);
  const items = readItems();
  const docLines = new Map<string, string[]>();
  const lineOf = (doc: string, line: number) => {
    if (!docLines.has(doc)) docLines.set(doc, readFileSync(join(ROOT, doc), 'utf8').split('\n'));
    return docLines.get(doc)![line - 1] ?? '';
  };

  // Every label the documents carry is collected once: each finding, and each status row that
  // does not resolve its finding (a residual instance). Nothing else is collected.
  const expected = new Set<string>();
  const byCycle = new Map(CYCLES.map((c) => [c.key, cycleLabels(c, readFileSync(join(ROOT, c.doc), 'utf8'))]));
  for (const cycle of CYCLES) {
    for (const label of byCycle.get(cycle.key)!) {
      if (label.kind === 'status' && label.status === 'RESOLVED') continue;
      expected.add(`${cycle.doc}:${label.line}:${label.findingId}:${label.status}`);
    }
  }
  assert.deepEqual(new Set(items.map((i) => `${i.provenance.doc}:${i.provenance.line}:${i.findingId}:${i.labelStatus}`)), expected);

  const referenced = new Set<string>();
  for (const item of items) {
    const at = item.id;
    const cycle = CYCLES.find((c) => c.doc === item.provenance.doc && c.cycle === item.cycle && c.phase === item.phase);
    assert.ok(cycle !== undefined, `${at}: no cycle has this document`);
    assert.equal(item.reviewKind, cycle.reviewKind, at);
    assert.equal(item.id, itemId(item.findingId, item.reviewedSha), at);
    assert.equal(item.instanceKind, item.labelStatus === null ? 'first-occurrence' : 'residual', at);

    // The finding id appears on its recorded line; the id's own severity token agrees.
    assert.ok(namesFinding(lineOf(item.provenance.doc, item.provenance.line), item.findingId), `${at}: id not on its line`);
    const token = severityFromId(item.findingId);
    if (token !== null) assert.equal(item.severity, token, at);

    // The reviewed SHA is where its source says it is.
    switch (item.reviewedShaSource) {
      case 'recorded-in-review': {
        const evidence = item.provenance.shaEvidence!;
        const named = lineOf(evidence.doc, evidence.line).match(/[0-9a-f]{7,40}/g) ?? [];
        assert.ok(named.some((h) => item.reviewedSha!.startsWith(h)), `${at}: reviewed SHA not on its evidence line`);
        break;
      }
      case 'derived': {
        assert.equal(item.provenance.shaEvidence, null, at);
        const added = git.addedBy(item.provenance.doc);
        assert.ok(added !== null, `${at}: no commit adds its document`);
        assert.equal(git.parent(added), item.reviewedSha, `${at}: not the parent of ${added}`);
        break;
      }
      case 'derived-from-fix': {
        const evidence = item.provenance.shaEvidence!;
        const fix = /[0-9a-f]{40}/.exec(lineOf(evidence.doc, evidence.line))?.[0];
        assert.ok(fix !== undefined, `${at}: no fix commit on its evidence line`);
        assert.equal(git.parent(fix), item.reviewedSha, `${at}: not the parent of ${fix}`);
        break;
      }
      case 'unknown':
        assert.equal(item.reviewedSha, null, at);
        break;
    }

    // Reachability is what the repository shows. A clone without the local object store cannot
    // hold an object-store-only commit; such an item is excerpt-only.
    const present = item.reviewedSha !== null && git.commit(item.reviewedSha) !== null;
    if (item.reachability === 'reachable') assert.ok(present && git.reachable(item.reviewedSha!), `${at}: not reachable`);
    if (item.reachability === 'object-store-only') {
      assert.ok(!present || !git.reachable(item.reviewedSha!), `${at}: reachable from a ref`);
      assert.equal(item.provenance.excerptOnly, true, at);
    }
    if (item.reachability === 'unavailable') assert.equal(present, false, at);
    if (present) {
      assert.equal(item.baseSha, baseShaAt(git, item.phase, item.reviewedSha!), `${at}: base SHA`);
      assert.equal(item.baseShaSource, item.baseSha === null ? null : 'phase-plan', at);
    }

    // Only provenance-level exclusions, in their order.
    if (item.excluded !== null) assert.ok(PROVENANCE_EXCLUSIONS.includes(item.excluded.reason), `${at}: ${item.excluded.reason}`);
    const treeMissing = item.reachability === 'unavailable' || item.baseSha === null || git.commit(item.baseSha) === null;
    const reason = item.reviewKind === 'plan' ? 'plan-defect' : treeMissing ? 'tree-unavailable' : (item.excluded?.reason ?? null);
    assert.equal(item.excluded?.reason ?? null, reason, `${at}: exclusion`);

    // Excerpts: every byte hashes to its name and, where the tree is present, equals git.
    const cited = new Set(item.locations.map((l) => l.file));
    if (item.excluded !== null) assert.deepEqual([item.excerpts, item.excerptsWithheld], [[], []], at);
    for (const excerpt of item.excerpts) {
      const file = join(ROOT, BLOBS_DIR, excerpt.sha256);
      assert.ok(existsSync(file), `${at}: missing blob ${excerpt.sha256}`);
      const bytes = new Uint8Array(readFileSync(file));
      assert.equal(sha256Hex(bytes), excerpt.sha256, `${at}: blob does not hash to its name`);
      assert.ok(cited.has(excerpt.path), `${at}: excerpt of an uncited file`);
      const side = excerpt.side === 'reviewed' ? item.reviewedSha : item.postFixSha;
      assert.ok(side !== null, `${at}: ${excerpt.side} excerpt without its tree`);
      if (git.commit(side) !== null) assert.deepEqual(git.blob(side, excerpt.path), bytes, `${at}: ${excerpt.path} differs from git`);
      else assert.equal(item.provenance.excerptOnly, true, at);
      referenced.add(excerpt.sha256);
    }
    if (item.excluded === null) {
      const reviewed = new Set([...item.excerpts, ...item.excerptsWithheld].filter((e) => e.side === 'reviewed').map((e) => e.path));
      assert.deepEqual(reviewed, cited, `${at}: every cited file has a reviewed excerpt`);
      assert.deepEqual(item.excerptsWithheld.filter((e) => e.side === 'reviewed'), [], at);
    }

    // Fix commits name the finding and descend from the reviewed tree.
    for (const fix of item.fixCommits) {
      if (git.commit(fix) === null) continue;
      assert.ok(namesFinding(git.subject(fix)!, item.findingId), `${at}: ${fix} does not name the finding`);
      assert.ok(git.isAncestor(item.reviewedSha!, fix), `${at}: ${fix} does not descend from the reviewed tree`);
    }

    // The confirmation is the next re-review's status row for this finding.
    if (item.confirmation !== null && item.confirmation.line !== null) {
      const next = CYCLES.find((c) => c.doc === item.confirmation!.doc)!;
      const row = byCycle.get(next.key)!.find((l) => l.line === item.confirmation!.line)!;
      assert.deepEqual([row.findingId, row.kind, row.status], [item.findingId, 'status', item.confirmation.status], `${at}: confirmation`);
    }
  }

  // No blob is committed that no excerpt uses.
  assert.deepEqual(new Set(readdirSync(join(ROOT, BLOBS_DIR))), referenced);
});

test('labels, locations and finding ids follow the written rules', () => {
  // Path tokens with line ranges; a token that is not a file at the reviewed tree is dropped,
  // and a file cited with lines drops its bare mention.
  const files = new Set(['compose.yaml', 'scripts/verify-all.sh', '.github/workflows/ci.yml']);
  assert.deepEqual(
    extractLocations('`compose.yaml:5`, `compose.yaml:39`; `.github/workflows/ci.yml:65-100,16-45`; scripts/verify-all.sh and compose.yaml; 1.0.0 example.com x.ts:3', (p) => files.has(p)),
    [
      { file: '.github/workflows/ci.yml', lineStart: 16, lineEnd: 45 },
      { file: '.github/workflows/ci.yml', lineStart: 65, lineEnd: 100 },
      { file: 'compose.yaml', lineStart: 5, lineEnd: 5 },
      { file: 'compose.yaml', lineStart: 39, lineEnd: 39 },
      { file: 'scripts/verify-all.sh', lineStart: null, lineEnd: null },
    ],
  );

  // Severity comes from the id's own token; short Phase 2 forms map to their long ids.
  assert.deepEqual(
    ['P1-FINAL-CRIT-001', 'P2-REREVIEW-MED-NEW-001', 'P1-REREVIEW-CRIT-001a', 'P2-PLAN-LOW-001', 'P1-CHANGE-002'].map(severityFromId),
    ['CRITICAL', 'MEDIUM', 'CRITICAL', 'LOW', null],
  );
  assert.deepEqual(['HIGH-007', 'MED-NEW-001', 'P2-FINAL-MED-001'].map(longFindingId), ['P2-FINAL-HIGH-007', 'P2-REREVIEW-MED-NEW-001', 'P2-FINAL-MED-001']);
  assert.deepEqual(findingIdForms('P2-FINAL-HIGH-005'), ['P2-FINAL-HIGH-005', 'HIGH-005']);
  assert.deepEqual(findingIdForms('P1-FINAL-HIGH-001'), ['P1-FINAL-HIGH-001']);

  // Whole-token matching: a prefix, a suffix letter or another family's id is not a match.
  assert.equal(namesFinding('fix(ports): validate refs (HIGH-005)', 'P2-FINAL-HIGH-005'), true);
  assert.equal(namesFinding('feat(agent): isolation (HIGH-002/E8)', 'P2-FINAL-HIGH-002'), true);
  assert.equal(namesFinding('docs: P2-PLAN-HIGH-005 disposition', 'P2-FINAL-HIGH-005'), false);
  assert.equal(namesFinding('fix: HIGH-0051', 'P2-FINAL-HIGH-005'), false);
  assert.equal(namesFinding('fix(phase-1): P1-REREVIEW-CRIT-001a', 'P1-REREVIEW-CRIT-001'), false);
  assert.equal(namesFinding('fix: HIGH-001 again', 'P1-FINAL-HIGH-001'), false);

  // Document formats: a status row is a residual only when it does not resolve its finding.
  const table = CYCLES.find((c) => c.key === 'p2-rereview-3')!;
  const rows = cycleLabels(table, ['| ID | verdict | x | y |', '| HIGH-007 | RESOLVED | `a.ts:1` | ok |', '| MED-NEW-001 | PARTIAL | `b.ts:2-3` | no |'].join('\n'));
  assert.deepEqual(
    rows.map((r) => [r.findingId, r.line, r.kind, r.status]),
    [
      ['P2-FINAL-HIGH-007', 2, 'status', 'RESOLVED'],
      ['P2-REREVIEW-MED-NEW-001', 3, 'status', 'PARTIAL'],
    ],
  );
  const yaml = CYCLES.find((c) => c.key === 'p1-rereview-3')!;
  const entries = cycleLabels(
    yaml,
    [
      'rereview:',
      '  findings_status:',
      '    - id: P1-FINAL-MED-001',
      '      now_closed: partial',
      '    - id: P1-FINAL-MED-002',
      '      now_closed: false',
      '  new_findings:',
      '    - id: P1-CYCLE3-HIGH-001',
      '      severity: HIGH',
      '  remaining_blockers:',
      '    - P1-FINAL-MED-001',
    ].join('\n'),
  );
  assert.deepEqual(
    entries.map((e) => [e.findingId, e.line, e.kind, e.status, e.severity]),
    [
      ['P1-FINAL-MED-001', 3, 'status', 'PARTIAL', null],
      ['P1-FINAL-MED-002', 5, 'status', 'OPEN', null],
      ['P1-CYCLE3-HIGH-001', 8, 'finding', null, 'HIGH'],
    ],
  );
});

test('the publication gates refuse an excerpt that cannot be published', () => {
  // Candidate excerpts, assembled at runtime so no literal secret or private path is committed.
  const encode = (text: string) => new TextEncoder().encode(text);
  const candidates = new Map([
    ['a'.repeat(64), encode(`key = '${'AKIA' + 'Z'.repeat(16)}'\n`)],
    ['b'.repeat(64), encode(`home = ${'/Us' + 'ers/'}someone/workspace\n`)],
    ['c'.repeat(64), encode('no final newline')],
    ['d'.repeat(64), encode('publishable\n')],
  ]);
  const failing = failingExcerpts(ROOT, candidates);
  assert.ok(failing.get('a'.repeat(64))?.includes('secret-scan'));
  assert.ok(failing.get('b'.repeat(64))?.includes('check-publication'));
  assert.ok(failing.get('c'.repeat(64))?.includes('format-check'));
  assert.equal(failing.has('d'.repeat(64)), false);
});
