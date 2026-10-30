#!/usr/bin/env node
// A fake `docker` client, for tests only. It runs the container's command as a
// HOST process so the provider's whole docker choreography — network create,
// proxy start with the credential on stdin, network connect, agent run, rm -f,
// network rm — is exercised quickly and deterministically, with every argv,
// environment and stdin recorded for assertions.
//
// `kill`, `rm -f`, `inspect`, `ps -aq` and `network ls -q` (with `--filter
// label=…`) act on those records, so a container whose client was killed stays
// listed, and running, until something removes it — as with the real daemon.
// A record is the only way to find its container's process, so it goes only
// once nothing of that process group runs: `kill` and `rm -f` that cannot show
// that — the process runs on, or the process table cannot be read — answer
// with the daemon's error and leave the record. A container's process is
// started with a token of its own in its environment, and its record carries
// what identifies it (scripts/lib/process-registry.mjs: pid, start time and
// token), so that a pid another process has now is never signalled. Each
// container is also recorded in the run's process registry (found through
// ASEP_PROCESS_REGISTRY) — before its own record is written — for as long as
// it runs, so that the test runner can end what a dead test process left
// behind.
//
// It does NOT isolate anything. The OS-enforced properties (internal network,
// read-only binds, read-only rootfs, dropped capabilities) are proven against
// the real daemon by the sandbox integration suite; this fake only checks that
// the provider ASKS for them, and refuses what the real daemon would refuse:
// unknown flags, unpinned images, missing bind sources, unknown networks,
// duplicate names, and removing a network that still has containers on it.
//
// Usage: node fake-docker.mjs --state <dir> <docker args…>   (via a shim)
//
// A `kill-does-not-take` file in the state directory stands for a daemon whose
// kill does not stop the container's process.
//
// Emulation:
//   * `--mount type=bind,src=S,dst=D` and `--tmpfs D` map container paths to
//     host paths (a tmpfs gets a fresh directory); argv, `-w` and `-e` values
//     are translated through that map;
//   * a container started with `--listen 0.0.0.0:<port>` is rebound to an
//     ephemeral loopback port, and `http://<name>:<port>` in a later
//     container's environment is rewritten to reach it.

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  endProcess, identityOf, register, shownGone, unregister, TOKEN_ENV,
} from '../lib/process-registry.mjs';

const args = process.argv.slice(2);
if (args[0] !== '--state' || !args[1]) {
  process.stderr.write('fake docker: --state <dir> is required\n');
  process.exit(2);
}
const STATE = args[1];
const cmd = args.slice(2);
for (const d of ['containers', 'networks', 'tmp', 'partial']) mkdirSync(join(STATE, d), { recursive: true });

// Records are read by other clients and by the tests while they are written, so
// each is written whole beside them and renamed into place: a reader sees the
// old record or the new one, never a half-written file.
let partials = 0;
const writeRecord = (path, value) => {
  const partial = join(STATE, 'partial', `${process.pid}-${++partials}.json`);
  writeFileSync(partial, JSON.stringify(value));
  renameSync(partial, path);
};

const log = (rec) => appendFileSync(join(STATE, 'invocations.jsonl'), `${JSON.stringify({ at: Date.now(), ...rec })}\n`);
log({ argv: cmd, env: process.env });

const fail = (msg, code = 1) => {
  process.stderr.write(`${msg}\n`);
  process.exit(code);
};
const containerFile = (n) => join(STATE, 'containers', `${n}.json`);
const networkFile = (n) => join(STATE, 'networks', `${n}.json`);
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const running = () => readdirSync(join(STATE, 'containers')).map((f) => readJson(join(STATE, 'containers', f)));

// Kills the process group of the container `c` records — unless the daemon's
// kill does not take — and waits until none of it runs: endProcess's outcome,
// which shownGone tells apart.
function stopContainer(c) {
  const takes = !existsSync(join(STATE, 'kill-does-not-take'));
  return endProcess(c, takes ? {} : { kill: () => undefined });
}

// Why a container's process was not shown gone, as the daemon would put it.
const notStopped = (c, outcome) => (outcome === 'unknown'
  ? `could not tell whether process ${c.pid} is still running`
  : `process ${c.pid} is still running`);

