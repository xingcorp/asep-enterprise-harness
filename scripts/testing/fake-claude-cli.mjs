#!/usr/bin/env node
// A STRICT stand-in for the pinned `claude` CLI (2.1.286), for tests only.
//
// It accepts exactly the flags the real CLI accepts that the provider uses,
// with the real arity, choice validation and error wording, and fails the way
// the real CLI fails: an unknown option, stream-json without --verbose, or no
// prompt on stdin are refused. So a provider that invents a flag, or puts the
// prompt anywhere but stdin, fails against this fake exactly as it would
// against the real binary.
//
// Its events are the real stream-json shapes (captured from the real CLI):
// system/init, assistant, user, result.
//
// The scenario comes from FAKE_CLAUDE_SCENARIO, which a per-scenario shim sets
// INSIDE the container — the provider controls the container environment, so
// it cannot be passed from the test through the provider.

import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import http from 'node:http';
import net from 'node:net';
import dns from 'node:dns';
import { networkInterfaces } from 'node:os';

const VERSION = process.env.FAKE_CLAUDE_VERSION ?? '2.1.286';
const SCENARIO = process.env.FAKE_CLAUDE_SCENARIO ?? 'ok';

const BOOLEAN = new Set([
  '-p', '--print', '--bare', '--verbose', '--strict-mcp-config', '--disable-slash-commands',
  '--no-session-persistence',
]);
const VALUED = new Set([
  '--output-format', '--model', '--max-turns', '--max-budget-usd', '--permission-mode',
  '--permission-prompts', '--setting-sources',
]);
const VARIADIC = new Set(['--tools', '--allowedTools', '--disallowedTools', '--add-dir']);
const CHOICES = {
  '--output-format': ['text', 'json', 'stream-json'],
  '--permission-mode': ['acceptEdits', 'auto', 'bypassPermissions', 'default', 'dontAsk', 'plan'],
  '--permission-prompts': ['host', 'none'],
};
const ARG_NAMES = {
  '--output-format': '<format>', '--permission-mode': '<mode>', '--permission-prompts': '<target>',
};

function die(msg, code = 1) {
  process.stderr.write(`${msg}\n`);
  process.exit(code);
}

// --- argv, parsed the way commander parses it ---------------------------------
const opts = {};
const positional = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--version' || a === '-v') {
    process.stdout.write(`${VERSION} (Claude Code)\n`);
    process.exit(0);
  }
  if (!a.startsWith('-')) {
    positional.push(a);
    continue;
  }
  const [flag, inline] = a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
  if (BOOLEAN.has(flag)) {
    opts[flag === '--print' ? '-p' : flag] = true;
  } else if (VALUED.has(flag)) {
    const v = inline ?? argv[++i];
    if (v === undefined) die(`error: option '${flag} ${ARG_NAMES[flag] ?? '<value>'}' argument missing`);
    if (CHOICES[flag] && !CHOICES[flag].includes(v)) {
      die(`error: option '${flag} ${ARG_NAMES[flag]}' argument '${v}' is invalid. Allowed choices are ${CHOICES[flag].join(', ')}.`);
    }
    opts[flag] = v;
  } else if (VARIADIC.has(flag)) {
    const vals = inline !== undefined ? [inline] : [];
    while (inline === undefined && i + 1 < argv.length && !argv[i + 1].startsWith('-')) vals.push(argv[++i]);
    if (vals.length === 0) die(`error: option '${flag} <values...>' argument missing`);
    opts[flag] = [...(opts[flag] ?? []), ...vals];
  } else {
    die(`error: unknown option '${flag}'`);
  }
}
if (!opts['-p']) die('fake claude: only --print mode is emulated', 2);
if (opts['--output-format'] === 'stream-json' && !opts['--verbose']) {
  die('Error: When using --print, --output-format=stream-json requires --verbose');
}
const list = (k) => (opts[k] ?? []).flatMap((v) => v.split(/[,\s]+/)).filter((s) => s !== '');

