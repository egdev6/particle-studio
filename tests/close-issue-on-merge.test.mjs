// Stage 1 tests: trusted inline workflow script + workflow static contract.
// Bootstrap RED (missing workflow file) is expected before the parent adds it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'close-issue-on-merge.yml');
// Sentinels are YAML comments outside the block scalar; the block follows
// `script: |` and every content line carries 10 spaces of indentation.
function extractScript(yaml) {
  const start = yaml.indexOf('# autoclose-script-start');
  const end = yaml.indexOf('# autoclose-script-end');
  assert.ok(start !== -1, 'workflow missing # autoclose-script-start');
  assert.ok(end > start, 'workflow missing # autoclose-script-end');
  const region = yaml.slice(start, end);
  const marker = region.indexOf('script: |');
  assert.ok(marker !== -1, 'workflow missing script: | block');
  return region.slice(marker + 'script: |'.length).split('\n').slice(1)
    .map((line) => (line.startsWith(' '.repeat(10)) ? line.slice(10) : line))
    .join('\n').trimEnd();
}
let scriptPromise;
function loadScript() {
  return (scriptPromise ??= readFile(WORKFLOW, 'utf8').then(extractScript));
}
function freshPull(body) {
  const base = { ref: 'develop', repo: { full_name: 'egdev6/particle-studio' } };
  return { number: 1, merged: true, merged_at: '2024-01-01T00:00:00Z', base, body };
}
function context(prPayload = { number: 1, body: 'ignored' }) {
  return { repo: { owner: 'egdev6', repo: 'particle-studio' }, payload: { pull_request: prPayload } };
}
function makeState(pull = freshPull('Closes #2'), issues) {
  const store = issues ?? new Map([[2, { number: 2, state: 'open' }]]);
  const calls = [];
  const api = { rest: {
    pulls: { get: async (args) => (calls.push({ op: 'pulls.get', ...args }), { data: pull }) },
    issues: {
      get: async (args) => (calls.push({ op: 'issues.get', ...args }), { data: store.get(args.issue_number) }),
      update: async (args) => {
        calls.push({ op: 'issues.update', ...args });
        store.set(args.issue_number, { ...store.get(args.issue_number), state: args.state });
        return { data: store.get(args.issue_number) };
      },
    },
  } };
  return { api, calls, store, pull };
}
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
async function run(state, ctx = context({ number: 1, body: state.pull.body })) {
  const fn = new AsyncFunction('github', 'context', 'core', await loadScript());
  return fn(state.api, ctx, { info() {}, warning() {}, error() {} });
}
const updates = (state) => state.calls.filter((call) => call.op === 'issues.update');

test('positive: every variant and changed body ignored', async () => {
  const bodies = [
    'Closes #2', 'closes #2', 'CLOSED: #2', 'Fix #2',
    'fixes #2', 'Fixed #2', 'Resolve #2', 'resolves #2',
    'RESOLVED: #2', 'Closes egdev6/particle-studio#2',
    '```\nexample\n```\nCloses #2',
    '   ~~~~\nexample\n   ~~~~\nCloses #2',
  ];
  for (const body of bodies) {
    const state = makeState(freshPull(body));
    await run(state);
    const [update] = updates(state);
    assert.equal(updates(state).length, 1, body);
    assert.equal(update.issue_number, 2, body);
    assert.equal(update.state, 'closed', body);
    assert.equal(update.state_reason, 'completed', body);
    assert.equal(update.owner, 'egdev6', body);
    assert.equal(update.repo, 'particle-studio', body);
  }
  const spoofed = makeState(freshPull('Closes #2'));
  await run(spoofed, context({ number: 1, body: 'Closes #999' }));
  assert.deepEqual(updates(spoofed), []);
});
test('references, foreign or unsafe ids, and Markdown contexts never close', async () => {
  const bodies = [
    'References #2', 'Closes egdev6/other-repo#2', 'Closes #0',
    'Closes #-1', 'Closes #2abc', 'Closes #2.3',
    '```\nCloses #2\n```', '`Closes #2`', '<!-- Closes #2 -->', '> Closes #2',
  ];
  for (const body of bodies) {
    const state = makeState(freshPull(body));
    await run(state);
    assert.equal(updates(state).length, 0, body);
  }
});
test('fresh PR guards: unmerged, no merge time, wrong base, foreign repo, number drift', async () => {
  const bad = [
    { ...freshPull('Closes #2'), merged: false },
    { ...freshPull('Closes #2'), merged_at: null },
    { ...freshPull('Closes #2'), base: { ref: 'main', repo: { full_name: 'egdev6/particle-studio' } } },
    { ...freshPull('Closes #2'), base: { ref: 'develop', repo: { full_name: 'other/repo' } } },
    { ...freshPull('Closes #2'), number: 9 },
  ];
  for (const pull of bad) {
    const state = makeState(pull);
    await run(state);
    assert.equal(updates(state).length, 0);
  }
});

