import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BLOBS_DIR,
  CYCLES,
  GATE_SCRIPTS,
  GitReader,
  ITEMS_DIR,
  LEAK_PATTERNS_FILE,
  PROVENANCE_EXCLUSIONS,
  baseShaAt,
  cycleLabels,
  extractLocations,
  failingExcerpts,
  findingIdForms,
  itemId,
  longFindingId,
  leakPatterns,
  namesFinding,
  runGateProcess,
  severityFromId,
  sha256Hex,
  type CorpusItem,
  type GateRun,
  type GateRunner,
  type GitExec,
  type PublicationGate,
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

  // The R22 vocabulary, stated independently of the collector.
  assert.deepEqual(PROVENANCE_EXCLUSIONS, ['plan-defect', 'reviewed-tree-unknown', 'excerpt-unpublishable']);
  const SHA_SOURCES = new Set(['recorded-in-review', 'derived', 'inferred-parent-of-fix', 'unknown']);
  const REACHABILITY = new Set(['reachable', 'private-bundle-only', 'unavailable']);
  // A SHA's reachability as this clone shows it; a commit this clone lacks is one only the
  // controller's bundle can still hold.
  const reach = (sha: string | null) =>
    sha === null ? null : git.commit(sha) === null ? 'absent' : git.reachable(sha) ? 'reachable' : 'private-bundle-only';

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
    assert.ok(SHA_SOURCES.has(item.reviewedShaSource), `${at}: ${item.reviewedShaSource}`);
    assert.ok(REACHABILITY.has(item.reachability), `${at}: ${item.reachability}`);
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
      case 'inferred-parent-of-fix': {
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
    // hold a private-bundle-only commit; such an item is excerpt-only.
    const present = item.reviewedSha !== null && git.commit(item.reviewedSha) !== null;
    if (item.reachability === 'reachable') assert.ok(present && git.reachable(item.reviewedSha!), `${at}: not reachable`);
    if (item.reachability === 'private-bundle-only') {
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
    const reason: string | null = item.reviewKind === 'plan' ? 'plan-defect' : treeMissing ? 'reviewed-tree-unknown' : (item.excluded?.reason ?? null);
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

    // Fix commits name the finding, descend from the reviewed tree and carry their reachability.
    for (const fix of item.fixCommits) {
      assert.ok(fix.reachability === 'reachable' || fix.reachability === 'private-bundle-only', `${at}: ${fix.sha} ${fix.reachability}`);
      if (git.commit(fix.sha) === null) {
        assert.equal(fix.reachability, 'private-bundle-only', at);
        continue;
      }
      assert.equal(fix.reachability, reach(fix.sha), `${at}: ${fix.sha} reachability`);
      assert.ok(namesFinding(git.subject(fix.sha), item.findingId), `${at}: ${fix.sha} does not name the finding`);
      assert.ok(git.isAncestor(item.reviewedSha!, fix.sha), `${at}: ${fix.sha} does not descend from the reviewed tree`);
    }

    // The item depends on the bundle when any tree or fix commit it names is private-bundle-only.
    const named = [item.reachability === 'unavailable' ? null : reach(item.reviewedSha), reach(item.baseSha), reach(item.postFixSha), ...item.fixCommits.map((f) => reach(f.sha))];
    if (named.includes('absent')) assert.equal(item.dependsOnPrivateBundle, true, `${at}: names a commit this clone lacks`);
    else assert.equal(item.dependsOnPrivateBundle, named.includes('private-bundle-only'), `${at}: bundle dependence`);

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
  assert.ok(failing.get('b'.repeat(64))?.includes('path-leak-scan'));
  assert.ok(failing.get('c'.repeat(64))?.includes('format-check'));
  assert.equal(failing.has('d'.repeat(64)), false);
});

