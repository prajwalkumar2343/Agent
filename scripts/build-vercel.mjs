import { build } from 'esbuild';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { glob } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Vercel deploy build — the api/ handlers import packages/** via relative
 * `.ts` specifiers (required for local `node --experimental-strip-types`),
 * but Vercel's per-file transpile doesn't rewrite them, so the emitted JS
 * 404s on Lambda. We bundle each handler into a self-contained ESM .js here
 * (internal sources inlined, npm deps external) and deploy dist/ instead.
 *
 *   node scripts/build-vercel.mjs && cd dist && vercel --prod
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

// Preserve dist/.vercel — it carries the project link; wiping it makes
// `vercel --prod` deploy under a new project named after the directory.
const linkDir = path.join(dist, '.vercel');
let savedLink;
try {
  savedLink = readFileSync(path.join(linkDir, 'project.json'), 'utf8');
} catch { /* first build — no link yet */ }
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
if (savedLink) {
  mkdirSync(linkDir, { recursive: true });
  writeFileSync(path.join(linkDir, 'project.json'), savedLink);
}

const entries = [];
for await (const f of glob('api/**/*.ts', { cwd: root })) {
  if (f.includes('.test.') || f.includes('/_')) continue;
  entries.push(path.join(root, f));
}

await build({
  entryPoints: entries,
  outdir: dist,
  outbase: root,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  packages: 'external',
  logLevel: 'warning',
});

// Runtime deps the bundles keep external — union of every workspace package's
// dependencies plus the root's.
const deps = {};
for await (const f of glob('packages/*/package.json', { cwd: root })) {
  const d = JSON.parse(readFileSync(path.join(root, f), 'utf8'));
  Object.assign(deps, d.dependencies);
}
Object.assign(deps, JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).dependencies);
delete deps['@platform/shared']; // workspace pkg — bundled, not external

writeFileSync(
  path.join(dist, 'package.json'),
  JSON.stringify({ type: 'module', dependencies: deps }, null, 2),
);

const vercel = JSON.parse(readFileSync(path.join(root, 'vercel.json'), 'utf8'));
vercel.functions = { 'api/**/*.js': { maxDuration: 60 } };
writeFileSync(path.join(dist, 'vercel.json'), JSON.stringify(vercel, null, 2));

console.log(`dist/ ready — ${entries.length} handlers bundled`);
