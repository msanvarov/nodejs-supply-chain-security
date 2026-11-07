#!/usr/bin/env node
// Lists every installed package that runs code at install time
// (preinstall / install / postinstall, or a binding.gyp that triggers node-gyp).
// Most npm malware, including the 2025 "Shai-Hulud" worm, spreads this way.
//
// Usage: node scripts/find-install-scripts.js [projectDir] [--allow name1,name2]
// Exits 1 if any package not on the allowlist has install scripts.

import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS = ['preinstall', 'install', 'postinstall'];

export function findInstallScripts(projectDir) {
  const found = [];
  const seen = new Set();

  function visitNodeModules(dir) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue; // .bin, .package-lock.json, .pnpm
      const full = path.join(dir, entry.name);
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (entry.name.startsWith('@')) visitNodeModules(full);
      else visitPackage(full);
    }
  }

  function visitPackage(dir) {
    const real = realpathSync(dir);
    if (seen.has(real)) return;
    seen.add(real);
    const manifestPath = path.join(dir, 'package.json');
    if (existsSync(manifestPath)) {
      const pkg = JSON.parse(readFileSync(manifestPath, 'utf8'));
      const scripts = Object.fromEntries(HOOKS.filter((h) => pkg.scripts?.[h]).map((h) => [h, pkg.scripts[h]]));
      const hooks = Object.keys(scripts);
      // npm runs `node-gyp rebuild` automatically when binding.gyp exists and no install script is set.
      if (!hooks.length && existsSync(path.join(dir, 'binding.gyp'))) hooks.push('install (implicit node-gyp)');
      if (hooks.length) found.push({ name: pkg.name, version: pkg.version, hooks, scripts });
    }
    visitNodeModules(path.join(dir, 'node_modules'));
  }

  visitNodeModules(path.join(projectDir, 'node_modules'));
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const allowIdx = args.indexOf('--allow');
  const allow = new Set(allowIdx === -1 ? [] : (args.splice(allowIdx, 2)[1] ?? '').split(',').filter(Boolean));
  const projectDir = path.resolve(args[0] ?? '.');

  const results = findInstallScripts(projectDir);
  const blocked = results.filter((r) => !allow.has(r.name));
  for (const r of results) {
    const mark = allow.has(r.name) ? 'allowed' : 'REVIEW';
    console.log(`[${mark}] ${r.name}@${r.version}  ${r.hooks.join(', ')}`);
    for (const [hook, cmd] of Object.entries(r.scripts)) console.log(`    ${hook}: ${cmd}`);
  }
  if (!results.length) console.log('No packages with install scripts.');
  process.exitCode = blocked.length ? 1 : 0;
}