test('the collector and the publication gate read one list of leak patterns', () => {
  // The gate and the pattern file are copied into a scratch root, so a pattern can be appended
  // without touching the repository.
  const scratch = mkdtempSync(join(tmpdir(), 'asep-leak-parity-'));
  try {
    for (const file of ['scripts/check-publication.sh', LEAK_PATTERNS_FILE, ...GATE_SCRIPTS]) {
      mkdirSync(dirname(join(scratch, file)), { recursive: true });
      cpSync(join(ROOT, file), join(scratch, file));
    }
    // Fixtures, assembled at runtime so no literal private path is committed.
    const fixtures = new Map<string, string>([
      ['1'.repeat(64), `home = ${'/Us' + 'ers/'}someone/workspace\n`],
      ['2'.repeat(64), `home = ${'/ho' + 'me/'}someone/workspace\n`],
      ['3'.repeat(64), `run = ~/.open${'claw/runs/'}42/log\n`],
      ['4'.repeat(64), `root = ${'/ro' + 'ot/'}cache\n`],
      ['5'.repeat(64), 'run = ~/.openclaw/runs/<id>/log and /usr/local/bin\n'],
      ['6'.repeat(64), `next = ${'/private' + '-new/'}workspace\n`],
      ['7'.repeat(64), 'publishable\n'],
    ]);
    const dir = join(scratch, 'fixtures');
    mkdirSync(dir);
    for (const [name, text] of fixtures) writeFileSync(join(dir, name), text);
    const names = [...fixtures.keys()];

    // The real script's path scanner: exit 1 with `  <file>:<line>:<text>` per hit, 0 clean.
    const script = () => {
      const r = spawnSync('bash', [join(scratch, 'scripts/check-publication.sh'), '--scan-paths', ...names.map((n) => join(dir, n))], { cwd: scratch });
      const hits = new Set(
        r.stdout
          .toString('utf8')
          .split('\n')
          .filter((line) => line.startsWith(`  ${dir}/`))
          .map((line) => line.slice(`  ${dir}/`.length, `  ${dir}/`.length + 64)),
      );
      return { status: r.status, hits: [...hits].sort() };
    };
    // The collector's path-leak gate over the same bytes; the four script gates report clean.
    const collector = () => {
      const candidates = new Map(names.map((n) => [n, new TextEncoder().encode(fixtures.get(n)!)]));
      const onlyGrep: GateRunner = (command, args, cwd) =>
        command === 'grep' ? runGateProcess(command, args, cwd) : { status: 0, signal: null, error: null, output: '' };
      return [...failingExcerpts(scratch, candidates, onlyGrep)].filter(([, gates]) => gates.includes('path-leak-scan')).map(([n]) => n).sort();
    };

    // Both read the same list and flag the same fixtures.
    const flagged = ['1', '2', '3', '4'].map((c) => c.repeat(64));
    assert.deepEqual(script(), { status: 1, hits: flagged });
    assert.deepEqual(collector(), flagged);
    // The review's drift probe: a pattern appended to the list is seen by both.
    appendFileSync(join(scratch, LEAK_PATTERNS_FILE), '/private-new/[A-Za-z]+\n');
    const withNew = [...flagged, '6'.repeat(64)].sort();
    assert.deepEqual(script(), { status: 1, hits: withNew });
    assert.deepEqual(collector(), withNew);

    // The list's format, read the same way by both: a list without a pattern, or a pattern line
    // that starts or ends with whitespace (a CRLF line included), is refused by both.
    const listFile = readFileSync(join(ROOT, LEAK_PATTERNS_FILE), 'utf8');
    const patterns = leakPatterns(listFile);
    assert.ok(patterns.length > 0);
    for (const pattern of patterns) assert.ok(listFile.split('\n').includes(pattern), pattern);
    for (const [label, text] of [
      ['no pattern', '# comments only\n\n'],
      ['leading space', ' /x/[0-9]\n'],
      ['trailing space', '/x/[0-9] \n'],
      ['CRLF', '/x/[0-9]\r\n'],
    ] as const) {
      writeFileSync(join(scratch, LEAK_PATTERNS_FILE), text);
      assert.throws(() => leakPatterns(text), /leak pattern/, label);
      assert.throws(() => collector(), /leak pattern/, label);
      assert.equal(script().status, 2, label);
    }
    rmSync(join(scratch, LEAK_PATTERNS_FILE));
    assert.equal(script().status, 2, 'missing list');
    assert.equal(existsSync(join(scratch, LEAK_PATTERNS_FILE)), false);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('the publication path scanner fails closed', () => {
  // The gate and its pattern list are copied into a scratch root, so the list can be changed
  // and a tree tracked without touching the repository. Private paths are assembled at runtime.
  const scratch = mkdtempSync(join(tmpdir(), 'asep-leak-closed-'));
  const privatePath = `${'/Us' + 'ers/'}someone/workspace`;
  try {
    for (const file of ['scripts/check-publication.sh', LEAK_PATTERNS_FILE]) {
      mkdirSync(dirname(join(scratch, file)), { recursive: true });
      cpSync(join(ROOT, file), join(scratch, file));
    }
    const list = readFileSync(join(ROOT, LEAK_PATTERNS_FILE), 'utf8');
    // `pathFirst` puts a directory first on the gate's PATH, set by the shell that starts it.
    const run = (mode: '--scan-paths' | '--scan-tracked' | '--self-test', args: readonly string[] = [], pathFirst: string | null = null) => {
      const gate = [join(scratch, 'scripts/check-publication.sh'), mode, ...args];
      const argv = pathFirst === null ? gate : ['-c', 'PATH="$0:$PATH" exec bash "$@"', pathFirst, ...gate];
      return spawnSync('bash', argv, { cwd: scratch, input: '' });
    };
    const status = (...args: Parameters<typeof run>) => run(...args).status;
    writeFileSync(join(scratch, 'clean.txt'), 'publishable\n');
    writeFileSync(join(scratch, 'leak.txt'), `home = ${privatePath}\n`);

    // The review's probe table, scanning named files: 0 clean, 1 with a hit, 2 when the scan
    // cannot be trusted.
    assert.equal(status('--scan-paths', ['clean.txt']), 0, 'clean file');
    assert.equal(status('--scan-paths', ['clean.txt', 'leak.txt']), 1, 'a file with a hit');
    assert.equal(status('--scan-paths', ['missing.txt']), 2, 'a path that does not exist');
    assert.equal(status('--scan-paths', []), 2, 'no file');
    mkdirSync(join(scratch, 'dir'));
    assert.equal(status('--scan-paths', ['dir']), 2, 'a directory');
    if (process.getuid?.() !== 0) {
      // Root reads a file whatever its mode, so only another user can prove this case.
      writeFileSync(join(scratch, 'unreadable.txt'), 'publishable\n', { mode: 0o000 });
      assert.equal(status('--scan-paths', ['unreadable.txt']), 2, 'an unreadable file');
    }
    // A file named like an option is still a file: it is scanned, not read as a grep flag.
    writeFileSync(join(scratch, '-v'), `home = ${privatePath}\n`);
    assert.equal(status('--scan-paths', ['-v']), 1, 'a file named -v');

    // A grep that fails on a file is not a clean scan: a stub that refuses every real file.
    const bin = join(scratch, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'grep'), '#!/bin/sh\nfor a; do last=$a; done\n[ "$last" = /dev/null ] && exit 1\nexit 127\n', { mode: 0o755 });
    assert.equal(status('--scan-paths', ['clean.txt'], bin), 2, 'grep exits 127');

    // A pattern grep cannot run fails the gate before any file is scanned, alone or beside valid
    // ones, and before the scanner's self-test can report.
    for (const [label, text] of [
      ['only an invalid pattern', '[\n'],
      ['the list plus an invalid pattern', `${list}[\n`],
    ] as const) {
      writeFileSync(join(scratch, LEAK_PATTERNS_FILE), text);
      assert.equal(status('--scan-paths', ['clean.txt']), 2, label);
      assert.equal(status('--self-test'), 2, `${label}: self-test`);
    }
    writeFileSync(join(scratch, LEAK_PATTERNS_FILE), list);

    // The tracked-file scan reads NUL-separated names and exempts no part of the pattern list.
    const git = (...args: string[]) => assert.equal(spawnSync('git', args, { cwd: scratch }).status, 0, `git ${args.join(' ')}`);
    rmSync(join(scratch, 'leak.txt'));
    rmSync(join(scratch, '-v'));
    rmSync(join(scratch, 'unreadable.txt'), { force: true });
    rmSync(bin, { recursive: true });
    git('init', '-q');
    git('add', '-A');
    assert.equal(status('--scan-tracked'), 0, 'a clean tree, the pattern list included');
    // A private path in a comment of the list is a leak like any other.
    writeFileSync(join(scratch, LEAK_PATTERNS_FILE), `${list}# for example ${privatePath}\n`);
    const commented = run('--scan-tracked');
    assert.equal(commented.status, 1, 'a private path in a comment of the list');
    assert.match(commented.stdout.toString('utf8'), new RegExp(`^  ${LEAK_PATTERNS_FILE.replaceAll('.', '\\.')}:`, 'm'));
    writeFileSync(join(scratch, LEAK_PATTERNS_FILE), list);
    // A name Git quotes in its line output is still scanned.
    writeFileSync(join(scratch, 'café.txt'), `home = ${privatePath}\n`);
    git('add', '-A');
    const quoted = run('--scan-tracked');
    assert.equal(quoted.status, 1, 'a tracked name with a non-ASCII character');
    assert.match(quoted.stdout.toString('utf8'), /^ {2}café\.txt:1:/m);
    // A tracked file that cannot be read stops the scan.
    rmSync(join(scratch, 'café.txt'));
    assert.equal(status('--scan-tracked'), 2, 'a tracked file missing from the tree');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('a publication gate that does not complete aborts collection', () => {
  const encode = (text: string) => new TextEncoder().encode(text);
  const [a, b] = ['a'.repeat(64), 'b'.repeat(64)];
  const candidates = new Map([
    [a, encode('one\n')],
    [b, encode('two\n')],
  ]);
  // The documented codes, stated independently: the four scripts exit 0 clean and 1 with
  // findings; the path-leak scan is grep, which exits 1 clean and 0 with findings.
  const CODES: Readonly<Record<PublicationGate, { readonly clean: number; readonly findings: number }>> = {
    'format-check': { clean: 0, findings: 1 },
    'secret-scan': { clean: 0, findings: 1 },
    'pii-scan': { clean: 0, findings: 1 },
    'large-file-scan': { clean: 0, findings: 1 },
    'path-leak-scan': { clean: 1, findings: 0 },
  };
  const gates = Object.keys(CODES) as PublicationGate[];
  const gateOf = (command: string, args: readonly string[]): PublicationGate =>
    command === 'grep' ? 'path-leak-scan' : (/^scripts\/(.+)\.sh$/.exec(args[0] ?? '')![1] as PublicationGate);
  /** Every gate clean except `faulty`, which returns `run`. */
  const runner =
    (faulty: readonly PublicationGate[], run: Partial<GateRun>): GateRunner =>
    (command, args) => {
      const gate = gateOf(command, args);
      const clean: GateRun = { status: CODES[gate].clean, signal: null, error: null, output: `${gate}: PASS` };
      return faulty.includes(gate) ? { ...clean, status: null, ...run } : clean;
    };
  const leftovers = () => readdirSync(tmpdir()).filter((name) => name.startsWith('asep-corpus-gates-')).sort();
  const before = leftovers();

  for (const gate of gates) {
    const aborts: readonly (readonly [string, Partial<GateRun>, RegExp])[] = [
      ['crash', { signal: 'SIGSEGV' }, /killed by SIGSEGV/],
      ['missing executable', { error: Object.assign(new Error(`spawnSync ${gate} ENOENT`), { code: 'ENOENT' }) }, /could not run/],
      ['findings code naming no excerpt', { status: CODES[gate].findings, output: `${gate}: FAIL — the scanner could not read its input` }, /named no excerpt/],
      ['a status outside the documented codes', { status: 2, output: `${gate}: error` }, /exited 2/],
    ];
    for (const [label, run, reason] of aborts) {
      assert.throws(() => failingExcerpts(ROOT, candidates, runner([gate], run)), new RegExp(`publication gate ${gate} .*${reason.source}`), `${gate}: ${label}`);
    }
    // A findings code that names an excerpt withholds that excerpt, and only that one.
    const named = failingExcerpts(ROOT, candidates, runner([gate], { status: CODES[gate].findings, output: `  ${BLOBS_DIR}/${a}: finding` }));
    assert.deepEqual([...named], [[a, [gate]]], gate);
  }
  // The review's probe: all five gates fail with status 2.
  assert.throws(() => failingExcerpts(ROOT, candidates, runner(gates, { status: 2 })), /publication gate/);
  // Every gate clean: nothing is withheld.
  assert.deepEqual([...failingExcerpts(ROOT, candidates, runner([], {}))], []);
  // No temporary repository is left behind, whatever the outcome.
  assert.deepEqual(leftovers(), before);


  // Git: a spawn error or a signal is never read as "no such object"; a probe's own
  // not-found status is, and any other failing query aborts.
  const exec =
    (result: Partial<ReturnType<GitExec>>): GitExec =>
    () => ({ status: 0, signal: null, error: null, stdout: Buffer.alloc(0), ...result });
  assert.throws(() => new GitReader(ROOT, exec({ status: null, signal: 'SIGKILL' })).commit('HEAD'), /git rev-parse was killed by SIGKILL/);
  assert.throws(() => new GitReader(ROOT, exec({ status: null, error: new Error('spawnSync git ENOENT') })).blob('HEAD', 'a.ts'), /git cat-file could not run/);
  assert.equal(new GitReader(ROOT, exec({ status: 1 })).commit('HEAD'), null);
  assert.equal(new GitReader(ROOT, exec({ status: 128 })).blob('HEAD', 'a.ts'), null);
  assert.equal(new GitReader(ROOT, exec({ status: 1 })).isAncestor('a', 'b'), false);
  assert.throws(() => new GitReader(ROOT, exec({ status: 128 })).isAncestor('a', 'b'), /git merge-base --is-ancestor exited 128/);
  assert.throws(() => new GitReader(ROOT, exec({ status: 128 })).addedBy('a.ts'), /git log failed/);
  assert.throws(() => new GitReader(ROOT, exec({ status: 128 })).commitsBetween('a', 'b'), /git log failed/);
});
