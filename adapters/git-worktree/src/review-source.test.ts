import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ArtifactRef, TenantScope } from '@asep/contracts';
import type { ArtifactPutInput, ArtifactStore, ArtifactStream, ArtifactVerification, WorkspaceCapability } from '@asep/ports';
import { GitReviewSourceReader, ReviewSourceError } from './review-source.js';

console.log('SUITE-ID: asep-suite:review-source');

const SCOPE = { organizationId: '01JORGANIZATION00000000000', projectId: '01JPROJECT0000000000000000' } as unknown as TenantScope;
const WS = { workspaceId: 'ws-1', leaseId: 'lease-1' } as unknown as WorkspaceCapability;
const DIFF_FLAGS = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--find-renames', '--unified=3'];

class MemoryArtifacts implements ArtifactStore {
  readonly stored = new Map<string, Uint8Array>();
  async put(_scope: TenantScope, input: ArtifactPutInput): Promise<ArtifactRef> {
    const sha = createHash('sha256').update(input.content).digest('hex');
    assert.equal(sha, input.sha256, 'the reader states the checksum of the bytes it stores');
    this.stored.set(sha, input.content);
    return { artifactId: `art-${sha.slice(0, 12)}` as never, sha256: sha, kind: input.kind };
  }
  async get(_scope: TenantScope, ref: ArtifactRef): Promise<ArtifactStream> {
    const content = this.stored.get(ref.sha256)!;
    return { ref, content, sizeBytes: content.length, contentType: 'application/octet-stream' };
  }
  async verify(_scope: TenantScope, ref: ArtifactRef): Promise<ArtifactVerification> {
    return { ref, ok: this.stored.has(ref.sha256), actualSha256: ref.sha256, sizeBytes: 0 };
  }
  bytesOf(ref: ArtifactRef | null): Buffer {
    assert.ok(ref);
    return Buffer.from(this.stored.get(ref.sha256)!);
  }
}

let dir: string;
let base: string;
let head: string;

function git(args: readonly string[], cwd = dir): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd, encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  });
}

function gitBytes(args: readonly string[]): Buffer {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: dir, env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  });
}