const BUILTIN_NETWORKS = new Set(['bridge', 'none', 'host']);
const DIGEST = /@sha256:[0-9a-f]{64}$/;

async function main() {
  const [verb, ...rest] = cmd;
  switch (verb) {
    case 'version':
      process.stdout.write('29.0.0-fake\n');
      return;
    case 'network':
      return network(rest);
    case 'rm':
      return remove(rest);
    case 'ps':
      return ps(rest);
    case 'kill':
      return kill(rest);
    case 'inspect':
      return inspect(rest);
    case 'run':
      return run(rest);
    default:
      fail(`fake docker: '${verb}' is not emulated`, 125);
  }
}

function network([sub, ...rest]) {
  if (sub === 'create') {
    let internal = false;
    const labels = [];
    const options = {};
    let name;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--internal') internal = true;
      else if (rest[i] === '--label') labels.push(rest[++i]);
      else if (rest[i] === '-o' || rest[i] === '--opt') {
        const [k, ...v] = (rest[++i] ?? '').split('=');
        options[k] = v.join('=');
      } else if (rest[i].startsWith('-')) fail(`unknown flag: ${rest[i]}`, 125);
      else name = rest[i];
    }
    if (!name) fail('"docker network create" requires exactly 1 argument.', 1);
    if (existsSync(networkFile(name))) fail(`Error response from daemon: network with name ${name} already exists`);
    // As the daemon does: `isolated` is refused unless the network is internal.
    if (Object.values(options).includes('isolated') && !internal) {
      fail('Error response from daemon: gateway mode "isolated" can only be used with an internal network');
    }
    // A test can stand in for a daemon that silently ignores the gateway mode.
    if (existsSync(join(STATE, 'daemon-ignores-gateway-mode'))) {
      for (const k of Object.keys(options)) if (k.includes('gateway_mode')) delete options[k];
    }
    writeRecord(networkFile(name), { name, internal, labels, options });
    process.stdout.write(`${createHash('sha256').update(name).digest('hex')}\n`);
    return;
  }
  if (sub === 'connect') {
    const [net, container] = rest;
    if (!existsSync(networkFile(net))) fail(`Error response from daemon: network ${net} not found`);
    if (!existsSync(containerFile(container))) fail(`Error response from daemon: No such container: ${container}`);
    const c = readJson(containerFile(container));
    c.networks.push(net);
    writeRecord(containerFile(container), c);
    return;
  }
  if (sub === 'rm') {
    let bad = false;
    for (const net of rest) {
      if (!existsSync(networkFile(net))) {
        process.stderr.write(`Error response from daemon: network ${net} not found\n`);
        bad = true;
      } else if (running().some((c) => c.networks.includes(net))) {
        process.stderr.write(`Error response from daemon: error while removing network: network ${net} has active endpoints\n`);
        bad = true;
      } else {
        rmSync(networkFile(net));
      }
    }
    process.exit(bad ? 1 : 0);
  }
  if (sub === 'inspect') {
    // Only `network inspect --format '{{json .}}' <name>`, the provider's call,
    // in the daemon's shape: an isolated bridge has no gateway address.
    if (rest[0] !== '--format' || rest[1] !== '{{json .}}' || rest.length !== 3) {
      fail('fake docker: only `network inspect --format {{json .}} <name>` is emulated', 125);
    }
    if (!existsSync(networkFile(rest[2]))) fail(`Error response from daemon: network ${rest[2]} not found`);
    const n = readJson(networkFile(rest[2]));
    const isolated = n.options?.['com.docker.network.bridge.gateway_mode_ipv4'] === 'isolated';
    process.stdout.write(`${JSON.stringify({
      Name: n.name,
      Internal: n.internal,
      EnableIPv6: false,
      Options: n.options ?? {},
      IPAM: { Config: [isolated ? { Subnet: '172.30.0.0/16' } : { Subnet: '172.30.0.0/16', Gateway: '172.30.0.1' }] },
    })}\n`);
    return;
  }
  if (sub === 'ls') {
    const { quiet, labels } = listFlags(rest);
    if (!quiet) fail('fake docker: only `network ls -q` is emulated', 125);
    const nets = readdirSync(join(STATE, 'networks')).map((f) => readJson(join(STATE, 'networks', f)));
    for (const n of nets.filter((x) => labels.every((l) => x.labels.includes(l)))) process.stdout.write(`${n.name}\n`);
    return;
  }
  fail(`fake docker: 'network ${sub}' is not emulated`, 125);
}

