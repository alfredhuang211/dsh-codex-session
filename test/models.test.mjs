import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import { CodexAdapter, DEFAULT_MODELS, mapDiscoveredModels } from '../lib/provider.js';

const logger = { debug() {}, warn() {} };

const baseConfig = (overrides = {}) => ({
  command: '/opt/homebrew/bin/codex',
  env: {},
  disabledFeatures: [],
  handshakeTimeoutMs: 5000,
  maxJsonRpcLineBytes: 1024 * 1024,
  maxStderrBytes: 4096,
  models: [],
  modelCacheTtlMs: 300000,
  timeoutMs: 5000,
  disposeGraceMs: 100,
  maxCachedSessions: 4,
  sessionIdleTimeoutMs: 600000,
  ...overrides,
});

/**
 * A stand-in `codex app-server`: answers `initialize` and `model/list` over PassThrough streams,
 * so the discovery path is exercised without spawning a real process.
 */
function fakeAppServer({ models }) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let buffer = '';
  stdin.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim().length === 0) continue;
      const message = JSON.parse(line);
      if (message.id === undefined) continue; // client notification
      const result =
        message.method === 'initialize'
          ? { userAgent: 'fake/0.0.0 (probe)' }
          : message.method === 'model/list'
            ? { data: models }
            : {};
      stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
    }
  });
  return {
    stdin,
    stdout,
    stderr,
    kill() {
      stdout.end();
    },
    on() {},
    once() {},
  };
}

const discoveryRows = [
  {
    id: 'gpt-5.6-sol',
    displayName: 'GPT-5.6-Sol',
    description: 'Latest frontier agentic coding model.',
    supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }],
    defaultReasoningEffort: 'low',
    inputModalities: ['text', 'image'],
    isDefault: true,
  },
  { id: 'gpt-5.2', displayName: 'GPT-5.2', supportedReasoningEfforts: [], isDefault: false },
  { id: 'secret-model', hidden: true, isDefault: false },
  { id: 'bad id!', isDefault: false },
  { model: 'gpt-5.5', displayName: 'GPT-5.5' },
];

test('mapDiscoveredModels keeps usable rows and drops hidden or invalid ones', () => {
  const mapped = mapDiscoveredModels(discoveryRows);
  assert.deepEqual(
    mapped.map((entry) => entry.id),
    ['gpt-5.6-sol', 'gpt-5.2', 'gpt-5.5'],
  );
  const first = mapped[0];
  assert.equal(first.name, 'GPT-5.6-Sol');
  assert.deepEqual(first.reasoningEfforts, ['low', 'high']);
  assert.equal(first.defaultReasoningEffort, 'low');
  assert.equal(first.isDefault, true);
  // A row with no declared efforts simply carries none.
  assert.equal(mapped[1].reasoningEfforts, undefined);
  assert.equal(mapDiscoveredModels(undefined).length, 0);
});

test('an explicit models config wins and never starts a process', async () => {
  let spawned = 0;
  const adapter = new CodexAdapter(
    baseConfig({ models: [{ id: 'only-this', name: 'Only This' }] }),
    logger,
    () => {
      spawned += 1;
      throw new Error('discovery must not run when a catalogue is configured');
    },
  );
  const models = await adapter.listModels('codex-local');
  assert.deepEqual(
    models.map((entry) => entry.id),
    ['only-this'],
  );
  assert.equal(spawned, 0);
});

test('with no configured catalogue the local Codex is asked, and the answer is cached', async () => {
  let spawned = 0;
  const adapter = new CodexAdapter(baseConfig(), logger, () => {
    spawned += 1;
    return fakeAppServer({ models: discoveryRows });
  });

  const first = await adapter.listModels('codex-local');
  assert.deepEqual(
    first.map((entry) => entry.id),
    ['gpt-5.6-sol', 'gpt-5.2', 'gpt-5.5'],
  );
  assert.ok(first.every((entry) => entry.provider === 'codex-local'));

  const second = await adapter.listModels('codex-local');
  assert.deepEqual(second, first);
  assert.equal(spawned, 1, 'the catalogue must be cached across calls');
});

test('a failed discovery falls back to the built-in catalogue', async () => {
  const adapter = new CodexAdapter(baseConfig(), logger, () => {
    const child = new PassThrough();
    // A child whose stdout closes immediately: `initialize` can never be answered.
    setTimeout(() => child.end(), 0);
    return { stdin: new PassThrough(), stdout: child, stderr: new PassThrough(), kill() {}, on() {}, once() {} };
  });
  const models = await adapter.listModels('codex-local');
  assert.deepEqual(
    models.map((entry) => entry.id),
    DEFAULT_MODELS.map((entry) => entry.id),
  );
});

test('the default model id follows the local Codex, not a baked-in guess', async () => {
  const adapter = new CodexAdapter(baseConfig(), logger, () => fakeAppServer({ models: discoveryRows }));
  assert.equal(await adapter.defaultModelId(), 'gpt-5.6-sol');

  const noDefault = new CodexAdapter(baseConfig(), logger, () =>
    fakeAppServer({ models: [{ id: 'alpha' }, { id: 'beta' }] }),
  );
  assert.equal(await noDefault.defaultModelId(), 'alpha');
});

test('resolveModel reports the discovered reasoning efforts', async () => {
  const adapter = new CodexAdapter(baseConfig(), logger, () => fakeAppServer({ models: discoveryRows }));
  const resolved = await adapter.resolveModel('codex-local', 'gpt-5.6-sol');
  assert.equal(resolved.id, 'gpt-5.6-sol');
  assert.equal(resolved.name, 'GPT-5.6-Sol');
  assert.deepEqual(
    resolved.reasoning.efforts.map((effort) => effort.id),
    ['low', 'high'],
  );
  assert.equal(resolved.reasoning.defaultEffort, 'low');

  // An unknown but well-formed id still resolves, so a stale selection does not break a session.
  const unknown = await adapter.resolveModel('codex-local', 'not-in-the-catalogue');
  assert.equal(unknown.id, 'not-in-the-catalogue');
  assert.ok(unknown.context.contextWindow > 0);
});
