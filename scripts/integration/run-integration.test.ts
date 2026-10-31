// Integration-gate negative tests (disp. P2-FINAL-HIGH-001). These prove the
// gate's FAIL-CLOSED contract WITHOUT provisioning containers, so they run under
// the fast `pnpm test` unit runner. The point HIGH-001 demands: the gate must go
// RED — never silently green — when a backend is absent, an image is not
// digest-pinned, discovery finds nothing, or a required suite marker is missing.
//
// The live-backend proof itself is the *.itest.ts suites under the integration
// gate; here we exercise the pure fail-closed logic the gate composes.

import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error — .mjs helpers have no type declarations; we test their runtime contract.
import { assertDigestPinned, DIGEST_PINNED, IMAGES } from './images.mjs';
// @ts-expect-error — .mjs helpers have no type declarations; we test their runtime contract.
import { discoverItestFiles, missingRequiredItestSuites, REQUIRED_ITEST_SUITES, suiteMarker, resolveDocker, waitReady } from './lib.mjs';
// @ts-expect-error — .mjs helpers have no type declarations; we test their runtime contract.
import { assertLoopbackPublish, containerRunArgv, loopbackPublish, runContainer } from './lib.mjs';
// @ts-expect-error — .mjs helpers have no type declarations; we test their runtime contract.
import { buildWorkspace, engineVersionGap, MIN_DOCKER_ENGINE } from './lib.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

console.log('SUITE-ID: asep-suite:integration-gate');

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');

// ---------------------------------------------------------------------------
// Digest-pinning: a mutable tag must be rejected before any container starts.
// ---------------------------------------------------------------------------

test('every configured backend image is digest-pinned', () => {
  for (const [name, ref] of Object.entries(IMAGES) as [string, string][]) {
    assert.match(ref, DIGEST_PINNED, `${name} image must be @sha256-pinned`);
  }
});

test('assertDigestPinned REJECTS a mutable tag (fail closed before provisioning)', () => {
  assert.throws(() => assertDigestPinned('postgres:17'), /not digest-pinned/);
  assert.throws(() => assertDigestPinned('minio/minio:latest'), /not digest-pinned/);
  assert.throws(() => assertDigestPinned('postgres@sha256:tooshort'), /not digest-pinned/);
});

test('assertDigestPinned ACCEPTS a proper @sha256 digest', () => {
  const ok = `postgres@sha256:${'a'.repeat(64)}`;
  assert.equal(assertDigestPinned(ok), ok);
});

// ---------------------------------------------------------------------------
// Discovery: the real concurrency itest is found; a broken root finds nothing.
// ---------------------------------------------------------------------------

test('itest discovery finds the real *.itest.ts suites', () => {
  const files = discoverItestFiles(REPO_ROOT);
  assert.ok(files.length > 0, 'at least one itest suite exists');
  assert.ok(
    files.includes('adapters/persistence/src/concurrency.itest.ts'),
    'the multi-connection concurrency itest must be discovered',
  );
});

test('itest discovery returns EMPTY for a root with no itest files (gate fails closed on this)', () => {
  // Pointed at a directory with no *.itest.ts, discovery yields [] — the CLI
  // turns that into a RED gate rather than "success by running nothing".
  const files = discoverItestFiles(join(REPO_ROOT, 'docs'));
  assert.deepEqual(files, []);
});

// ---------------------------------------------------------------------------
// Required-suite verification: a missing SUITE-ID marker turns the gate RED.
// ---------------------------------------------------------------------------

test('required-itest verification reports NOTHING missing when every marker present', () => {
  const output = Object.keys(REQUIRED_ITEST_SUITES).map(suiteMarker).join('\n');
  assert.deepEqual(missingRequiredItestSuites(output), []);
});

test('required-itest verification FAILS CLOSED when a marker is absent', () => {
  const missing = missingRequiredItestSuites('no markers here at all');
  assert.ok(missing.length >= 1, 'a missing required suite is reported');
  assert.ok(
    missing.some((m: { id: string }) => m.id === 'asep-suite:pg-concurrency'),
    'the concurrency suite is flagged when its marker never appeared',
  );
});

// ---------------------------------------------------------------------------
// Health-check budget: waitReady returns false when the probe never succeeds,
// which the CLI converts into a RED gate ("backend never became healthy").
// ---------------------------------------------------------------------------

