import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BLOBS_DIR, ITEMS_DIR, failingExcerpts, type CorpusItem } from './collect.js';
import { ANNOTATIONS_FILE, EXCLUSION_ORDER, MANIFEST_FILE, MAPPING_DIR, type ManifestBody } from './freeze.js';

console.log('SUITE-ID: asep-suite:review-corpus');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const read = (path: string) => new Uint8Array(readFileSync(join(ROOT, path)));
const git = (...args: string[]) => spawnSync('git', args, { cwd: ROOT, maxBuffer: 256 * 1024 * 1024 });

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
}

test('every corpus claim and excerpt is verified', () => {
  const { corpusSha256, ...body } = JSON.parse(new TextDecoder().decode(read(MANIFEST_FILE))) as ManifestBody & { corpusSha256: string };

  // The manifest's digest is its body's, and the body names the exact bytes of every input.
  assert.equal(corpusSha256, sha256(canonical(body)));
  assert.equal(body.annotationsSha256, sha256(read(ANNOTATIONS_FILE)));
  const files = readdirSync(join(ROOT, ITEMS_DIR)).sort();
  assert.deepEqual(body.items.map((i) => `${i.id}.json`).sort(), files);
  const items = new Map<string, CorpusItem>();
  for (const entry of body.items) {
    const bytes = read(`${ITEMS_DIR}/${entry.id}.json`);
    assert.equal(entry.itemSha256, sha256(bytes), entry.id);
    items.set(entry.id, JSON.parse(new TextDecoder().decode(bytes)) as CorpusItem);
  }

  // Every excerpt and every stored diff section hashes to its name, and none is unlisted.
  for (const [dir, listed] of [
    [BLOBS_DIR, body.blobs],
    [MAPPING_DIR, body.mappingDiffs],
  ] as const) {
    assert.deepEqual(readdirSync(join(ROOT, dir)).sort(), [...listed].sort(), dir);
    for (const name of listed) assert.equal(sha256(read(`${dir}/${name}`)), name, `${dir}/${name}`);
  }

  // Exclusions are enumerated: each item has one reason or none, in the protocol's vocabulary, and the
  // counts are the items' own; a provenance exclusion is the one collection recorded.
  const tally: Record<string, number> = {};
  for (const entry of body.items) {
    const item = items.get(entry.id)!;
    if (item.excluded !== null) assert.equal(entry.excluded?.reason, item.excluded.reason, entry.id);
    if (entry.excluded === null) continue;
    assert.ok(EXCLUSION_ORDER.includes(entry.excluded.reason), entry.id);
    tally[entry.excluded.reason] = (tally[entry.excluded.reason] ?? 0) + 1;
  }
  assert.deepEqual(tally, body.counts.excluded);
  assert.equal(body.items.filter((i) => i.excluded === null).length, body.counts.included);

  // Each stored diff section is the reviewed-to-post-fix diff of its file as git gives it; a file
  // without a section did not change. Every section is used.
  const used = new Set<string>();
  for (const entry of body.items) {
    if (entry.mapping === null) continue;
    const item = items.get(entry.id)!;
    assert.equal(item.confirmation?.status, 'RESOLVED', entry.id);
    const whole = git('diff', '--no-color', '--no-ext-diff', '--no-textconv', '--find-renames', '--unified=3', item.reviewedSha!, item.postFixSha!);
    assert.equal(whole.status, 0, `${entry.id}: git diff`);
    for (const m of entry.mapping) {
      if (m.diffSha256 === null) {
        assert.deepEqual(m.withheldGates, [], `${entry.id}: ${m.path} withheld`);
        assert.equal(git('diff', '--quiet', item.reviewedSha!, item.postFixSha!, '--', m.path).status, 0, `${entry.id}: ${m.path} changed`);
        continue;
      }
      used.add(m.diffSha256);
      const section = Buffer.from(read(`${MAPPING_DIR}/${m.diffSha256}`)).toString('latin1');
      assert.ok(section.startsWith(`diff --git a/${m.path} b/${m.newPath ?? m.path}\n`), `${entry.id}: ${m.path} section header`);
      const text = whole.stdout.toString('latin1');
      const at = text.indexOf(section);
      assert.ok(at >= 0 && (at === 0 || text[at - 1] === '\n'), `${entry.id}: ${m.path} is not git's section`);
      assert.ok(at + section.length === text.length || text.startsWith('diff --git ', at + section.length), `${entry.id}: ${m.path} section is cut`);
    }
  }
  assert.deepEqual([...used].sort(), [...body.mappingDiffs].sort());

  // No ref names a commit that exists only before the history rewrite.
  const bundleOnly = new Set<string>();
  for (const item of items.values()) {
    if (item.reachability === 'private-bundle-only') bundleOnly.add(item.reviewedSha!);
    for (const fix of item.fixCommits) if (fix.reachability === 'private-bundle-only') bundleOnly.add(fix.sha);
  }
  for (const sha of bundleOnly) {
    if (git('cat-file', '-e', `${sha}^{commit}`).status !== 0) continue;
    const refs = git('for-each-ref', `--contains=${sha}`, '--format=%(refname)');
    assert.equal(refs.status, 0);
    assert.equal(refs.stdout.toString('utf8').trim(), '', `${sha} is named by a ref`);
  }

  // Every committed excerpt and diff section passes the publication gates. Bundle mode, which checks
  // private-bundle-only excerpts against the controller's bundle, runs only when the controller
  // supplies the bundle path; it has not.
  const candidates = new Map<string, Uint8Array>();
  for (const name of body.blobs) candidates.set(name, read(`${BLOBS_DIR}/${name}`));
  for (const name of body.mappingDiffs) candidates.set(name, read(`${MAPPING_DIR}/${name}`));
  assert.deepEqual([...failingExcerpts(ROOT, candidates)], []);
});