function commit(message: string, stage: () => void = () => {}): string {
  git(['add', '-A']);
  stage();
  git(['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', message]);
  return git(['rev-parse', 'HEAD']).trim();
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'asep-review-source-'));
  git(['init', '-q', '-b', 'main']);
  await writeFile(join(dir, 'keep.txt'), 'one\ntwo\nthree\n');
  await writeFile(join(dir, 'gone.txt'), 'to be deleted\n');
  await writeFile(join(dir, 'old-name.txt'), 'renamed content line 1\nline 2\nline 3\nline 4\n');
  await writeFile(join(dir, 'big.txt'), 'x'.repeat(5000) + '\n');
  base = commit('base');

  await writeFile(join(dir, 'keep.txt'), 'one\nTWO\nthree\n');
  await unlink(join(dir, 'gone.txt'));
  git(['mv', 'old-name.txt', 'new-name.txt']);
  await writeFile(join(dir, 'image.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x00, 0xff]));
  await writeFile(join(dir, 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
  await writeFile(join(dir, 'big.txt'), 'y'.repeat(5000) + '\n');
  await mkdir(join(dir, 'sub dir'));
  await writeFile(join(dir, 'sub dir', 'añadido.txt'), 'línea\n');
  // a submodule entry: a gitlink staged after `add -A`, with no checkout
  head = commit('head', () => git(['update-index', '--add', '--cacheinfo', `160000,${base},vendored`]));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

function reader(artifacts = new MemoryArtifacts()) {
  return { artifacts, reader: new GitReviewSourceReader({ artifacts, workspacePath: () => dir }) };
}

test('a range diff is the exact bytes git gives for the pinned flags, with every changed file listed', async () => {
  const { artifacts, reader: r } = reader();
  const out = await r.diffRange(SCOPE, { workspace: WS, fromSha: base, toSha: head, maxBytes: 1_000_000 });
  const expected = gitBytes([...DIFF_FLAGS, base, head]);
  assert.ok(artifacts.bytesOf(out.diff).equals(expected), 'the stored diff is git\'s output, byte for byte');
  assert.equal(out.bytes, expected.length);
  assert.equal(out.overLimit, false);
  assert.equal(out.diff.kind, 'review-diff');
  assert.deepEqual(out.changedFiles, [
    { path: 'big.txt', status: 'M', binary: false },
    { path: 'gone.txt', status: 'D', binary: false },
    { path: 'image.bin', status: 'A', binary: true },
    { path: 'keep.txt', status: 'M', binary: false },
    { path: 'latin1.txt', status: 'A', binary: false },
    { path: 'new-name.txt', status: 'R', binary: false },
    { path: 'sub dir/añadido.txt', status: 'A', binary: false },
    { path: 'vendored', status: 'A', binary: false },
  ]);
});

test('a diff over the limit is stored whole and flagged, never cut', async () => {
  const { artifacts, reader: r } = reader();
  const full = gitBytes([...DIFF_FLAGS, base, head]);
  const out = await r.diffRange(SCOPE, { workspace: WS, fromSha: base, toSha: head, maxBytes: full.length - 1 });
  assert.equal(out.overLimit, true);
  assert.equal(out.bytes, full.length);
  assert.ok(artifacts.bytesOf(out.diff).equals(full));
  const exact = await r.diffRange(SCOPE, { workspace: WS, fromSha: base, toSha: head, maxBytes: full.length });
  assert.equal(exact.overLimit, false, 'a diff of exactly maxBytes fits');
});

test('binary, too-large, submodule, deleted and non-UTF-8 files are reported, never dropped', async () => {
  const { artifacts, reader: r } = reader();
  const paths = ['keep.txt', 'image.bin', 'big.txt', 'vendored', 'gone.txt', 'latin1.txt', 'sub dir/añadido.txt'];
  const blobs = await r.readBlobs(SCOPE, { workspace: WS, sha: head, paths, maxBytesPerFile: 4096 });
  assert.deepEqual(blobs.map((b) => [b.path, b.omittedReason, b.bytes, b.lineCount, b.blob === null]), [
    ['keep.txt', null, 14, 3, false],
    ['image.bin', 'binary', 9, 0, true],
    ['big.txt', 'too-large', 5001, 0, true],
    ['vendored', 'submodule', 0, 0, true],
    ['gone.txt', 'deleted', 0, 0, true],
    ['latin1.txt', 'non-utf8', 5, 0, true],
    ['sub dir/añadido.txt', null, 'línea\n'.length + 1, 1, false],
  ]);
  assert.equal(artifacts.bytesOf(blobs[0]!.blob).toString('utf8'), 'one\nTWO\nthree\n');
  assert.equal(blobs[0]!.blob!.kind, 'review-post-image');
  assert.equal(artifacts.bytesOf(blobs[6]!.blob).toString('utf8'), 'línea\n');
  // the pre-image side reads at the other commit
  const pre = await r.readBlobs(SCOPE, { workspace: WS, sha: base, paths: ['keep.txt', 'gone.txt'], maxBytesPerFile: 4096 });
  assert.deepEqual(pre.map((b) => [b.path, b.omittedReason]), [['keep.txt', null], ['gone.txt', null]]);
  assert.equal(artifacts.bytesOf(pre[0]!.blob).toString('utf8'), 'one\ntwo\nthree\n');
});

test('a file of exactly the limit is read and one byte over is too large', async () => {
  const { reader: r } = reader();
  const [fits] = await r.readBlobs(SCOPE, { workspace: WS, sha: head, paths: ['keep.txt'], maxBytesPerFile: 14 });
  assert.equal(fits!.omittedReason, null);
  const [over] = await r.readBlobs(SCOPE, { workspace: WS, sha: head, paths: ['keep.txt'], maxBytesPerFile: 13 });
  assert.deepEqual([over!.omittedReason, over!.bytes, over!.blob], ['too-large', 14, null]);
});

test('traversal and paths that are not normalizable are refused and never read', async () => {
  const { artifacts, reader: r } = reader();
  const bad = ['../outside.txt', 'sub dir/../../etc/passwd', '/etc/passwd', './keep.txt', 'a//b', '', 'line\nbreak',
    'sub dir/', '.git/config', 'sub\\keep.txt', 'nul\u0000byte'];
  const blobs = await r.readBlobs(SCOPE, { workspace: WS, sha: head, paths: bad, maxBytesPerFile: 4096 });
  assert.deepEqual(blobs.map((b) => [b.path, b.omittedReason, b.blob]), bad.map((p) => [p, 'unsafe-path', null]));
  assert.equal(artifacts.stored.size, 0, 'nothing was stored');
});

test('commits are full SHAs that exist in the workspace, or the reader refuses', async () => {
  const { reader: r } = reader();
  await assert.rejects(r.diffRange(SCOPE, { workspace: WS, fromSha: 'HEAD', toSha: head, maxBytes: 10 }), ReviewSourceError);
  await assert.rejects(r.diffRange(SCOPE, { workspace: WS, fromSha: base.slice(0, 12), toSha: head, maxBytes: 10 }), ReviewSourceError);
  await assert.rejects(r.diffRange(SCOPE, { workspace: WS, fromSha: base, toSha: 'f'.repeat(40), maxBytes: 10 }), /not a commit/);
  await assert.rejects(r.readBlobs(SCOPE, { workspace: WS, sha: '--output=/tmp/x', paths: ['keep.txt'], maxBytesPerFile: 10 }), ReviewSourceError);
  await assert.rejects(r.diffRange(SCOPE, { workspace: WS, fromSha: base, toSha: head, maxBytes: -1 }), ReviewSourceError);
});
