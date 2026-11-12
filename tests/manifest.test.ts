import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

/**
 * Manifest ↔ code consistency.
 *
 * Nothing used to read `manifest.yaml` at all, so the `# === package.json`
 * comments next to `identity.id` / `identity.version` were aspirational and
 * the declared routes could drift from the ones the plugin actually mounts.
 * Hub versions are immutable, so a version mismatch ships a permanent
 * mislabelled artefact.
 *
 * Deliberately a line-oriented check rather than a YAML parse: this plugin has
 * zero runtime dependencies and adding a parser just for a test is a worse
 * trade than a narrow assertion on the handful of fields that must agree.
 */

const root = process.cwd();
const manifest = readFileSync(path.join(root, 'manifest.yaml'), 'utf8');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  name: string;
  version: string;
};
const pluginSrc = readFileSync(path.join(root, 'src', 'plugin.ts'), 'utf8');
const answersSrc = readFileSync(path.join(root, 'src', 'answersRouter.ts'), 'utf8');

function scalar(key: string): string {
  const m = new RegExp(`^\\s*${key}:\\s*"([^"]*)"`, 'm').exec(manifest);
  assert.ok(m, `manifest key not found: ${key}`);
  return m?.[1] ?? '';
}

describe('manifest.yaml ↔ package.json', () => {
  it('declares the same id and version as package.json', () => {
    assert.equal(scalar('id'), pkg.name);
    assert.equal(scalar('version'), pkg.version);
  });

  it('declares the entry point the build actually produces', () => {
    assert.equal(scalar('entry'), 'dist/plugin.js');
  });
});

describe('manifest.yaml ↔ mounted routes', () => {
  const ROUTE_PREFIX = '/api/imessage';

  // Every path under `channel.transport.routes`, as declared.
  const declared = [...manifest.matchAll(/^\s*- path:\s*"([^"]+)"/gm)].map((m) => m[1] ?? '');

  it('declares exactly the public routes the code mounts', () => {
    assert.deepEqual(declared.sort(), [
      `${ROUTE_PREFIX}/a/:token`,
      `${ROUTE_PREFIX}/a/assets/preview.jpg`,
      `${ROUTE_PREFIX}/answers/:token`,
      `${ROUTE_PREFIX}/answers/:token/reply`,
      `${ROUTE_PREFIX}/webhook/:token`,
    ]);
  });

  it('every declared route exists as a handler in the source', () => {
    const source = pluginSrc + answersSrc;
    for (const full of declared) {
      const relative = full.slice(ROUTE_PREFIX.length);
      assert.ok(
        source.includes(`'${relative}'`),
        `declared route ${full} has no handler for '${relative}'`,
      );
    }
  });

});

describe('manifest.yaml ↔ public paths', () => {
  const ROUTE_PREFIX = '/api/imessage';
  const ADMIN_PREFIX = '/api/imessage-channel/admin';

  // The entries of `permissions.public_paths`: the list items directly under
  // the key, up to the next key of the permissions block.
  const block = /^ {2}public_paths:\n((?: {4}- "[^"]+"\n)+)/m.exec(manifest);
  const publicPaths = [...(block?.[1] ?? '').matchAll(/- "([^"]+)"/g)].map((m) => m[1] ?? '');

  /** `child` is `parent` or sits beneath it on a segment boundary — the
   *  host's own containment rule for public-path declarations. */
  const isUnder = (child: string, parent: string): boolean =>
    child === parent || child.startsWith(`${parent}/`);

  it('declares the prefix the public router is registered at', () => {
    // The host refuses `ctx.routes.register(prefix, …, { auth: 'custom' })`
    // unless the prefix lies inside a declared public path, so a mismatch
    // fails activation rather than serving a 401.
    assert.ok(pluginSrc.includes(`const ROUTE_PREFIX = '${ROUTE_PREFIX}'`));
    assert.ok(
      pluginSrc.includes("ctx.routes.register(ROUTE_PREFIX, router, { auth: 'custom' })"),
      'the public router must be registered through ctx.routes with auth custom',
    );
    assert.ok(
      publicPaths.some((p) => isUnder(ROUTE_PREFIX, p)),
      `permissions.public_paths does not cover ${ROUTE_PREFIX} (declared: ${publicPaths.join(', ')})`,
    );
  });

  it('declares nothing beyond the public router', () => {
    assert.deepEqual(publicPaths, [ROUTE_PREFIX]);
  });

  it('covers every public route the channel block lists', () => {
    const declared = [...manifest.matchAll(/^\s*- path:\s*"([^"]+)"/gm)].map((m) => m[1] ?? '');
    assert.ok(declared.length > 0);
    for (const route of declared) {
      assert.ok(
        publicPaths.some((p) => isUnder(route, p)),
        `route ${route} is not under a declared public path — it would answer 401`,
      );
    }
  });

  it('keeps the admin UI outside every declared public path', () => {
    assert.ok(pluginSrc.includes(`const ADMIN_ROUTE_PREFIX = '${ADMIN_PREFIX}'`));
    assert.ok(
      !publicPaths.some((p) => isUnder(ADMIN_PREFIX, p)),
      'the admin UI must stay behind the operator session',
    );
  });
});

describe('manifest.yaml ↔ consumed services', () => {
  it('declares every capability the code resolves via ctx.services.get', () => {
    const resolved = new Set(
      [...pluginSrc.matchAll(/services\.get<[^>]*>\(\s*'([^']+)'/g)].map((m) => m[1] ?? ''),
    );
    // chatAgent is resolved through the SDK helper, not a literal get() call.
    resolved.add('chatAgent');
    for (const name of resolved) {
      assert.ok(
        new RegExp(`- "${name}@`).test(manifest),
        `ctx.services.get('${name}') is not declared in requires/optional_requires — ` +
          'the kernel service gate (omadia#838) rejects undeclared names at activation',
      );
    }
  });
});
