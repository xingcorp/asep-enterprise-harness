// How every Node process that runs tests is started.
//
// --no-wasm-code-gc. Node 24's V8 can abort while it frees a wasm import
// wrapper: "# Fatal error ... Check failed: end > addr.", native stack
// ThreadIsolation::LookupJitPage <- UnregisterWasmAllocation <-
// WasmCodeAllocator::FreeCode <- WasmImportWrapperCache::Free. That is
// nodejs/node#66366, fixed upstream in V8 (9b8ca54d5a, 68210d500a) but not in
// Node 24.x as of 2026-10-23. Our wasm user is PGlite, and the abort took whole
// test files down under machine load. Turning wasm code GC off is the
// workaround the upstream report measured at zero crashes. Revisit when a 24.x
// release carries the V8 fix or the project moves to Node 26.
//
// The flag cannot be set through NODE_OPTIONS (Node refuses it there), so it is
// passed on the command line. `node --test` starts every test file in a child
// process with the parent's execArgv, so the children carry it too;
// scripts/node-test-flags.test.ts checks both, and that every test entry point
// of the repository passes it.
//
// A test that spawns a Node process of its own decides that process's flags.
// Any such child that loads PGlite must carry NODE_TEST_V8_FLAGS. None does
// today. Of the Node children tests spawn, only the executor that
// crash-takeover.itest.ts SIGKILLs runs harness code, and it runs against the
// integration gate's real PostgreSQL, never PGlite, and registers no tests; the
// others (the egress proxy, the fake model API, the fake docker client) load no
// PGlite.

/** V8 flags for every Node process that runs tests. */
export const NODE_TEST_V8_FLAGS = Object.freeze(['--no-wasm-code-gc']);

/**
 * The argv after `node` for running `files` with the test runner under tsx.
 * `concurrency` bounds how many test files run at once (omitted: Node's
 * default).
 */
export function nodeTestArgs(files, { concurrency } = {}) {
  return [
    ...NODE_TEST_V8_FLAGS,
    '--import', 'tsx',
    ...(concurrency === undefined ? [] : [`--test-concurrency=${concurrency}`]),
    '--test',
    ...files,
  ];
}
