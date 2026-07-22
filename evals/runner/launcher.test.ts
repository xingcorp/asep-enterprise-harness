// Trusted-bootstrap launcher + adversarial-egress wiring test (P1-CYCLE4-MED-002).
//
// This suite proves the containment invariant the cycle-4 review demanded, by
// driving the REAL launcher (no stubs) through two launch shapes and asserting
// on the raw captured output:
//
//   CANONICAL launch (node --import <tsx> --import <preload> <adversarial-entry>):
//     - the preload attests (its OK line is in captured stderr);
//     - the adversarial fixture evaluated post-preload (its SENTINEL is present);
//     - enforceDeterminism() was active when the fixture's top-level captures ran
//       (verdict.enforcedAtEval === true);
//     - EVERY egress probe was blocked — ESM named-import capture (the exact
//       cycle-4 bypass), CJS require, constructor egress, microtask-deferred
//       reference, dynamic re-import, http/https/http2, dgram, DNS, global fetch,
//       and child_process / worker_threads escape;
//     - the child exits 0.
//
//   OMIT-PRELOAD launch (bootstrap-order regression):
//     - the launcher drops the determinism --import;
//     - attestation is ABSENT and the launcher refuses to trust the run;
//     - the adversarial fixture SENTINEL never prints (the entry failed closed in
//       assertDeterminismEnforced BEFORE dynamic-importing the fixture body);
//     - no ADVERSARIAL-RESULT verdict is emitted;
//     - the exit code is non-zero.
//
// Plus a canonical worker-entry launch (the real eval) that must produce the
// deterministic report and attest, and env-sanitization unit checks.

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  launchEval,
  sanitizedChildEnv,
  PRELOAD_ATTESTATION_PREFIX,
  WORKER_ENTRY_PATH,
} from './launcher.js';

// Machine-readable suite marker (P1-CYCLE4-MED-001): the canonical runner
// asserts this line is present so the trusted-bootstrap suite cannot be silently
// dropped from the canonical command.
console.log('SUITE-ID: asep-suite:trusted-bootstrap');

const HERE = dirname(fileURLToPath(import.meta.url));
const ADVERSARIAL_ENTRY = join(HERE, 'adversarial-entry.ts');
const SENTINEL = 'ADVERSARIAL-FIXTURE-BODY-EVALUATED';

interface Probe {
  readonly name: string;
  readonly blocked: boolean;
  readonly detail: string;
}
interface AdversarialVerdict {
  readonly enforcedAtEval: boolean;
  readonly allAttemptsBlocked: boolean;
  readonly probes: readonly Probe[];
}

function parseVerdict(stdout: string): AdversarialVerdict | null {
  const line = stdout.split('\n').find((l) => l.startsWith('ADVERSARIAL-RESULT:'));
  if (!line) return null;
  return JSON.parse(line.slice('ADVERSARIAL-RESULT:'.length)) as AdversarialVerdict;
}

// The full set of egress probes the honest fixture attempts. Asserting on this
// explicit list (not just "every probe blocked") means a fixture that silently
// DROPPED a probe — e.g. quietly stopped testing the ESM named-import path that
// was the actual bypass — fails this test instead of passing vacuously.
const REQUIRED_PROBES = [
  'esm-named:dgram.createSocket',
  'esm-named:net.connect',
  'esm-named:new net.Socket().connect',
  'esm-named:http.request',
  'cjs:require(dgram).createSocket',
  'cjs:require(net).connect',
  'ctor:new dns.Resolver().resolve4',
  'ctor:new net.Socket().connect',
  'default:http.request',
  'default:https.request',
  'default:http2.connect',
  'escape:child_process.spawn',
  'escape:worker_threads.Worker',
  'default:dns.lookup',
  'global.fetch',
  'microtask:deferred dgram',
  'dynamic-import:dgram.createSocket',
] as const;

test('CANONICAL launch: preload attests and the adversarial fixture evaluated post-preload', () => {
  const r = launchEval({ entryPath: ADVERSARIAL_ENTRY });
  assert.ok(
    r.stderr.includes(`${PRELOAD_ATTESTATION_PREFIX} `),
    `preload must attest in stderr:\n${r.stderr}`,
  );
  assert.equal(r.attested, true, 'launcher must report attested=true');
  assert.ok(
    r.stderr.includes(SENTINEL),
    `the adversarial fixture body must have evaluated (sentinel present):\n${r.stderr}`,
  );
  assert.equal(r.code, 0, `canonical adversarial launch must exit 0:\n${r.stderr}`);
});

