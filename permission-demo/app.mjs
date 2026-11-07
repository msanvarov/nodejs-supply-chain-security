// Run this with and without the permission model and compare:
//
//   node permission-demo/app.mjs
//   node --permission --allow-fs-read=./permission-demo permission-demo/app.mjs
//
// With --permission, Node denies file reads outside the allowed folder,
// all file writes, child processes, worker threads, and native addons
// unless you grant each one with an --allow-* flag.

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);

function attempt(label, fn) {
  try {
    fn();
    console.log(`${label}: allowed`);
  } catch (err) {
    console.log(`${label}: ${err.code ?? err.message}`);
  }
}

attempt('read own data file', () => readFileSync(path.join(here, 'data.txt')));
attempt('read ../package.json', () => readFileSync(path.join(here, '..', 'package.json')));
attempt('read /etc/hosts', () => readFileSync('/etc/hosts'));
attempt('write to tmp', () => writeFileSync(path.join(tmpdir(), 'permission-demo.txt'), 'x'));
attempt('spawn child process', () => execFileSync(process.execPath, ['--version']));

if (process.permission) {
  console.log('process.permission.has("fs.read", "/etc/passwd"):', process.permission.has('fs.read', '/etc/passwd'));
}
