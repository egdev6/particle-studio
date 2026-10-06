import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runTypechecks } from '../typecheck.mjs';

// Repository root resolved from this module, independent of the invocation cwd.
const repositoryRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));

// Independent ordered workspace contract for local and CI typechecks.
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

function expectedFlags(project) {
  const flags = ['-p', `${project}/tsconfig.json`];
  if (project !== 'packages/persistence') flags.push('--noEmit');
  flags.push('--pretty', 'false');
  return flags;
}

function recordingRun(result, calls) {
  return (...args) => {
    calls.push(args);
    return typeof result === 'function' ? result(calls.length) : result;
  };
}

test('runs all typechecks in CI order with exact flags and repository cwd', () => {
  const calls = [];
  const status = runTypechecks(recordingRun({ status: 0 }, calls));

  assert.equal(status, 0);
  assert.equal(calls.length, projects.length);

  projects.forEach((project, index) => {
    const [command, args, options] = calls[index];
    assert.equal(command, process.execPath, `command for ${project}`);
    assert.match(args[0], /typescript[\\/]bin[\\/]tsc$/, `tsc binary for ${project}`);
    assert.deepEqual(args.slice(1), expectedFlags(project), `flags for ${project}`);
    assert.equal(options.stdio, 'inherit', `stdio for ${project}`);
    assert.equal(path.resolve(options.cwd), repositoryRoot, `cwd for ${project}`);
  });
});

test('propagates the first failing status and stops', () => {
  const calls = [];
  const status = runTypechecks(recordingRun((n) => ({ status: n === 5 ? 2 : 0 }), calls));

  assert.equal(status, 2);
  assert.equal(calls.length, 5);
});

const failClosedCases = [
  ['spawn error', { error: new Error('spawn failed') }],
  ['null status with signal', { status: null, signal: 'SIGKILL' }],
  ['undefined status', {}],
];

failClosedCases.forEach(([label, result]) => {
  test(`fails closed on ${label} and stops`, () => {
    const calls = [];
    const status = runTypechecks(recordingRun(result, calls));

    assert.equal(status, 1);
    assert.equal(calls.length, 1);
  });
});
