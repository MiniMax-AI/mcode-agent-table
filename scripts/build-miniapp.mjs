#!/usr/bin/env node
// Bundles Table Core into the Rabbit Hole Mini App (apps/rabbit-hole) so the package runs without
// node_modules: writes miniapp/node/vendor/table-core.mjs and copies the JSON Schemas it loads at
// runtime into miniapp/node/schemas. Both outputs are generated and ignored by git.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const MINIAPP_NODE = join(root, 'apps/rabbit-hole/miniapp/node');

// Only what the Mini App uses; the HTTP server, CLI, MCP bridge and adapters stay out of the bundle.
const ENTRY = [
  "export { Table } from './src/table.js';",
  "export { TableHost } from './src/host.js';",
  "export { JsonlStore } from './src/store.js';",
  "export { ByobError, PROTOCOL, estimateTokens } from './src/protocol.js';",
  "export { generateOwnerKeys } from './src/crypto.js';",
  "export { Owner, renderPrefix, renderEntry, renderTail } from './src/client.js';",
].join('\n');

function revision() {
  try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return 'unknown'; }
}

export async function buildMiniApp() {
  await build({
    stdin: { contents: ENTRY, resolveDir: root, loader: 'ts', sourcefile: 'table-core-entry.ts' },
    bundle: true, platform: 'node', format: 'esm', target: 'node20', legalComments: 'inline', logLevel: 'warning',
    banner: { js: '/* Rabbit Hole table core, bundled from mcode-agent-table@' + revision() + ' (MIT) by scripts/build-miniapp.mjs. Do not edit by hand. */' },
    outfile: join(MINIAPP_NODE, 'vendor/table-core.mjs'),
  });
  mkdirSync(join(MINIAPP_NODE, 'schemas'), { recursive: true });
  for (const f of readdirSync(join(root, 'schemas'))) if (f.endsWith('.json')) copyFileSync(join(root, 'schemas', f), join(MINIAPP_NODE, 'schemas', f));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await buildMiniApp();
  console.log('built ' + join(MINIAPP_NODE, 'vendor/table-core.mjs'));
}
