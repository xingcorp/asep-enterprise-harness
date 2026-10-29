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
//
// Usage: node egress-proxy.mjs --listen <host:port> --upstream <origin>
// Prints `asep-egress-proxy listening <port>` on stdout once it accepts traffic.

import http from 'node:http';
import https from 'node:https';

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

function arg(name) {
  const i = process.argv.indexOf(name);
  if (i < 0 || i + 1 >= process.argv.length) {
    process.stderr.write(`asep-egress-proxy: missing ${name}\n`);
    process.exit(2);
  }
  return process.argv[i + 1];
}

function log(method, path, status) {
  process.stderr.write(`${new Date().toISOString()} ${method} ${path} -> ${status}\n`);
}

function readCredential() {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { buf += d; });
    process.stdin.on('end', () => resolve(buf.split('\n')[0].trim()));
    process.stdin.on('error', reject);
  });
}

function refuse(res, method, path, why) {
  const body = JSON.stringify({
    type: 'error',
    error: { type: 'forbidden', message: `asep egress proxy: ${why}` },
  });
  res.writeHead(403, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
  log(method, path, 403);
}

const listen = arg('--listen');
const upstream = new URL(arg('--upstream'));
if (upstream.protocol !== 'https:' && upstream.protocol !== 'http:') {
  process.stderr.write('asep-egress-proxy: upstream must be http(s)\n');
  process.exit(2);
}
const basePath = upstream.pathname.replace(/\/+$/, '');
const transport = upstream.protocol === 'https:' ? https : http;

const apiKey = await readCredential();
if (apiKey === '') {
  process.stderr.write('asep-egress-proxy: no credential on stdin — refusing to start\n');
  process.exit(2);
}

const server = http.createServer((req, res) => {
  const method = req.method ?? 'GET';
  const raw = req.url ?? '';
  // Origin-form only. `http://x/…` (absolute-form) would make this a forward
  // proxy to anywhere; `*` and other forms have no business here either.
  if (!raw.startsWith('/')) {
    refuse(res, method, '(absolute-form)', 'only origin-form requests are accepted');
    req.resume();
    return;
  }
  const url = new URL(raw, 'http://proxy.invalid');
  const path = url.pathname;
  if (!ALLOWED.some((a) => a.method === method && a.path === path)) {
    refuse(res, method, path, `${method} ${path} is not allowlisted`);
    req.resume();
    return;
  }

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v !== undefined && !DROP_REQUEST.has(k.toLowerCase())) headers[k] = v;
  }
  headers['host'] = upstream.host;
  headers['x-api-key'] = apiKey;

  const out = transport.request({
    protocol: upstream.protocol,
    hostname: upstream.hostname,
    port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
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

const sep = listen.lastIndexOf(':');
const host = listen.slice(0, sep);
const port = Number(listen.slice(sep + 1));
server.listen(port, host, () => {
  process.stdout.write(`asep-egress-proxy listening ${server.address().port}\n`);
});

const stop = () => server.close(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
