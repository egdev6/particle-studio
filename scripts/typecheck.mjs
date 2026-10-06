import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const tscBinary = require.resolve('typescript/bin/tsc');
const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

// Ordered to match the CI contract: persistence emits declarations before consumers.
const projects = [
  'packages/scene-document',
  'packages/runtime',
  'packages/renderer-canvas2d',
  'packages/commands',
  'packages/persistence',
  'packages/persistence-indexeddb',
  'packages/persistence-fs',
  'packages/export',
  'packages/webmcp-adapter',
  'apps/headless-mcp',
  'apps/editor',
];

export function runTypechecks(run = spawnSync) {
  for (const project of projects) {
    const args = [tscBinary, '-p', `${project}/tsconfig.json`];
    if (project !== 'packages/persistence') args.push('--noEmit');
    args.push('--pretty', 'false');

    const result = run(process.execPath, args, { stdio: 'inherit', cwd: repositoryRoot });

    if (result?.error || result?.status === null || result?.status === undefined) return 1;
    if (result.status !== 0) return result.status;
  }

  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runTypechecks();
}