test('CANONICAL launch: EVERY egress probe is blocked (incl. the ESM named-import cycle-4 bypass)', () => {
  const r = launchEval({ entryPath: ADVERSARIAL_ENTRY });
  const verdict = parseVerdict(r.stdout);
  assert.ok(verdict, `must emit a machine-readable verdict:\n${r.stdout}\n---\n${r.stderr}`);
  assert.equal(
    verdict!.enforcedAtEval,
    true,
    'determinism must have been enforced when the fixture captured its references',
  );

  // Every REQUIRED probe must be present AND blocked. Presence guards against a
  // fixture that quietly stopped exercising a path; blocked guards containment.
  const byName = new Map(verdict!.probes.map((p) => [p.name, p]));
  for (const name of REQUIRED_PROBES) {
    const p = byName.get(name);
    assert.ok(p, `required probe "${name}" was not attempted by the fixture`);
    assert.equal(p!.blocked, true, `egress probe "${name}" was NOT blocked (detail: ${p!.detail})`);
  }

  // And the aggregate flag agrees — no probe outside the required list slipped
  // through allowed either.
  assert.equal(
    verdict!.allAttemptsBlocked,
    true,
    `some egress probe was allowed: ${JSON.stringify(verdict!.probes.filter((p) => !p.blocked))}`,
  );
});

test('BOOTSTRAP-ORDER regression: omitting the preload fails closed BEFORE the fixture body runs', () => {
  const r = launchEval({ entryPath: ADVERSARIAL_ENTRY, omitPreload: true });

  // Attestation must be absent and the launcher must refuse to trust the run.
  assert.equal(r.attested, false, 'a run without the preload must NOT be attested');
  assert.notEqual(r.code, 0, 'an unattested run must not report success');

  // The fixture body must never have evaluated: no sentinel, no verdict. This is
  // the core ordering property — task-shaped code cannot run pre-preload.
  assert.ok(
    !r.stderr.includes(SENTINEL) && !r.stdout.includes(SENTINEL),
    `the fixture SENTINEL must be ABSENT when the preload was omitted:\nSTDOUT:${r.stdout}\nSTDERR:${r.stderr}`,
  );
  assert.equal(
    parseVerdict(r.stdout),
    null,
    'no adversarial verdict may be emitted when the entry failed closed',
  );

  // The failure must be the explicit fail-closed assertion, not an incidental crash.
  assert.ok(
    r.stderr.includes('determinism preload did NOT run before task load'),
    `the failure must be the explicit fail-closed guard:\n${r.stderr}`,
  );
});

test('CANONICAL worker-entry launch: produces the deterministic report and attests', () => {
  const r = launchEval(); // default entry = the real worker-entry
  assert.equal(r.attested, true, 'the real eval launch must attest');
  assert.equal(r.code, 0, `the eval must pass:\n${r.stderr}`);
  // The report is the stable JSON on stdout; two launches must be byte-identical.
  const second = launchEval();
  assert.equal(r.stdout, second.stdout, 'two canonical launches must be byte-identical (determinism)');
  const report = JSON.parse(r.stdout) as { failed: number; schema: string };
  assert.equal(report.failed, 0, 'no fixture may fail');
  assert.equal(report.schema, 'https://asep.dev/schema/eval-report/v1');
});

test('the canonical worker entry path is the real worker-entry module', () => {
  assert.ok(WORKER_ENTRY_PATH.endsWith('worker-entry.ts'), WORKER_ENTRY_PATH);
});

// ---- Environment sanitization (unit) ---------------------------------------

test('sanitizedChildEnv strips NODE_OPTIONS and pre-main injection vectors', () => {
  const dirty = {
    PATH: '/usr/bin',
    NODE_OPTIONS: '--require /tmp/evil.js --inspect=0.0.0.0:9229',
    node_options: '--import file:///tmp/evil.mjs', // odd-cased smuggling
    NODE_REPL_EXTERNAL_MODULE: '/tmp/evil.js',
    NODE_INSPECT_RESUME_ON_START: '1',
    SAFE_VAR: 'keepme',
  } as unknown as NodeJS.ProcessEnv;
  const clean = sanitizedChildEnv(dirty);
  assert.equal(clean.NODE_OPTIONS, undefined, 'NODE_OPTIONS must be stripped');
  assert.equal(clean.node_options, undefined, 'case-variant NODE_OPTIONS must be stripped');
  assert.equal(clean.NODE_REPL_EXTERNAL_MODULE, undefined);
  assert.equal(clean.NODE_INSPECT_RESUME_ON_START, undefined);
  assert.equal(clean.SAFE_VAR, 'keepme', 'unrelated vars are preserved');
  assert.equal(clean.PATH, '/usr/bin');
  // Locale/timezone are pinned for the child.
  assert.equal(clean.TZ, 'UTC');
  assert.equal(clean.LANG, 'C');
  assert.equal(clean.LC_ALL, 'C');
});