test('waitReady returns false when the probe never succeeds (dead-backend → RED)', async () => {
  const ok = await waitReady(() => false, { attempts: 3, intervalMs: 1 });
  assert.equal(ok, false);
});

test('waitReady returns true as soon as the probe succeeds', async () => {
  let n = 0;
  const ok = await waitReady(() => { n += 1; return n >= 2; }, { attempts: 5, intervalMs: 1 });
  assert.equal(ok, true);
});

test('waitReady treats a throwing probe as not-ready (never leaks the error)', async () => {
  const ok = await waitReady(() => { throw new Error('connection refused'); }, { attempts: 2, intervalMs: 1 });
  assert.equal(ok, false);
});

// ---------------------------------------------------------------------------
// resolveDocker: an all-bogus candidate list resolves to null (→ RED), never a
// false positive.
// ---------------------------------------------------------------------------

test('resolveDocker returns null when no candidate binary responds (→ gate RED)', () => {
  const r = resolveDocker(['/nonexistent/docker-xyz', '/also/not/here']);
  assert.equal(r, null);
});

// ---------------------------------------------------------------------------
// compose.yaml <-> images.mjs digest parity (disp. P2-FINAL-HIGH-001).
//
// The review flagged compose.yaml pinning postgres/minio by MUTABLE TAG while
// the gate pinned by digest. Both are now digest-pinned, and this test keeps
// them byte-identical forever: `pnpm infra:up` (developer) and the integration
// gate (CI) must provision the SAME immutable backend build, or the suites are
// proven against something other than what a developer runs. Re-pointing one
// without the other turns this RED.
// ---------------------------------------------------------------------------

test('compose.yaml pins postgres + minio BY DIGEST (no mutable tag)', () => {
  const compose = readFileSync(join(REPO_ROOT, 'compose.yaml'), 'utf8');
  const images = [...compose.matchAll(/^\s*image:\s*(\S+)\s*$/gm)].map((m) => m[1] as string);
  const pg = images.filter((i) => i.startsWith('postgres'));
  const minio = images.filter((i) => i.startsWith('minio/minio'));
  assert.ok(pg.length >= 1, 'compose declares a postgres image');
  assert.ok(minio.length >= 1, 'compose declares a minio image');
  for (const ref of [...pg, ...minio]) {
    assert.match(ref, DIGEST_PINNED, `compose image '${ref}' must be @sha256-pinned, not a tag`);
  }
});

test('compose.yaml digests are IDENTICAL to the integration gate images', () => {
  const compose = readFileSync(join(REPO_ROOT, 'compose.yaml'), 'utf8');
  const images = [...compose.matchAll(/^\s*image:\s*(\S+)\s*$/gm)].map((m) => m[1] as string);
  assert.ok(
    images.includes(IMAGES.postgres),
    `compose postgres digest must equal the gate's (${IMAGES.postgres})`,
  );
  assert.ok(
    images.includes(IMAGES.minio),
    `compose minio digest must equal the gate's (${IMAGES.minio})`,
  );
});

test('compose.yaml health-checks BOTH postgres and minio (gate can wait, not race)', () => {
  const compose = readFileSync(join(REPO_ROOT, 'compose.yaml'), 'utf8');
  // Split into top-level service blocks and assert each of the two backends the
  // integration gate depends on declares its own healthcheck.
  const serviceBlock = (name: string): string => {
    const start = compose.indexOf(`\n  ${name}:`);
    assert.notEqual(start, -1, `compose declares a '${name}' service`);
    const rest = compose.slice(start + 1);
    const next = rest.search(/\n {2}\w[\w-]*:\n/);
    return next === -1 ? rest : rest.slice(0, next);
  };
  for (const svc of ['postgres', 'minio']) {
    assert.match(
      serviceBlock(svc),
      /healthcheck:/,
      `service '${svc}' must declare a healthcheck so readiness is waited on`,
    );
  }
});

// ---------------------------------------------------------------------------
// Published ports bind the loopback interface only. The backends run with
// fixed development credentials; a bare `-p 5432:5432` (or a compose
// `"5432:5432"`) publishes them on every host interface for the whole run.
// ---------------------------------------------------------------------------

