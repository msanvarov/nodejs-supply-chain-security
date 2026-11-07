# nodejs-supply-chain-security

[![CI](https://github.com/msanvarov/nodejs-supply-chain-security/actions/workflows/security.yml/badge.svg)](https://github.com/msanvarov/nodejs-supply-chain-security/actions/workflows/security.yml) ![Node](https://img.shields.io/badge/node-%3E%3D22.13-339933?logo=node.js&logoColor=white) ![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)

Your app runs every line of code in `node_modules` with full access to your files, env vars, and network. This repo collects practical defenses against malicious or compromised npm packages, as config you can copy and small tools you can run.

```bash
npm test             # tests for the scanner and the permission model
npm run scan         # list packages in ./node_modules that run install scripts
npm run demo:open    # app with normal Node permissions
npm run demo:locked  # same app under the Node permission model
```

## Project layout

```text
.npmrc                            safe npm defaults (copy into your project)
.github/workflows/security.yml    CI: npm ci, audit, signatures, install-script scan
.github/dependabot.yml            weekly updates with a 7-day cooldown
scripts/find-install-scripts.js   lists dependencies that run code on install
permission-demo/app.mjs           same app with and without --permission
test/supply-chain.test.js         tests for the scanner and the permission model
```

## Why this matters

In September 2025, phishing of maintainer accounts led to malicious versions of very popular packages (including `chalk` and `debug`) being published, and the self-spreading **Shai-Hulud** worm stole npm and GitHub tokens through `postinstall` scripts and used them to publish infected versions of other packages. Both attacks needed nothing more than a normal `npm install`.

## What's in here

| File | What it does |
| --- | --- |
| [.npmrc](.npmrc) | `ignore-scripts`, `save-exact`, `audit-level`, `engine-strict` |
| [scripts/find-install-scripts.js](scripts/find-install-scripts.js) | Lists every dependency with `preinstall`/`install`/`postinstall` or `binding.gyp`. Exits 1 unless each one is on your `--allow` list |
| [.github/workflows/security.yml](.github/workflows/security.yml) | CI: `npm ci`, `npm audit`, `npm audit signatures`, install-script scan, least-privilege token |
| [.github/dependabot.yml](.github/dependabot.yml) | Weekly updates with a 7-day cooldown on new releases |
| [permission-demo/](permission-demo/) | Shows the Node permission model blocking file, process, and write access |

## Mitigations

### 1. Lock what you install
- Commit `package-lock.json`. Use `npm ci` (not `npm install`) in CI and Docker builds. It installs exactly the lockfile and fails if it doesn't match `package.json`.
- `save-exact=true` so upgrades are a deliberate diff you can review.
- Review lockfile changes in PRs. A new transitive dependency or a `resolved` URL pointing somewhere other than `registry.npmjs.org` is a red flag.

### 2. Don't run install scripts by default
- `ignore-scripts=true` in `.npmrc` blocks lifecycle scripts from dependencies. Your own `npm test` / `npm run x` still work.
- Some packages genuinely need them (native addons like `sharp`, `bcrypt`, or `esbuild`'s binary). Review them with `npm run scan`, then run `npm rebuild <pkg>` for just those.
- pnpm (v10+) and Bun block dependency install scripts by default and use an explicit allowlist (`onlyBuiltDependencies` / `trustedDependencies`).

### 3. Audit continuously
- `npm audit --audit-level=high` in CI, plus a weekly scheduled run so new advisories surface even without code changes.
- `npm audit signatures` verifies registry signatures and provenance attestations of what you installed.
- Extra scanners worth considering: OSV-Scanner, Socket, Snyk, GitHub Dependency Review.

### 4. Slow down new releases
- Most malicious versions are found within hours or days. A cooldown means you are rarely the first to install one.
- Dependabot `cooldown`, Renovate `minimumReleaseAge`, pnpm `minimumReleaseAge`.
- For a one-off install, `npm install --before=2025-01-01` resolves versions as of that date.

### 5. Have fewer dependencies
- Every package is code you trust plus everyone who can publish it. Before adding one, check whether Node already does it: `fetch`, `node:test`, `node:sqlite`, `util.parseArgs`, `util.styleText`, `crypto.randomUUID`, `--env-file`, `--watch`.
- Watch for typosquats (`expresss`, `cross-env.js`) and dependency confusion (a public package with the same name as your private one; scope private packages, e.g. `@yourco/`, and map the scope to your registry in `.npmrc`).

### 6. Protect your own publishing
- Enable 2FA on npm, and require it for publishing.
- Publish from CI with npm **trusted publishing** (OIDC) instead of long-lived tokens. This also adds provenance automatically. Otherwise use `npm publish --provenance` and short-lived granular tokens.
- Use the `files` field in `package.json` so you never publish `.env`, tests, or keys.

### 7. Harden CI
- `permissions: contents: read` by default. Grant `id-token: write` or `packages: write` only to the job that publishes.
- Pin third-party actions to a full commit SHA (`uses: owner/action@<sha> # v4`). Tags can be moved, as in the 2025 `tj-actions/changed-files` compromise.
- `persist-credentials: false` on checkout so later steps (and dependency scripts) can't reuse the git token.
- Don't use `pull_request_target` with a checkout of PR code.

### 8. Limit what code can do at runtime
The Node permission model (stable since Node 22.13 / 23.5) restricts the whole process, including every dependency:

```bash
node --permission \
  --allow-fs-read=./src --allow-fs-read=./node_modules \
  --allow-fs-write=./tmp \
  server.js
```

Without explicit `--allow-*` flags, the process can't read or write files, spawn child processes (`--allow-child-process`), start workers (`--allow-worker`), or load native addons (`--allow-addons`). Check at runtime with `process.permission.has('fs.write', path)`.

Caveats: on Node 24 it does not restrict network access (check `node --help | grep allow-net` on newer versions), and it is a seatbelt, not a sandbox for hostile code. Pair it with containers: non-root user, read-only filesystem, no secrets the service doesn't need.

## Node.js security series

| Repo | Covers |
| --- | --- |
| [nodejs-injection-defense](https://github.com/msanvarov/nodejs-injection-defense) | Command, SQL, path traversal, prototype pollution, ReDoS |
| [nodejs-http-hardening](https://github.com/msanvarov/nodejs-http-hardening) | Headers, body limits, timeouts, rate limiting, CORS, safe errors |
| **nodejs-supply-chain-security** (you are here) | npm config, CI auditing, install-script scanning, permission model |
| [nodejs-crypto-secrets](https://github.com/msanvarov/nodejs-crypto-secrets) | Password hashing, tokens, JWTs, encryption, secrets |

## Running it

Requires Node.js 22.13 or newer. No `npm install` needed.

```bash
git clone https://github.com/msanvarov/nodejs-supply-chain-security.git
cd nodejs-supply-chain-security
npm test
```

Found a mistake or want to add an example? Issues and pull requests are welcome.
