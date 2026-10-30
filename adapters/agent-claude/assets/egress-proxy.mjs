// ASEP model egress proxy. Runs in its own container, one per agent attempt.
//
// The agent container sits on an INTERNAL Docker network: no gateway, no route
// out, no external DNS. Its only reachable peer is this proxy, which is also
// attached to the egress network. So this file is the whole of the agent's
// outbound reach, and it allows exactly one thing: the model API.
//
//   * Requests are forwarded ONLY to the configured upstream origin, and ONLY
//     for the allowlisted method + path pairs below. Everything else is 403.
//   * Absolute-form requests (`GET http://elsewhere/`) and CONNECT tunnels are
//     refused, so the proxy cannot be used as a general forward proxy.
//   * Upgrades (websockets) are refused.
//   * The model credential arrives on STDIN, never in argv or the container
//     environment (both are visible to `docker inspect` / `ps`). The agent only
//     ever holds a placeholder: whatever x-api-key / Authorization it sends is
//     discarded and replaced here.
//   * Logs carry method, path and status only — never headers or bodies.
//   * Its lifetime is its own, not its starter's. It is given an absolute expiry
//     (`--expires-at`, epoch milliseconds): from then on it refuses every
//     request, and it exits. And stdin is its link to whoever started it: the
//     credential is the first line, and stdin then stays open for as long as
//     the starter keeps it open. When stdin closes — the starter ended it, or
//     died and the operating system closed it — the proxy exits at once. So the
//     credential it holds is not usable past the attempt's deadline (plus a
//     grace), nor past the link to its starter, whichever ends first, and
//     nothing has to be alive to take it back.
//
// Usage: node egress-proxy.mjs --listen <host:port> --upstream <origin> --expires-at <epoch ms>
// Prints `asep-egress-proxy listening <port>` on stdout once it accepts traffic.

import { realpathSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const ALLOWED = [
  { method: 'POST', path: '/v1/messages' },
  { method: 'POST', path: '/v1/messages/count_tokens' },
];

// Request headers never forwarded upstream: hop-by-hop headers, the client's
// idea of the host, and every credential the agent might have set.
const DROP_REQUEST = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade',
  'host', 'x-api-key', 'authorization', 'cookie',
]);
const DROP_RESPONSE = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-connection',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'set-cookie',
]);

// The longest single timer Node keeps; a longer lifetime is waited out in steps.
const MAX_TIMER_MS = 2 ** 31 - 1;

function accessLog(method, path, status) {
  process.stderr.write(`${new Date().toISOString()} ${method} ${path} -> ${status}\n`);
}

function refuse(res, method, path, why, log) {
  const body = JSON.stringify({
    type: 'error',
    error: { type: 'forbidden', message: `asep egress proxy: ${why}` },
  });
  res.writeHead(403, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
  log(method, path, 403);
}

/**
 * The proxy's request handling, without its process: an HTTP server that
 * forwards the allowlisted model API calls to `upstream` with `apiKey`, and
 * refuses everything else — and everything at all once `now()` has reached
 * `expiresAt`, even if the clock is later set back. The clock is a parameter
 * so that a test can run it on virtual time.
 */
export function egressProxy({ upstream, apiKey, expiresAt, now = () => Date.now(), log = accessLog }) {
  const target = new URL(upstream);
  if (target.protocol !== 'https:' && target.protocol !== 'http:') throw new Error('upstream must be http(s)');
  const basePath = target.pathname.replace(/\/+$/, '');
  const transport = target.protocol === 'https:' ? https : http;
  let expired = false;
  const serving = () => {
    if (!expired && now() >= expiresAt) expired = true;
    return !expired;
  };

  const server = http.createServer((req, res) => {
    const method = req.method ?? 'GET';
    const raw = req.url ?? '';
    if (!serving()) {
      refuse(res, method, raw.startsWith('/') ? raw.split('?')[0] : '(absolute-form)', 'no longer serving: its lifetime ended', log);
      req.resume();
      return;
    }
    // Origin-form only. `http://x/…` (absolute-form) would make this a forward
    // proxy to anywhere; `*` and other forms have no business here either.
    if (!raw.startsWith('/')) {
      refuse(res, method, '(absolute-form)', 'only origin-form requests are accepted', log);
      req.resume();
      return;
    }
    const url = new URL(raw, 'http://proxy.invalid');
    const path = url.pathname;
    if (!ALLOWED.some((a) => a.method === method && a.path === path)) {
      refuse(res, method, path, `${method} ${path} is not allowlisted`, log);
      req.resume();
      return;
    }

    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v !== undefined && !DROP_REQUEST.has(k.toLowerCase())) headers[k] = v;
    }
    headers['host'] = target.host;
    headers['x-api-key'] = apiKey;

    const out = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      method,
      path: `${basePath}${path}${url.search}`,
      headers,
    }, (up) => {
      const back = {};
      for (const [k, v] of Object.entries(up.headers)) {
        if (v !== undefined && !DROP_RESPONSE.has(k.toLowerCase())) back[k] = v;
      }
      res.writeHead(up.statusCode ?? 502, back);
      up.pipe(res);
      up.on('end', () => log(method, path, up.statusCode ?? 502));
    });
    out.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'bad_gateway', message: 'asep egress proxy: upstream unreachable' } }));
      } else {
        res.destroy();
      }
      log(method, path, 502);
    });
    req.pipe(out);
  });

  // A CONNECT tunnel would carry arbitrary TLS to arbitrary hosts.
  server.on('connect', (req, socket) => {
    socket.end('HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n');
    log('CONNECT', '(tunnel)', 403);
  });
  server.on('upgrade', (req, socket) => {
    socket.end('HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n');
    log(req.method ?? 'GET', '(upgrade)', 403);
  });

  return server;
}