test('a publish spec is accepted only when it names 127.0.0.1 explicitly', () => {
  assert.equal(assertLoopbackPublish('127.0.0.1:55440:5432'), '127.0.0.1:55440:5432');
  assert.equal(assertLoopbackPublish('127.0.0.1:59000:9000/tcp'), '127.0.0.1:59000:9000/tcp');
  assert.equal(loopbackPublish('55440', 5432), '127.0.0.1:55440:5432');
  for (const bad of [
    '55440:5432', '5432', '0.0.0.0:55440:5432', '[::]:55440:5432', '::1:55440:5432',
    'localhost:55440:5432', '127.0.0.10:55440:5432', '127.0.0.1::5432', ' 127.0.0.1:55440:5432',
    '127.0.0.1:55440:5432 ', '127.0.0.1:70000:5432', '127.0.0.1:55440:5432/udp', '',
  ]) {
    assert.throws(() => assertLoopbackPublish(bad), /does not bind 127\.0\.0\.1/, `'${bad}' must be refused`);
  }
  assert.throws(() => loopbackPublish('', 5432), /does not bind 127\.0\.0\.1/);
});

test('the gate publishes every backend port on 127.0.0.1 and refuses anything else before docker runs', () => {
  const image = `postgres@sha256:${'a'.repeat(64)}`;
  const argv: string[] = containerRunArgv({
    image, name: 'n', ports: ['127.0.0.1:55440:5432', '127.0.0.1:55441:5433'],
  });
  const published = argv.flatMap((a, i) => (a === '-p' ? [argv[i + 1]] : []));
  assert.deepEqual(published, ['127.0.0.1:55440:5432', '127.0.0.1:55441:5433']);
  assert.ok(!argv.includes('-P') && !argv.includes('--publish-all'));
  // The refusal happens before any docker client is invoked: a bogus binary
  // would otherwise surface as "failed to start container".
  assert.throws(
    () => runContainer('/nonexistent/docker-xyz', { image, name: 'n', ports: ['55440:5432'] }),
    /does not bind 127\.0\.0\.1/,
  );
  assert.throws(() => containerRunArgv({ image, name: 'n', ports: ['0.0.0.0:1:2'] }), /does not bind/);
});

