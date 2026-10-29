#!/usr/bin/env node
// A fake `docker` client, for tests only. It runs the container's command as a
// HOST process so the provider's whole docker choreography — network create,
// proxy start with the credential on stdin, network connect, agent run, rm -f,
// network rm — is exercised quickly and deterministically, with every argv,
// environment and stdin recorded for assertions.
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
// Emulation:
//   * `--mount type=bind,src=S,dst=D` and `--tmpfs D` map container paths to
//     host paths (a tmpfs gets a fresh directory); argv, `-w` and `-e` values
//     are translated through that map;
//   * a container started with `--listen 0.0.0.0:<port>` is rebound to an
//     ephemeral loopback port, and `http://<name>:<port>` in a later
//     container's environment is rewritten to reach it.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
if (args[0] !== '--state' || !args[1]) {
  process.stderr.write('fake docker: --state <dir> is required\n');
  process.exit(2);
}
const STATE = args[1];
const cmd = args.slice(2);
for (const d of ['containers', 'networks', 'tmp']) mkdirSync(join(STATE, d), { recursive: true });

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
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
    let name;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--internal') internal = true;
      else if (rest[i] === '--label') labels.push(rest[++i]);
      else if (rest[i].startsWith('-')) fail(`unknown flag: ${rest[i]}`, 125);
      else name = rest[i];
    }
    if (!name) fail('"docker network create" requires exactly 1 argument.', 1);
    if (existsSync(networkFile(name))) fail(`Error response from daemon: network with name ${name} already exists`);
    writeFileSync(networkFile(name), JSON.stringify({ name, internal, labels }));
    process.stdout.write(`${createHash('sha256').update(name).digest('hex')}\n`);
    return;
  }
  if (sub === 'connect') {
    const [net, container] = rest;
    if (!existsSync(networkFile(net))) fail(`Error response from daemon: network ${net} not found`);
    if (!existsSync(containerFile(container))) fail(`Error response from daemon: No such container: ${container}`);
    const c = readJson(containerFile(container));
    c.networks.push(net);
    writeFileSync(containerFile(container), JSON.stringify(c));
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
  fail(`fake docker: 'network ${sub}' is not emulated`, 125);
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
    try {
      process.kill(-c.pid, 'SIGKILL');
    } catch { /* already gone */ }
    for (let i = 0; i < 200 && alive(c.pid); i++) await sleep(10);
    rmSync(containerFile(name), { force: true });
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
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin' };
  for (const e of flags.env) {
    const at = e.indexOf('=');
    if (at < 0) fail('fake docker: -e without a value would inherit the client environment; refused', 125);
    env[e.slice(0, at)] = reach(toHost(e.slice(at + 1)));
  }
  const cwd = flags.w ?? flags.workdir ? toHost(flags.w ?? flags.workdir) : process.cwd();

  const child = spawn(argv[0], argv.slice(1), {
    cwd, env, detached: true, stdio: [flags.bool.has('-i') ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });
  const record = {
    name, pid: child.pid, image, network: netName, networks: [netName], labels: flags.labels, ports: {},
    flags: { ...flags, bool: [...flags.bool] }, mounts: map,
  };
  writeFileSync(containerFile(name), JSON.stringify(record));

  const hash = createHash('sha256');
  if (child.stdin) {
    process.stdin.on('data', (d) => { hash.update(d); child.stdin.write(d); });
    process.stdin.on('end', () => {
      log({ container: name, stdinSha256: hash.digest('hex') });
      child.stdin.end();
    });
    child.stdin.on('error', () => undefined);
  }
  let out = '';
  child.stdout.on('data', (d) => {
    if (listenPort !== undefined && !record.ports[listenPort]) {
      out += d.toString('utf8');
      const m = /listening (\d+)/.exec(out);
      if (m) {
        record.ports[listenPort] = m[1];
        const current = existsSync(containerFile(name)) ? readJson(containerFile(name)) : record;
        current.ports = record.ports;
        writeFileSync(containerFile(name), JSON.stringify(current));
      }
    }
    process.stdout.write(d);
  });
  child.stderr.on('data', (d) => process.stderr.write(d));
  child.on('error', (e) => {
    rmSync(containerFile(name), { force: true });
    fail(`docker: Error response from daemon: failed to create task: exec: "${argv[0]}": ${e.message}`, 127);
  });
  child.on('close', (code, signal) => {
    rmSync(containerFile(name), { force: true });
    process.exit(code ?? (signal === 'SIGKILL' ? 137 : 128));
  });
}

await main();
