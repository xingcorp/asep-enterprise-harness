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
//   * Its lifetime is its own, not its starter's. It is given a relative
//     lifetime (`--lifetime-ms`), at most MAX_LIFETIME_MS, and counts it on its
//     own monotonic clock from its own start: one deadline, fixed once, that no
//     change to the wall clock moves. From that deadline on it admits no
//     request, forwards no further byte of one in flight, destroys every open
//     connection, and exits. And stdin is its link to whoever started it: the
//     credential is the first line, and stdin then stays open for as long as
//     the starter keeps it open. When stdin closes — the starter ended it, or
//     died and the operating system closed it — the proxy exits at once. So the
//     credential it holds is not usable past its lifetime, nor past the link to
//     its starter, whichever ends first, and nothing has to be alive to take it
//     back.
//
// Usage: node egress-proxy.mjs --listen <host:port> --upstream <origin> --lifetime-ms <ms>
// Prints `asep-egress-proxy listening <port>` on stdout once it accepts traffic.

import { realpathSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { performance } from 'node:perf_hooks';
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

/**
 * The longest lifetime the proxy accepts: four hours. A longer one is refused
 * at start, so no argument keeps a credential usable for longer. (It is also
 * well under the longest single timer Node keeps, 2 ** 31 - 1 ms.)
 */
export const MAX_LIFETIME_MS = 4 * 60 * 60_000;

function accessLog(method, path, status) {
  process.stderr.write(`${new Date().toISOString()} ${method} ${path} -> ${status}\n`);
}

function refuse(res, method, path, why, log, close = false) {
  const body = JSON.stringify({
    type: 'error',
    error: { type: 'forbidden', message: `asep egress proxy: ${why}` },
  });
  res.writeHead(403, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    ...(close ? { connection: 'close' } : {}),
  });
  res.end(body);
  log(method, path, 403);
}

// The default timer: one that does not by itself keep the process alive.
function scheduleOnce(fn, ms) {
  const timer = setTimeout(fn, ms);
  timer.unref();
  return () => clearTimeout(timer);
}

/**
 * The proxy's request handling, without its process: an HTTP server that
 * forwards the allowlisted model API calls to `upstream` with `apiKey`, and
 * refuses everything else, until `deadline` on the clock `now` (by default
 * the process's monotonic clock). The deadline is one moment for everything:
 * whichever first sees it reached — its timer, a request arriving, or a chunk
 * of a request or response in flight — ends the proxy. Ended, it has refused
 * that request, forwarded nothing more, destroyed every open connection, to
 * the agent and to the upstream, stopped listening and called `onExpired`.
 * Once reached, the deadline stays reached, even were the clock to go back.
 * The clock and the timer are parameters so that a test can run them on
 * virtual time.
 */
export function egressProxy({
  upstream, apiKey, deadline, now = () => performance.now(), schedule = scheduleOnce,
  log = accessLog, onExpired = () => undefined,
}) {
  const target = new URL(upstream);
  if (target.protocol !== 'https:' && target.protocol !== 'http:') throw new Error('upstream must be http(s)');
  const basePath = target.pathname.replace(/\/+$/, '');
  const transport = target.protocol === 'https:' ? https : http;

  // Every connection from the agent, and every request to the upstream.
  const open = new Set();
  const track = (s) => {
    open.add(s);
    s.on('close', () => open.delete(s));
  };
  let reached = false;
  const pastDeadline = () => {
    if (!reached && now() >= deadline) reached = true;
    return reached;
  };
  let ended = false;
  let cancelTimer = () => undefined;
  const end = () => {
    if (ended) return;
    ended = true;
    reached = true;
    cancelTimer();
    server.close();
    for (const s of open) s.destroy();
    open.clear();
    onExpired();
  };
  const atDeadline = () => {
    if (pastDeadline()) end();
    else cancelTimer = schedule(atDeadline, Math.max(0, deadline - now()));
  };

  // Moves `from` into `to` chunk by chunk, each only while the deadline has
  // not been reached; at it, ends the proxy instead. `done` when `from` ended.
  const relay = (from, to, done) => {
    from.on('data', (chunk) => {
      if (pastDeadline()) {
        end();
        return;
      }
      if (!to.write(chunk)) {
        from.pause();
        to.once('drain', () => from.resume());
      }
    });
    from.on('end', () => {
      if (pastDeadline()) end();
      else done();
    });
  };

  const server = http.createServer((req, res) => {
    const method = req.method ?? 'GET';
    const raw = req.url ?? '';
    if (ended) {
      req.socket.destroy();
      return;
    }
    if (pastDeadline()) {
      // Refused, and once that answer is out the proxy ends.
      res.once('close', end);
      refuse(res, method, raw.startsWith('/') ? raw.split('?')[0] : '(absolute-form)',
        'no longer serving: its lifetime ended', log, true);
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
      // Nothing of it is sent before its first chunk or its end, each of which
      // the relay checks against the deadline.
      const back = {};
      for (const [k, v] of Object.entries(up.headers)) {
        if (v !== undefined && !DROP_RESPONSE.has(k.toLowerCase())) back[k] = v;
      }
      res.writeHead(up.statusCode ?? 502, back);
      relay(up, res, () => {
        res.end();
        log(method, path, up.statusCode ?? 502);
      });
      // An upstream that went away mid-response leaves the agent a cut one.
      up.on('close', () => {
        if (!up.complete) res.destroy();
      });
    });
    track(out);
    out.on('error', () => {
      if (ended) return;
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'bad_gateway', message: 'asep egress proxy: upstream unreachable' } }));
      } else {
        res.destroy();
      }
      log(method, path, 502);
    });
    relay(req, out, () => out.end());
  });

  server.on('connection', (socket) => {
    if (ended) socket.destroy();
    else track(socket);
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

  atDeadline();
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
  const lifetimeMs = Number(arg('--lifetime-ms'));
  if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs < 1) {
    process.stderr.write('asep-egress-proxy: --lifetime-ms must be a whole number of milliseconds, at least 1\n');
    process.exit(2);
  }
  if (lifetimeMs > MAX_LIFETIME_MS) {
    process.stderr.write(`asep-egress-proxy: --lifetime-ms ${lifetimeMs} is beyond the maximum lifetime of `
      + `${MAX_LIFETIME_MS} ms — refusing to start\n`);
    process.exit(2);
  }
  // The deadline, fixed once: performance.now() is this process's monotonic
  // clock and counts from its start, so the lifetime runs from the start.
  const deadline = lifetimeMs;
  const apiKey = await readStdin(() => stop('its parent link closed'));
  if (apiKey === undefined) {
    process.stderr.write('asep-egress-proxy: stdin closed before a credential arrived — refusing to start\n');
    process.exit(2);
  }
  if (apiKey === '') {
    process.stderr.write('asep-egress-proxy: no credential on stdin — refusing to start\n');
    process.exit(2);
  }
  if (performance.now() >= deadline) {
    process.stderr.write('asep-egress-proxy: its lifetime ended before a credential arrived — refusing to start\n');
    process.exit(2);
  }

  const server = egressProxy({ upstream, apiKey, deadline, onExpired: () => stop('its lifetime ended') });

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