test('workflow and extracted script stay inert and least-privilege', async () => {
  const yaml = await readFile(WORKFLOW, 'utf8');
  const script = await loadScript();
  assert.match(yaml, /pull_request_target:/);
  assert.match(yaml, /types:\s*\[?closed\]?/);
  assert.match(yaml, /branches:\s*\[?develop\]?/);
  assert.match(yaml, /if:\s*github\.event\.pull_request\.merged\s*==\s*true/);
  assert.match(yaml, /issues:\s*write/);
  assert.match(yaml, /pull-requests:\s*read/);
  assert.match(yaml, /actions\/github-script@ed597411d8f924073f98dfc5c65a23a2325f34cd/);
  assert.match(yaml, /retries:\s*0/);
  assert.doesNotMatch(yaml, /actions\/checkout@/);
  assert.doesNotMatch(yaml, /\brun:/);
  for (const pattern of [/\brequire\s*\(/, /\bmodule\.exports\b/, /\bimport\b/, /\beval\s*\(/, /\bnew Function\b/, /\$\{\{/]) {
    assert.doesNotMatch(script, pattern, String(pattern));
  }
});

test('skips already-closed issues and pull-request targets', async () => {
  const cases = [
    new Map([[2, { number: 2, state: 'closed' }]]),
    new Map([[2, { number: 2, state: 'open', pull_request: {} }]]),
  ];
  for (const issues of cases) {
    const state = makeState(freshPull('Closes #2'), issues);
    await run(state);
    assert.equal(updates(state).length, 0);
  }
});
test('fails closed on a fetched issue identity mismatch', async () => {
  const state = makeState(freshPull('Closes #2'), new Map([[2, { number: 7, state: 'open' }]]));
  await assert.rejects(() => run(state));
  assert.equal(updates(state).length, 0);
});
test('read and write API errors stop the run without retry', async () => {
  const readState = makeState(freshPull('Closes #2'));
  readState.api.rest.issues.get = async () => { throw new Error('read boom'); };
  await assert.rejects(() => run(readState), /read boom/);
  const writeState = makeState(freshPull('Closes #2'));
  writeState.api.rest.issues.update = async () => { throw new Error('write boom'); };
  await assert.rejects(() => run(writeState), /write boom/);
});
test('replay over an already closed issue performs no second update', async () => {
  const state = makeState(freshPull('Closes #2'));
  await run(state);
  state.store.set(2, { number: 2, state: 'closed' });
  await run(state);
  assert.equal(updates(state).length, 1);
});
test('malformed payload is a no-op without any API call', async () => {
  const state = makeState(freshPull('Closes #2'));
  await run(state, { repo: { owner: 'egdev6', repo: 'particle-studio' }, payload: {} });
  assert.equal(state.calls.length, 0);
});
test('deduplicates repeated references and rejects unsafe overflow ids', async () => {
  const deduped = makeState(freshPull('Closes #2\nfixes #2\nResolved: #2'));
  await run(deduped);
  assert.equal(updates(deduped).length, 1);
  const overflow = makeState(freshPull('Closes #99999999999999999999'));
  await run(overflow);
  assert.equal(updates(overflow).length, 0);
});

test('narrow parser rejects path suffixes, open fences, and exotic code spans', async () => {
  const bodies = [
    'Closes #2/path', '```\nCloses #2', '    Closes #2',
    '````\n```\nCloses #2', '``not `code` Closes #2``',
  ];
  for (const body of bodies) {
    const state = makeState(freshPull(body));
    await run(state);
    assert.equal(updates(state).length, 0, body);
  }
});

test('absent event body is a no-op even with a matching fresh body', async () => {
  const state = makeState(freshPull('Closes #2'));
  await run(state, context({ number: 1 }));
  assert.deepEqual(updates(state), []);
});