// Every place the gate could publish a port: its own CLI and helpers, every
// integration suite it runs, and the CI job that drives it. The only `-p` the
// gate may emit is the one containerRunArgv guards; the CLI must build every
// publish spec with loopbackPublish().
test('no gate source publishes a port except through the loopback-checked builder', () => {
  const gateSources = [
    'scripts/integration/lib.mjs',
    'scripts/integration/run-integration.mjs',
    'scripts/integration/images.mjs',
    '.github/workflows/ci.yml',
    ...discoverItestFiles(REPO_ROOT),
  ];
  const PUBLISH_TOKEN = /(['"`])(-p|-P|--publish|--publish-all)(=[^'"`]*)?\1|\bdocker\b[^\n]*\s(-p|-P|--publish(-all)?)[\s=]/;
  const offenders: string[] = [];
  for (const rel of gateSources) {
    const lines = readFileSync(join(REPO_ROOT, rel), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (/^\s*(\/\/|#|\*)/.test(line)) return;
      if (!PUBLISH_TOKEN.test(line)) return;
      const guarded = rel === 'scripts/integration/lib.mjs' && line.includes("argv.push('-p', assertLoopbackPublish(p))");
      if (!guarded) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], `unguarded port publish in the gate:\n${offenders.join('\n')}`);

  const cli = readFileSync(join(REPO_ROOT, 'scripts/integration/run-integration.mjs'), 'utf8');
  const portLists = [...cli.matchAll(/\bports:\s*\[([^\]]*)\]/g)].map((m) => m[1] as string);
  assert.ok(portLists.length >= 2, 'the CLI publishes PostgreSQL and MinIO');
  for (const list of portLists) {
    for (const entry of list.split(/,(?![^(]*\))/).map((e) => e.trim()).filter(Boolean)) {
      assert.match(entry, /^loopbackPublish\(/, `the CLI must build '${entry}' with loopbackPublish()`);
    }
  }
});

// The publish entries of every compose service, short syntax only: a long-form
// mapping or anything this parser does not recognise is reported, never skipped.
function composePublishEntries(compose: string): string[] {
  const entries: string[] = [];
  const lines = compose.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (/^\s*#/.test(line)) continue;
    const inline = /^(\s*)ports:\s*(.*)$/.exec(line);
    if (!inline) continue;
    const rest = (inline[2] as string).trim();
    if (rest !== '') {
      const list = /^\[(.*)\]$/.exec(rest);
      if (!list) {
        entries.push(`<unparsed: ${rest}>`);
        continue;
      }
      entries.push(...(list[1] as string).split(',').map((e) => e.trim()).filter(Boolean));
      continue;
    }
    const indent = (inline[1] as string).length;
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j] as string;
      if (next.trim() === '' || /^\s*#/.test(next)) continue;
      if (next.length - next.trimStart().length <= indent) break;
      const item = /^\s*-\s*(.*)$/.exec(next);
      entries.push(item ? (item[1] as string).trim() : `<unparsed: ${next.trim()}>`);
    }
  }
  return entries;
}

test('compose.yaml publishes every service port on 127.0.0.1 only', () => {
  const compose = readFileSync(join(REPO_ROOT, 'compose.yaml'), 'utf8');
  const entries = composePublishEntries(compose);
  assert.ok(entries.length >= 10, `compose publish entries found: ${entries.length}`);
  const offenders = entries.filter((e) => !/^"127\.0\.0\.1:[^"]*"$/.test(e));
  assert.deepEqual(offenders, [], `compose ports not bound to 127.0.0.1: ${offenders.join(', ')}`);
});

test('the compose port parser reports what it cannot read instead of skipping it', () => {
  const sample = [
    'services:',
    '  a:',
    '    ports: ["127.0.0.1:1:1", "2:2"]',
    '  b:',
    '    ports:',
    '      - "127.0.0.1:3:3"',
    '      - target: 4',
    '        published: 4',
    '  c:',
    '    ports: "5:5"',
  ].join('\n');
  assert.deepEqual(composePublishEntries(sample), [
    '"127.0.0.1:1:1"', '"2:2"', '"127.0.0.1:3:3"', 'target: 4', '<unparsed: published: 4>', '<unparsed: "5:5">',
  ]);
});

// ---------------------------------------------------------------------------
// The end-to-end fail-closed proof is REGISTERED as a required integration
// suite. HIGH-001's core demand ("a deliberately-unavailable backend turns the
// required job RED") is proven by gate-fail-closed.itest.ts spawning the real
// CLI; if that suite were dropped or renamed, the gate must go RED rather than
// quietly lose its own negative proof.
// ---------------------------------------------------------------------------

test('the e2e fail-closed suite is a REQUIRED integration suite', () => {
  assert.equal(
    REQUIRED_ITEST_SUITES['asep-suite:gate-fail-closed'],
    'scripts/integration/gate-fail-closed.itest.ts',
  );
  // And a run that never printed its marker is reported missing (→ RED).
  const missing = missingRequiredItestSuites('');
  assert.ok(
    missing.some((m: { id: string }) => m.id === 'asep-suite:gate-fail-closed'),
    'a dropped fail-closed suite turns the gate RED',
  );
});

// ---------------------------------------------------------------------------
// CI wiring fitness (disp. P2-FINAL-HIGH-001).
//
// The review's HIGH-001 was precisely that CI ran only `verify:all` — a shallow
// gate that never provisioned a backend — so real-backend claims were green by
// absence. A deep integration job now exists; these tests keep it MANDATORY.
// Deleting the job, gating it behind `if:`, or marking it continue-on-error
// would restore the exact defect, so each of those turns this suite RED.
// ---------------------------------------------------------------------------

const ciWorkflow = (): string =>
  readFileSync(join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');

// The `integration:` job block, i.e. from its key to the next top-level job key.
function integrationJobBlock(): string {
  const ci = ciWorkflow();
  const start = ci.indexOf('\n  integration:');
  assert.notEqual(start, -1, 'CI must declare a top-level `integration:` job');
  const rest = ci.slice(start + 1);
  const next = rest.search(/\n {2}\w[\w-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next);
}

test('CI declares a required integration job that runs the deep gate', () => {
  const block = integrationJobBlock();
  assert.match(
    block,
    /pnpm test:integration/,
    'the integration job must run the real-backend gate (pnpm test:integration)',
  );
});

test('the CI integration job is UNCONDITIONAL and cannot soft-fail', () => {
  const block = integrationJobBlock();
  // Strip comments: prose may legitimately mention these keys while explaining
  // why they are absent. Only real YAML keys matter.
  const yamlOnly = block
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
  assert.ok(
    !/^\s*continue-on-error:/m.test(yamlOnly),
    'integration must not be continue-on-error — its failure has to fail CI',
  );
  assert.ok(
    !/^\s*if:/m.test(yamlOnly),
    'integration must not be conditional — a skipped deep gate is the HIGH-001 defect',
  );
});

test('the CI integration job asserts a real Docker daemon before running suites', () => {
  const block = integrationJobBlock();
  assert.match(block, /docker version/, 'the job proves docker exists rather than skipping');
  assert.match(
    block,
    /--network none/,
    'the job proves the sandbox can run network-isolated before trusting F4',
  );
});

// ---------------------------------------------------------------------------
// The gate builds what the itests import. Each workspace package's `main` is
// its dist/, so a checkout that was never built has nothing to import, and one
// built before its last change would be tested as it was. The gate runs
// `tsc -b` first; these tests hold it to that on a project of their own.
// ---------------------------------------------------------------------------

const TSC = join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

function tinyProject(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'asep-itest-build-'));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      composite: true, rootDir: 'src', outDir: 'dist', module: 'nodenext', target: 'es2022', strict: true, types: [],
    },
    include: ['src'],
  }));
  writeFileSync(join(dir, 'src', 'index.ts'), source);
  return dir;
}