// --- the prompt: stdin, or the positional argument ------------------------------
let stdinText = '';
try {
  stdinText = readFileSync(0, 'utf8');
} catch {
  stdinText = '';
}
const promptChannel = positional.length > 0 ? 'argv' : 'stdin';
const prompt = positional.length > 0 ? positional.join(' ') : stdinText;
if (prompt.trim() === '') {
  die('Error: Input must be provided either through stdin or as a prompt argument when using --print');
}

// --- real-shaped events ------------------------------------------------------------
const sessionId = SCENARIO === 'tagged' ? `sess-${basename(process.cwd())}` : randomUUID();
const model = opts['--model'] ?? 'claude-default';
const grantedTools = list('--tools');
const started = Date.now();
let turns = 0;
const emit = (ev) => process.stdout.write(`${JSON.stringify(ev)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function init(over = {}) {
  emit({
    type: 'system', subtype: 'init', cwd: process.cwd(), session_id: sessionId,
    tools: grantedTools, mcp_servers: [], model,
    permissionMode: opts['--permission-mode'] ?? 'auto', slash_commands: [],
    apiKeySource: 'ANTHROPIC_API_KEY', claude_code_version: VERSION, output_style: 'default',
    agents: [], skills: [], plugins: [], uuid: randomUUID(), analytics_disabled: true,
    ...over,
  });
}
function assistant(content) {
  turns++;
  emit({
    type: 'assistant',
    message: {
      id: `msg_${turns}`, type: 'message', role: 'assistant', model, content,
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 11, output_tokens: 1 },
    },
    parent_tool_use_id: null, session_id: sessionId, uuid: randomUUID(), timestamp: new Date().toISOString(),
  });
}
function toolResult(id, content) {
  emit({
    type: 'user', message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content }] },
    parent_tool_use_id: null, session_id: sessionId, uuid: randomUUID(), timestamp: new Date().toISOString(),
  });
}
function result(over = {}) {
  emit({
    type: 'result', subtype: 'success', is_error: false, api_error_status: null,
    duration_ms: Date.now() - started, duration_api_ms: 5, num_turns: Math.max(turns, 1),
    result: 'did the thing', stop_reason: 'end_turn', session_id: sessionId,
    total_cost_usd: 0.0123,
    usage: {
      input_tokens: 20, cache_creation_input_tokens: 3, cache_read_input_tokens: 2, output_tokens: 7,
    },
    modelUsage: {}, permission_denials: [], terminal_reason: 'completed', uuid: randomUUID(),
    ...over,
  });
}

function inputsFromPrompt() {
  const wo = /work order is (\S+) \(sha256 ([0-9a-f]{64})\)/.exec(prompt);
  const cp = /context pack is (\S+) \(sha256 ([0-9a-f]{64})\)/.exec(prompt);
  return { workOrder: wo && { path: wo[1], sha256: wo[2] }, contextPack: cp && { path: cp[1], sha256: cp[2] } };
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function attempt(fn) {
  try {
    return fn();
  } catch (e) {
    return `error:${e.code ?? e.message}`;
  }
}

function tcpProbe(host, port, ms = 3000) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(ms, () => done('timeout'));
    s.on('connect', () => done('connected'));
    s.on('error', (e) => done(`error:${e.code ?? e.message}`));
  });
}

// The first host address of this container's IPv4 subnet: where the host's
// address on the bridge would be (Docker gives the gateway the first address).
function wouldBeGateway() {
  const v4 = Object.values(networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal);
  if (!v4) return null;
  const toInt = (ip) => ip.split('.').reduce((n, o) => ((n << 8) | Number(o)) >>> 0, 0);
  const first = ((toInt(v4.address) & toInt(v4.netmask)) + 1) >>> 0;
  return [24, 16, 8, 0].map((sh) => (first >>> sh) & 255).join('.');
}

// Every IPv6 address this container holds other than loopback.
function ipv6Addresses() {
  return Object.values(networkInterfaces()).flat()
    .filter((a) => a && a.family === 'IPv6' && !a.internal).map((a) => a.address);
}

function directDns(server, name, ms = 4000) {
  return new Promise((resolve) => {
    const r = new dns.Resolver({ timeout: ms, tries: 1 });
    r.setServers([server]);
    r.resolve4(name, (e, a) => resolve(e ? `error:${e.code}` : `resolved:${a.join(',')}`));
  });
}

function rawHttp(base, requestText, ms = 5000) {
  return new Promise((resolve) => {
    const u = new URL(base);
    const s = net.connect({ host: u.hostname, port: Number(u.port || 80) });
    let out = '';
    s.setTimeout(ms, () => { s.destroy(); resolve('timeout'); });
    s.on('connect', () => s.write(requestText));
    s.on('data', (d) => { out += d.toString('utf8'); });
    s.on('end', () => resolve(out.split('\r\n')[0]));
    s.on('close', () => resolve(out.split('\r\n')[0] || 'closed'));
    s.on('error', (e) => resolve(`error:${e.code ?? e.message}`));
  });
}

function modelCall(path = '/v1/messages?beta=true', method = 'POST') {
  return new Promise((resolve) => {
    const u = new URL(path, process.env.ANTHROPIC_BASE_URL);
    const body = JSON.stringify({ model, max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] });
    const req = http.request(u, {
      method,
      headers: {
        'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
        'x-api-key': process.env.ANTHROPIC_API_KEY ?? '', 'anthropic-version': '2023-06-01',
      },
    }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: text }));
    });
    req.setTimeout(5000, () => { req.destroy(); resolve({ status: 'timeout' }); });
    req.on('error', (e) => resolve({ status: `error:${e.code ?? e.message}` }));
    req.end(body);
  });
}

// Reads the work order and, for an `add <file>` objective, writes the file.
function workTheOrder() {
  const { workOrder } = inputsFromPrompt();
  if (!workOrder) {
    result({ subtype: 'error_during_execution', is_error: true, result: 'no work order in the prompt' });
    process.exit(1);
  }
  const bytes = readFileSync(workOrder.path);
  assistant([{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: workOrder.path } }]);
  toolResult('toolu_1', bytes.toString('utf8'));
  if (sha256(bytes) !== workOrder.sha256) {
    result({ subtype: 'error_during_execution', is_error: true, result: 'work order hash mismatch' });
    process.exit(1);
  }
  let objective = '';
  try {
    objective = String(JSON.parse(bytes.toString('utf8')).objective ?? '');
  } catch { /* not JSON */ }
  const add = /^add (\S+)$/.exec(objective);
  if (add) {
    writeFileSync(join(process.cwd(), add[1]), 'written by the fake claude CLI\n');
    assistant([{ type: 'tool_use', id: 'toolu_2', name: 'Edit', input: { file_path: add[1] } }]);
    toolResult('toolu_2', 'ok');
  }
  assistant([{ type: 'text', text: 'did the thing' }]);
  result();
}

async function main() {
  switch (SCENARIO) {
    case 'ok':
      init();
      workTheOrder();
      return;
    case 'ok-model': {
      // Asks the model first, through ANTHROPIC_BASE_URL, as the real CLI does.
      init();
      const r = await modelCall();
      if (r.status !== 200) {
        result({ subtype: 'error_during_execution', is_error: true, result: `model call failed: ${r.status}` });
        process.exit(1);
      }
      workTheOrder();
      return;
    }
    case 'echo': {
      init();
      const keys = Object.keys(process.env).sort();
      result({
        result: JSON.stringify({
          argv, promptChannel, prompt, cwd: process.cwd(), envKeys: keys,
          env: Object.fromEntries(keys.map((k) => [k, process.env[k]])),
        }),
      });
      return;
    }
    case 'malformed':
      init();
      emit({ type: 'bogus', x: 1 });
      await sleep(5_000);
      return;
    case 'notjson':
      init();
      process.stdout.write('this is not json at all\n');
      await sleep(5_000);
      return;
    case 'partial':
      init();
      assistant([{ type: 'text', text: 'starting' }]);
      return;
    case 'truncated':
      init();
      process.stdout.write('{"type":"result","subtype":"succ');
      return;
    case 'nonzero':
      process.stderr.write('API Error: 401 {"type":"error","error":{"type":"authentication_error"}}\n');
      process.exit(1);
      return;
    case 'quota':
      init();
      result({
        is_error: true, api_error_status: 429, total_cost_usd: 0, stop_reason: null,
        result: 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"quota exceeded"}}',
      });
      process.exit(1);
      return;
    case 'hang':
      init();
      await sleep(10 * 60_000);
      return;
    case 'max-turns':
      init();
      assistant([{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'a.txt' } }]);
      toolResult('toolu_1', 'x');
      result({ subtype: 'error_max_turns', is_error: true, result: undefined, terminal_reason: 'max_turns', stop_reason: 'tool_use' });
      process.exit(1);
      return;
    case 'max-budget':
      init();
      result({ subtype: 'error_max_budget_usd', is_error: true, result: undefined, terminal_reason: 'max_budget_usd' });
      process.exit(1);
      return;
    case 'tool-flood':
      init();
      for (let n = 1; n <= 50; n++) {
        assistant([{ type: 'tool_use', id: `toolu_${n}`, name: 'Read', input: { file_path: 'a.txt' } }]);
        toolResult(`toolu_${n}`, 'x');
        await sleep(20);
      }
      await sleep(10 * 60_000);
      return;
    case 'version-drift':
      init({ claude_code_version: '9.9.9' });
      await sleep(10 * 60_000);
      return;
    case 'model-fallback':
      init();
      emit({ type: 'system', subtype: 'model_fallback', from: model, to: 'claude-cheaper', session_id: sessionId, uuid: randomUUID() });
      result();
      return;
    case 'extra-tool':
      init({ tools: [...grantedTools, 'Bash'] });
      await sleep(10 * 60_000);
      return;
    case 'mcp':
      init({ mcp_servers: [{ name: 'smuggled', status: 'connected' }] });
      await sleep(10 * 60_000);
      return;
    case 'wrong-cwd':
      init({ cwd: '/somewhere/else' });
      await sleep(10 * 60_000);
      return;
    case 'notices':
      init();
      emit({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 500, error_status: 529, error: 'overloaded', session_id: sessionId, uuid: randomUUID() });
      emit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' }, session_id: sessionId, uuid: randomUUID() });
      emit({ type: 'system', subtype: 'status', status: 'requesting', session_id: sessionId, uuid: randomUUID() });
      result();
      return;
    case 'denied':
      init();
      result({ permission_denials: [{ tool_name: 'Bash', tool_use_id: 'toolu_9', tool_input: { command: 'git push' } }] });
      return;
    case 'claims-commit':
      init();
      result({ result: 'I committed abcdef and pushed to main' });
      return;
    case 'tagged':
      await sleep(60);
      init();
      result({ result: `tag=${basename(process.cwd())}` });
      return;
    case 'costly':
      init();
      result({ total_cost_usd: 5 });
      return;
    case 'after-result':
      init();
      result();
      emit({ type: 'assistant', message: { content: [] }, session_id: sessionId });
      return;
    case 'session-mismatch':
      init();
      emit({ type: 'user', message: { role: 'user', content: [] }, session_id: 'someone-else' });
      result();
      return;
    case 'model-call': {
      // Calls the model API through ANTHROPIC_BASE_URL and reports what came back.
      init();
      const r = await modelCall();
      result({ result: JSON.stringify(r) });
      return;
    }
    case 'canary': {
      // Probes the container's reach. Run under real Docker by the sandbox
      // integration suite; the targets come from the work order.
      init();
      const { workOrder, contextPack } = inputsFromPrompt();
      const order = JSON.parse(readFileSync(workOrder.path, 'utf8'));
      const t = order.canary ?? {};
      const base = process.env.ANTHROPIC_BASE_URL;
      const proxy = new URL(base);
      const report = {
        inputs: {
          workOrderSha256Matches: sha256(readFileSync(workOrder.path)) === workOrder.sha256,
          contextPackSha256Matches: sha256(readFileSync(contextPack.path)) === contextPack.sha256,
          writeWorkOrder: attempt(() => { writeFileSync(workOrder.path, 'tampered'); return 'written'; }),
          writeInputDir: attempt(() => { writeFileSync(join(workOrder.path, '..', 'new-file'), 'x'); return 'written'; }),
          // The owner may chmod its own file on a writable mount; only a
          // read-only bind refuses it (EROFS), whatever the file mode.
          chmodWorkOrder: attempt(() => { chmodSync(workOrder.path, 0o666); return 'changed'; }),
        },
        worktree: {
          writeFile: attempt(() => { writeFileSync(join(process.cwd(), 'agent-wrote.txt'), 'x'); return 'written'; }),
          writeGitIndirection: attempt(() => { writeFileSync(join(process.cwd(), '.git'), 'gitdir: /tmp/evil'); return 'written'; }),
          chmodGitIndirection: attempt(() => { chmodSync(join(process.cwd(), '.git'), 0o666); return 'changed'; }),
          // The gitdir the indirection names lives in the host mirror, which is
          // never mounted.
          gitdirVisible: attempt(() => {
            const target = /gitdir: (.*)/.exec(readFileSync(join(process.cwd(), '.git'), 'utf8'))?.[1]?.trim();
            return target && existsSync(target) ? 'visible' : 'absent';
          }),
        },
        rootfs: attempt(() => { writeFileSync('/etc/asep-canary', 'x'); return 'written'; }),
        direct: await tcpProbe(t.directIp ?? '1.1.1.1', t.directPort ?? 80),
        upstreamDirect: t.upstreamIp ? await tcpProbe(t.upstreamIp, t.upstreamPort ?? 8080) : 'skipped',
        dns: await new Promise((r) => dns.lookup(t.dnsName ?? 'example.com', (e, a) => r(e ? `error:${e.code}` : `resolved:${a}`))),
        // A public resolver asked directly, past the embedded one.
        dnsDirect: await directDns(t.dnsServer ?? '1.1.1.1', t.dnsName ?? 'example.com'),
        // The host and its services: the would-be bridge gateway and every host
        // address the test names, on every host port it names.
        gateway: wouldBeGateway(),
        hostReach: await (async () => {
          const out = {};
          const hosts = [wouldBeGateway(), ...(t.hostAddresses ?? [])].filter(Boolean);
          for (const h of hosts) {
            for (const port of t.hostPorts ?? []) out[`${h}:${port}`] = await tcpProbe(h, port, 2000);
          }
          return out;
        })(),
        hostDockerInternal: await new Promise((r) => dns.lookup('host.docker.internal', (e, a) => r(e ? `error:${e.code}` : `resolved:${a}`))),
        ipv6: {
          addresses: ipv6Addresses(),
          publicProbe: await tcpProbe(t.directIpv6 ?? '2606:4700:4700::1111', 80, 2000),
        },
        proxyAbsoluteForm: await rawHttp(base, `GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n`),
        proxyConnect: await rawHttp(base, `CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n`),
        proxyOtherPath: (await modelCall('/v1/models', 'GET')).status,
        proxyHost: proxy.hostname,
        model: await modelCall(),
        env: Object.fromEntries(Object.keys(process.env).sort().map((k) => [k, process.env[k]])),
        uid: typeof process.getuid === 'function' ? process.getuid() : null,
      };
      result({ result: JSON.stringify(report) });
      return;
    }
    default:
      die(`fake claude: unknown scenario '${SCENARIO}'`, 2);
  }
}

await main();
