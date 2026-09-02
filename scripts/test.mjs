#!/usr/bin/env node
/**
 * test.mjs — run the TypeScript test suite with zero extra dependencies.
 *
 * Node's built-in test runner (`node:test`) + assert drive the tests; esbuild
 * (already a dev dependency) transpiles each `tests/*.test.ts` into
 * `.test-build/` first, bundling the `src/` modules under test directly.
 *
 * `@omadia/channel-sdk` is aliased to the adjacent omadia checkout's built
 * dist (same source the tsconfig `paths` typecheck uses) because plugin.ts
 * imports runtime values from it (isNoReply, getChatAgent). Build it first:
 * `npm run build` in `../omadia/middleware/packages/harness-channel-sdk`.
 * `@omadia/plugin-api` stays external — tests only use its types (erased).
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const testsDir = join(pkgRoot, 'tests');
const outDir = join(pkgRoot, '.test-build');

const channelSdkDist = resolve(
  pkgRoot,
  '../omadia/middleware/packages/harness-channel-sdk/dist/index.js',
);
if (!existsSync(channelSdkDist)) {
  console.error(
    `@omadia/channel-sdk dist not found at ${channelSdkDist}\n` +
      'Build it first: npm run build in ../omadia/middleware/packages/harness-channel-sdk',
  );
  process.exit(1);
}

const entryPoints = readdirSync(testsDir)
  .filter((f) => f.endsWith('.test.ts'))
  .map((f) => join(testsDir, f));

if (entryPoints.length === 0) {
  console.error('no tests found in tests/');
  process.exit(1);
}

rmSync(outDir, { recursive: true, force: true });

console.log(`▶ transpiling ${entryPoints.length} test file(s)`);
await build({
  entryPoints,
  outdir: outDir,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: 'inline',
  logLevel: 'error',
  alias: {
    '@omadia/channel-sdk': channelSdkDist,
  },
  // express is a real devDependency (resolved from node_modules at runtime);
  // plugin-api is type-only in src/, so the import is erased anyway.
  external: ['@omadia/plugin-api', 'express'],
});

const built = readdirSync(outDir)
  .filter((f) => f.endsWith('.js'))
  .map((f) => join(outDir, f));

console.log('▶ node --test');
const res = spawnSync(process.execPath, ['--test', ...built], {
  cwd: pkgRoot,
  stdio: 'inherit',
});
process.exit(res.status ?? 1);