test('the gate build brings out-of-date output up to date, so no suite runs against older output', () => {
  const dir = tinyProject('export const answer: number = 1;\n');
  try {
    assert.equal(buildWorkspace(dir, TSC), undefined);
    assert.match(readFileSync(join(dir, 'dist', 'index.js'), 'utf8'), /answer = 1/, 'a checkout never built is built');
    writeFileSync(join(dir, 'src', 'index.ts'), 'export const answer: number = 2;\n');
    assert.equal(buildWorkspace(dir, TSC), undefined);
    assert.match(readFileSync(join(dir, 'dist', 'index.js'), 'utf8'), /answer = 2/, 'a stale build is rebuilt');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a build that fails, or a compiler that cannot run, fails the gate by name', () => {
  const dir = tinyProject('export const answer: number = "no";\n');
  try {
    // tsc still emits on a type error; the exit status is what fails the gate.
    const failed = buildWorkspace(dir, TSC) ?? '';
    assert.match(failed, /^the workspace build failed \(tsc -b, exit 2\)/);
    assert.match(failed, /TS2322/, 'the compiler output is in the reason');
    assert.match(buildWorkspace(dir, join(dir, 'no-such-tsc')) ?? '', /^the workspace build failed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the gate builds before it starts a backend or runs a suite, and stops on a failed build', () => {
  const src = readFileSync(join(HERE, 'run-integration.mjs'), 'utf8');
  const build = src.indexOf('const buildFailure = buildWorkspace(REPO_ROOT);');
  assert.notEqual(build, -1, 'the gate builds the workspace');
  assert.ok(build < src.indexOf('runContainer(docker.bin'), 'it builds before any backend starts');
  assert.ok(build < src.indexOf('nodeTestArgs(files)'), 'it builds before any suite runs');
  assert.match(src.slice(build), /^const buildFailure = buildWorkspace\(REPO_ROOT\);\n\s*if \(buildFailure\) return fail\(buildFailure\);/,
    'a failed build fails the gate');
});

// The agent network's isolated gateway mode needs Docker Engine 28.0.0 or
// later. An older engine fails the gate by name, not a suite part way through.
test('the gate refuses a Docker Engine older than the isolated gateway mode needs, or one it cannot read', () => {
  assert.equal(MIN_DOCKER_ENGINE, '28.0.0');
  for (const v of ['28.0.0', '28.0.4', '28.0.4+dfsg1', '29.6.1', '100.0.0']) assert.equal(engineVersionGap(v), undefined, v);
  for (const v of ['27.5.1', '27.99.99', '20.10.24']) {
    assert.match(engineVersionGap(v) ?? '', /^Docker Engine .* is older than 28\.0\.0/, v);
  }
  for (const v of ['', 'garbage', '28']) assert.match(engineVersionGap(v) ?? '', /^cannot read the Docker Engine version/, v);
  const src = readFileSync(join(HERE, 'run-integration.mjs'), 'utf8');
  const check = src.indexOf('const engineGap = engineVersionGap(docker.serverVersion);');
  assert.notEqual(check, -1, 'the gate checks the engine it found');
  assert.ok(check < src.indexOf('runContainer(docker.bin'), 'before any backend starts');
  assert.match(src.slice(check), /^const engineGap = engineVersionGap\(docker\.serverVersion\);\n\s*if \(engineGap\) return fail\(engineGap\);/);
});
