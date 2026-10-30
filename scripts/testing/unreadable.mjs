// For tests: directories this process cannot read, as one whose permissions
// deny it its listing — whatever user the tests run as, since root reads every
// directory. While `fn` runs, readdirSync of any of `paths` fails with EACCES,
// here and in every module that imported readdirSync from node:fs.

import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

export function withUnreadable(paths, fn) {
  const real = fs.readdirSync;
  const denied = new Set(paths.map(String));
  fs.readdirSync = function readdirSync(path, ...rest) {
    if (denied.has(String(path))) {
      throw Object.assign(new Error(`EACCES: permission denied, scandir '${String(path)}'`), {
        errno: -13, code: 'EACCES', syscall: 'scandir', path: String(path),
      });
    }
    return real.call(this, path, ...rest);
  };
  syncBuiltinESMExports();
  const restore = () => {
    fs.readdirSync = real;
    syncBuiltinESMExports();
  };
  let out;
  try {
    out = fn();
  } catch (err) {
    restore();
    throw err;
  }
  if (out instanceof Promise) return out.finally(restore);
  restore();
  return out;
}