// --- the process ------------------------------------------------------------------

function arg(name) {
  const i = process.argv.indexOf(name);
  if (i < 0 || i + 1 >= process.argv.length) {
    process.stderr.write(`asep-egress-proxy: missing ${name}\n`);
    process.exit(2);
  }
  return process.argv[i + 1];
}

// Stdin: the credential, its first line, and then the link to the starter (see
// the header). Resolves with the credential, or with undefined when stdin
// closes before a whole line arrived; calls `closed` when it closes after.
function readStdin(closed) {
  return new Promise((resolve) => {
    let buf = '';
    let credential;
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => {
      if (credential !== undefined) return;
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl >= 0) {
        credential = buf.slice(0, nl).trim();
        buf = '';
        resolve(credential);
      }
    });
    const end = () => (credential === undefined ? resolve(undefined) : closed());
    for (const event of ['end', 'close', 'error']) process.stdin.on(event, end);
  });
}

async function main() {
  // Stopping is exiting: no request is taken after it, and whatever is in
  // flight is cut.
  const stop = (why) => {
    process.stderr.write(`asep-egress-proxy: stopping: ${why}\n`);
    process.exit(0);
  };
  const listen = arg('--listen');
  const upstream = arg('--upstream');
  if (!/^https?:$/.test(new URL(upstream).protocol)) {
    process.stderr.write('asep-egress-proxy: upstream must be http(s)\n');
    process.exit(2);
  }
  const expiresAt = Number(arg('--expires-at'));
  if (!Number.isSafeInteger(expiresAt)) {
    process.stderr.write('asep-egress-proxy: --expires-at must be epoch milliseconds\n');
    process.exit(2);
  }
  if (expiresAt <= Date.now()) {
    process.stderr.write('asep-egress-proxy: its lifetime has already ended — refusing to start\n');
    process.exit(2);
  }
  const apiKey = await readStdin(() => stop('its parent link closed'));
  if (apiKey === undefined) {
    process.stderr.write('asep-egress-proxy: stdin closed before a credential arrived — refusing to start\n');
    process.exit(2);
  }
  if (apiKey === '') {
    process.stderr.write('asep-egress-proxy: no credential on stdin — refusing to start\n');
    process.exit(2);
  }

  const server = egressProxy({ upstream, apiKey, expiresAt });

  // The lifetime: checked on every request, and acted on by a timer.
  const expire = () => {
    const left = expiresAt - Date.now();
    if (left <= 0) stop('its lifetime ended');
    else setTimeout(expire, Math.min(left, MAX_TIMER_MS));
  };
  expire();

  const sep = listen.lastIndexOf(':');
  const host = listen.slice(0, sep);
  const port = Number(listen.slice(sep + 1));
  server.listen(port, host, () => {
    process.stdout.write(`asep-egress-proxy listening ${server.address().port}\n`);
  });

  process.on('SIGTERM', () => stop('signalled'));
  process.on('SIGINT', () => stop('signalled'));
}

// Run as a program (in its container, or as a host process in tests); imported,
// it only provides egressProxy.
if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  await main();
}