// `-q` and repeated `--filter label=<k=v>` (all must match), as `ps` and
// `network ls` take them.
function listFlags(rest) {
  let quiet = false;
  let all = false;
  const labels = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '-q' || a === '--quiet') quiet = true;
    else if (a === '-a' || a === '--all') all = true;
    else if (a === '-aq' || a === '-qa') { quiet = true; all = true; }
    else if (a === '--filter' || a === '-f') {
      const v = rest[++i] ?? '';
      if (!v.startsWith('label=')) fail(`fake docker: filter '${v}' is not emulated`, 125);
      labels.push(v.slice('label='.length));
    } else fail(`unknown flag: ${a}`, 125);
  }
  return { quiet, all, labels };
}

// Every container record — running, or left behind by a client that died — whose
// labels include every filter. Like `docker ps -a`, a container is listed until
// it is removed.
function ps(rest) {
  const { quiet, all, labels } = listFlags(rest);
  if (!quiet || !all) fail('fake docker: only `ps -aq` is emulated', 125);
  for (const c of running().filter((x) => labels.every((l) => x.labels.includes(l)))) process.stdout.write(`${c.name}\n`);
}

async function remove(rest) {
  const names = rest.filter((a) => a !== '-f' && a !== '--force');
  let bad = false;
  for (const name of names) {
    if (!existsSync(containerFile(name))) {
      process.stderr.write(`Error response from daemon: No such container: ${name}\n`);
      bad = true;
      continue;
    }
    const c = readJson(containerFile(name));
    const outcome = stopContainer(c);
    if (!shownGone(outcome)) {
      process.stderr.write(`Error response from daemon: cannot remove container "/${name}": `
        + `${outcome === 'unknown' ? '' : 'could not kill: '}${notStopped(c, outcome)}\n`);
      bad = true;
      continue;
    }
    rmSync(containerFile(name), { force: true });
    unregister(c.pid);
    process.stdout.write(`${name}\n`);
  }
  process.exit(bad ? 1 : 0);
}

// Only `inspect --type container --format {{.Id}} <name>`, the provider's
// proof of removal, answered as the daemon does for a missing container.
function inspect(rest) {
  if (rest.length !== 5 || rest[0] !== '--type' || rest[1] !== 'container' || rest[2] !== '--format'
    || rest[3] !== '{{.Id}}') {
    fail('fake docker: only `inspect --type container --format {{.Id}} <name>` is emulated', 125);
  }
  const name = rest[4];
  if (!existsSync(containerFile(name))) fail(`Error response from daemon: No such container: ${name}`);
  process.stdout.write(`${createHash('sha256').update(name).digest('hex')}\n`);
}

// Stops a container's process, which then leaves the run's registry. Its
// record goes when its client sees it exit (`--rm`), or stays, like a stopped
// container, when that client is gone.
async function kill(names) {
  let bad = false;
  for (const name of names) {
    if (!existsSync(containerFile(name))) {
      process.stderr.write(`Error response from daemon: No such container: ${name}\n`);
      bad = true;
      continue;
    }
    const c = readJson(containerFile(name));
    const outcome = stopContainer(c);
    if (!shownGone(outcome)) {
      process.stderr.write(`Error response from daemon: cannot kill container: ${name}: ${notStopped(c, outcome)}\n`);
      bad = true;
      continue;
    }
    unregister(c.pid);
    process.stdout.write(`${name}\n`);
  }
  process.exit(bad ? 1 : 0);
}

const RUN_BOOLEAN = new Set(['--rm', '-i', '--interactive', '--read-only']);
const RUN_VALUED = new Set([
  '--name', '--network', '--label', '--tmpfs', '--cap-drop', '--security-opt', '--pids-limit',
  '--cpus', '--memory', '--user', '--mount', '-w', '--workdir', '-e', '--env', '-v', '--volume',
]);

