#!/usr/bin/env node
/**
 * build-zip.mjs — builds an uploadable iMessage-channel package.
 *
 * The host resolves a plugin's bare imports against ITS OWN node_modules, so
 * anything the host doesn't already ship would have to be inlined. This
 * channel has ZERO runtime deps (global fetch + node:crypto), so the bundle
 * step only stitches the local src/ modules into a single dist/plugin.js
 * (ESM), keeping the host-provided peers (`@omadia/*`, `express`) external.
 *
 * Steps:
 *   1) esbuild bundle  → dist/plugin.js
 *   2) copy runtime artefacts into out/<id>-<version>-package/
 *   3) verify dist/plugin.js exists
 *   4) zip into out/<id>-<version>.zip
 *
 * This script does NOT typecheck. `npm run build` runs `typecheck && test`
 * first so a red compiler cannot produce an uploadable zip — hub versions are
 * immutable, so a bad zip is a permanent artefact. Use `npm run build:only`
 * to skip the gate deliberately (e.g. while iterating on packaging).
 *
 * The gate matters most when the adjacent omadia checkout is stale: the tsc
 * `paths` alias points at `harness-channel-sdk/dist`, so an un-rebuilt SDK
 * silently typechecks against an outdated API surface (see README).
 */

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

const pkg = readJson(join(pkgRoot, 'package.json'));
if (!pkg.name || !pkg.version) {
  throw new Error('package.json: name + version required');
}

// --- 1) esbuild bundle ---------------------------------------------------
// ESM banner so any bundled CJS helper can call require / __dirname /
// __filename inside the ESM output. Harmless with zero deps; kept for parity
// with the other channel packages.
const ESM_BANNER = [
  "import { createRequire as ___createRequire } from 'node:module';",
  "import { fileURLToPath as ___fileURLToPath } from 'node:url';",
  "import { dirname as ___dirname } from 'node:path';",
  'const require = ___createRequire(import.meta.url);',
  'const __filename = ___fileURLToPath(import.meta.url);',
  'const __dirname = ___dirname(__filename);',
].join('\n');

console.log('▶ esbuild bundle');
await build({
  entryPoints: [join(pkgRoot, 'src/plugin.ts')],
  outfile: join(pkgRoot, 'dist/plugin.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
  banner: { js: ESM_BANNER },
  external: [
    // Host-provided peers — must NOT be inlined (resolve from host node_modules).
    '@omadia/channel-sdk',
    '@omadia/plugin-api',
    'express',
  ],
});

// --- 2) verify entry -----------------------------------------------------
const entryRel = pkg.main ?? 'dist/plugin.js';
const entryAbs = join(pkgRoot, entryRel);
if (!existsSync(entryAbs) || !statSync(entryAbs).isFile()) {
  throw new Error(`entry not found after bundle: ${entryRel}`);
}

// --- 3) stage runtime artefacts -------------------------------------------
const safeName = pkg.name.replace(/^@/, '').replace(/\//g, '-');
const stageName = `${safeName}-${pkg.version}-package`;
const stageDir = join(pkgRoot, 'out', stageName);
rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });

// README.de.md ships too: it is the primary-language doc for this connector,
// and `.md` is in the host's served-extension allowlist.
const INCLUDE = [
  'manifest.yaml',
  'package.json',
  'dist',
  'assets',
  'README.md',
  'README.de.md',
  'LICENSE',
  'NOTICE',
];
for (const entry of INCLUDE) {
  const src = join(pkgRoot, entry);
  if (!existsSync(src)) continue;
  cpSync(src, join(stageDir, entry), { recursive: true });
}

// --- 4) zip ----------------------------------------------------------------
const zipPath = join(pkgRoot, 'out', `${safeName}-${pkg.version}.zip`);
rmSync(zipPath, { force: true });

const zipRes = spawnSync('zip', ['-r', '-q', zipPath, stageName], {
  cwd: join(pkgRoot, 'out'),
  stdio: 'inherit',
});
if (zipRes.status !== 0) {
  throw new Error('zip CLI failed — on Windows use 7z a or Compress-Archive');
}

console.log(`✓ built ${zipPath}`);