async function run(rest) {
  const flags = {
    labels: [], env: [], mounts: [], volumes: [], tmpfs: [], capDrop: [], securityOpt: [], bool: new Set(),
  };
  let i = 0;
  for (; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('-')) break;
    if (RUN_BOOLEAN.has(a)) {
      flags.bool.add(a === '--interactive' ? '-i' : a);
      continue;
    }
    if (!RUN_VALUED.has(a)) fail(`unknown flag: ${a}\nSee 'docker run --help'.`, 125);
    const v = rest[++i];
    if (v === undefined) fail(`flag needs an argument: ${a}`, 125);
    if (a === '--label') flags.labels.push(v);
    else if (a === '-e' || a === '--env') flags.env.push(v);
    else if (a === '--mount') flags.mounts.push(v);
    else if (a === '-v' || a === '--volume') flags.volumes.push(v);
    else if (a === '--tmpfs') flags.tmpfs.push(v);
    else if (a === '--cap-drop') flags.capDrop.push(v);
    else if (a === '--security-opt') flags.securityOpt.push(v);
    else flags[a.replace(/^-+/, '')] = v;
  }
  const image = rest[i];
  const command = rest.slice(i + 1);
  if (!image) fail('"docker run" requires at least 1 argument.', 125);
  if (!DIGEST.test(image)) fail(`fake docker: image '${image}' is not digest-pinned`, 125);
  if (command.length === 0) fail('fake docker: no command (images carry no entrypoint here)', 125);
  // Like the daemon, an unnamed container gets a generated name.
  const name = flags.name ?? `fake-${process.pid}-${Date.now().toString(36)}`;
  if (existsSync(containerFile(name))) {
    fail(`docker: Error response from daemon: Conflict. The container name "/${name}" is already in use.`, 125);
  }
  const netName = flags.network ?? 'bridge';
  if (!BUILTIN_NETWORKS.has(netName) && !existsSync(networkFile(netName))) {
    fail(`docker: Error response from daemon: network ${netName} not found.`, 125);
  }

  // Container path → host path.
  const map = [];
  for (const m of flags.mounts) {
    const kv = Object.fromEntries(m.split(',').map((p) => {
      const at = p.indexOf('=');
      return at < 0 ? [p, true] : [p.slice(0, at), p.slice(at + 1)];
    }));
    if (kv.type !== 'bind') fail(`fake docker: mount type '${kv.type}' is not emulated`, 125);
    const src = kv.src ?? kv.source;
    const dst = kv.dst ?? kv.destination ?? kv.target;
    if (!existsSync(src)) {
      fail(`docker: Error response from daemon: invalid mount config for type "bind": bind source path does not exist: ${src}`, 125);
    }
    map.push({ dst, src, readonly: kv.readonly === true || kv.ro === true });
  }
  // `-v src:dst[:ro|rw]`: like the daemon, a missing source is created.
  for (const v of flags.volumes) {
    const [src, dst, mode] = v.split(':');
    if (!src || !dst) fail(`docker: invalid spec: ${v}`, 125);
    if (!existsSync(src)) mkdirSync(src, { recursive: true });
    map.push({ dst, src, readonly: mode === 'ro' });
  }
  for (const t of flags.tmpfs) {
    const dst = t.split(':')[0];
    const host = join(STATE, 'tmp', `${name}${dst.replace(/\//g, '_')}`);
    mkdirSync(host, { recursive: true });
    map.push({ dst, src: host, readonly: false });
  }
  map.sort((a, b) => b.dst.length - a.dst.length);
  const toHost = (s) => {
    for (const m of map) {
      if (s === m.dst) return m.src;
      if (s.startsWith(`${m.dst}/`)) return m.src + s.slice(m.dst.length);
    }
    return s;
  };
  // A loopback port for a published listener of another fake container.
  const reach = (s) => s.replace(/http:\/\/([A-Za-z0-9_.-]+):(\d+)/g, (whole, host, port) => {
    const f = containerFile(host);
    if (!existsSync(f)) return whole;
    const hostPort = readJson(f).ports?.[port];
    return hostPort ? `http://127.0.0.1:${hostPort}` : whole;
  });

  let listenPort;
  const argv = command.map((a, idx) => {
    if (command[idx - 1] === '--listen') {
      listenPort = a.split(':').pop();
      return '127.0.0.1:0';
    }
    return toHost(a);
  });
  const token = randomUUID();
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', [TOKEN_ENV]: token };
  for (const e of flags.env) {
    const at = e.indexOf('=');
    if (at < 0) fail('fake docker: -e without a value would inherit the client environment; refused', 125);
    env[e.slice(0, at)] = reach(toHost(e.slice(at + 1)));
  }
  const cwd = flags.w ?? flags.workdir ? toHost(flags.w ?? flags.workdir) : process.cwd();

  const child = spawn(argv[0], argv.slice(1), {
    cwd, env, detached: true, stdio: [flags.bool.has('-i') ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });
  // What identifies the container's process, in the run's registry first and
  // then in its record. One that cannot be identified is not started.
  let identity = { pid: child.pid, group: true, token };
  if (child.pid !== undefined) {
    try {
      identity = identityOf(child.pid, { token, group: true });
      register(identity);
    } catch (err) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch { /* gone already */ }
      fail(`docker: Error response from daemon: failed to create task: ${err.message}`, 125);
    }
  }
  const record = {
    name, ...identity, image, network: netName, networks: [netName], labels: flags.labels,
    ports: {}, flags: { ...flags, bool: [...flags.bool] }, mounts: map,
  };
  writeRecord(containerFile(name), record);

  // What reached the container's stdin, as the hash of all of it so far after
  // every chunk — a starter may keep stdin open for the container's whole life —
  // and whether its client's stdin ended.
  const hash = createHash('sha256');
  if (child.stdin) {
    process.stdin.on('data', (d) => {
      hash.update(d);
      log({ container: name, stdinSha256: hash.copy().digest('hex') });
      child.stdin.write(d);
    });
    process.stdin.on('end', () => {
      log({ container: name, stdinSha256: hash.digest('hex'), stdinEnded: true });
      child.stdin.end();
    });
    child.stdin.on('error', () => undefined);
  }
  // Until a container given `--listen` says it listens, its stdout is passed
  // on line by line, and that line as a process in a container would say it:
  // with the port it was given, not the host port it got.
  let pending = '';
  child.stdout.on('data', (d) => {
    if (listenPort === undefined || record.ports[listenPort]) {
      process.stdout.write(d);
      return;
    }
    pending += d.toString('utf8');
    for (let nl = pending.indexOf('\n'); nl >= 0; nl = pending.indexOf('\n')) {
      let line = pending.slice(0, nl + 1);
      pending = pending.slice(nl + 1);
      const m = record.ports[listenPort] ? null : /listening (\d+)\n$/.exec(line);
      if (m) {
        record.ports[listenPort] = m[1];
        const current = existsSync(containerFile(name)) ? readJson(containerFile(name)) : record;
        current.ports = record.ports;
        writeRecord(containerFile(name), current);
        // When the container said it listens, beside what reached its stdin.
        log({ container: name, listening: m[1] });
        line = `${line.slice(0, m.index)}listening ${listenPort}\n`;
      }
      process.stdout.write(line);
    }
    if (record.ports[listenPort] && pending !== '') {
      process.stdout.write(pending);
      pending = '';
    }
  });
  child.stderr.on('data', (d) => process.stderr.write(d));
  child.on('error', (e) => {
    rmSync(containerFile(name), { force: true });
    fail(`docker: Error response from daemon: failed to create task: exec: "${argv[0]}": ${e.message}`, 127);
  });
  child.on('close', (code, signal) => {
    // As the daemon does when a container's process ends, whatever else ran in
    // it is killed; the container goes once none of it runs.
    if (shownGone(stopContainer(record))) {
      rmSync(containerFile(name), { force: true });
      unregister(child.pid);
    }
    process.exit(code ?? (signal === 'SIGKILL' ? 137 : 128));
  });
}

await main();
