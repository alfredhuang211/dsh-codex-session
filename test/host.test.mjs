import test from 'node:test';
import assert from 'node:assert/strict';

import { apply, inject } from '../lib/index.js';

/**
 * A configured catalogue keeps these tests hermetic. With no `models` config the plugin asks the
 * installed Codex (`model/list`) for its default, which would make the expected model id depend on
 * whatever this machine happens to have.
 */
const DETERMINISTIC = { models: [{ id: 'gpt-5.5', name: 'GPT-5.5' }] };
const applyDeterministic = (ctx, extra = {}) => apply(ctx, { ...DETERMINISTIC, ...extra });

/**
 * Minimal Cordis stand-in: only the surface `apply` actually touches. The pinning half mounts
 * through `ctx.inject`, so the stub runs that callback immediately with the three services.
 */
function harness(initial = { provider: 'opencode-go', model: 'deepseek-v4.1-flash' }) {
  const listeners = new Map();
  const calls = { registered: [], selectModel: [], saveSelection: [] };
  let current = { ...initial };

  const services = {
    agents: { get: () => undefined },
    agentDefaultModel: {
      currentSelection: () => ({ ...current }),
      saveSelection: async (selection) => {
        calls.saveSelection.push({ ...selection });
        current = { ...selection };
      },
    },
    sessionController: {
      selectModel: async (request) => {
        calls.selectModel.push({ ...request });
        // Mirror the real service in two ways that both broke the restore in a real host:
        //  1. the deployment default is persisted in the BACKGROUND, so `currentSelection()`
        //     does not report it until a later tick;
        //  2. the RESOLVED selection materializes the adapter's default reasoning effort, so it
        //     can carry an effort the request never named.
        const selected = {
          provider: request.provider,
          model: request.model,
          reasoningEffort: request.reasoningEffort ?? 'medium',
        };
        setTimeout(() => {
          current = { ...selected };
        }, 0);
        return { selected };
      },
    },
  };

  const ctx = {
    logger: { debug() {}, warn() {} },
    effect: (callback) => {
      callback();
    },
    on: (event, listener) => {
      listeners.set(event, listener);
    },
    inject: (_dependencies, callback) => {
      // Cordis hands the callback a child context: the injected services plus the usual
      // context surface, so the plugin's `scope.on(...)` registrations land here too.
      callback({
        ...services,
        logger: ctx.logger,
        on: (event, listener) => {
          listeners.set(event, listener);
        },
      });
    },
    llm: {
      registerAdapter: (providers, adapter) => {
        calls.registered.push({ providers, adapter });
        return () => {};
      },
    },
  };

  return { ctx, listeners, calls, services, current: () => ({ ...current }) };
}

const agent = (preset, id = 'session-1') => ({ session: { header: { id, agentPreset: preset } } });

test('the provider half needs only the llm registry', () => {
  assert.deepEqual(inject, ['llm']);
});

test('apply registers exactly the configured provider route', () => {
  const { ctx, calls } = harness();
  applyDeterministic(ctx);
  assert.equal(calls.registered.length, 1);
  assert.deepEqual(calls.registered[0].providers, ['codex-local']);
  assert.equal(typeof calls.registered[0].adapter.stream, 'function');
  assert.equal(calls.registered[0].adapter.providerInfo('codex-local').id, 'codex-local');
});

test('a codex-preset agent is pinned to the codex route and the deployment default is restored', async () => {
  const { ctx, listeners, calls, current } = harness();
  applyDeterministic(ctx);

  await listeners.get('agent/created')({ agent: agent('codex') });

  assert.deepEqual(calls.selectModel, [
    { sessionId: 'session-1', provider: 'codex-local', model: 'gpt-5.5' },
  ]);
  // `selectModel` moves the deployment default to Codex; the plugin must put it back so later
  // "DSH default" sessions do not silently become Codex sessions.
  assert.deepEqual(current(), { provider: 'opencode-go', model: 'deepseek-v4.1-flash' });
  assert.deepEqual(calls.saveSelection, [{ provider: 'opencode-go', model: 'deepseek-v4.1-flash' }]);
});

test('a non-codex agent is left alone', async () => {
  const { ctx, listeners, calls } = harness();
  applyDeterministic(ctx);
  await listeners.get('agent/created')({ agent: agent('standard') });
  await listeners.get('agent/created')({ agent: agent(undefined) });
  assert.deepEqual(calls.selectModel, []);
  assert.deepEqual(calls.saveSelection, []);
});

test('switching an existing session to the codex preset re-pins it', async () => {
  const { ctx, listeners, calls, services } = harness();
  // The session was CREATED with the standard preset: its header keeps saying `standard` even
  // after it switches, so the pin must trust the event rather than re-reading the header.
  services.agents.get = (id) => (id === 'session-7' ? agent('standard', 'session-7') : undefined);
  applyDeterministic(ctx);

  await listeners.get('agent-preset/selected')('session-7', 'codex');
  assert.deepEqual(calls.selectModel, [
    { sessionId: 'session-7', provider: 'codex-local', model: 'gpt-5.5' },
  ]);

  await listeners.get('agent-preset/selected')('session-8', 'standard');
  assert.equal(calls.selectModel.length, 1);
});

test('a custom preset id, provider and model are honoured', async () => {
  const { ctx, listeners, calls } = harness();
  applyDeterministic(ctx, { preset: 'my-codex', provider: 'my-codex-route', model: 'gpt-5.6-sol' });
  await listeners.get('agent/created')({ agent: agent('my-codex', 'session-9') });
  assert.deepEqual(calls.selectModel, [
    { sessionId: 'session-9', provider: 'my-codex-route', model: 'gpt-5.6-sol' },
  ]);
});

test('a failing selection never escapes the creation listener', async () => {
  const { ctx, listeners, services } = harness();
  services.sessionController.selectModel = async () => {
    throw new Error('session/model-unavailable');
  };
  applyDeterministic(ctx);
  await assert.doesNotReject(async () => {
    await listeners.get('agent/created')({ agent: agent('codex') });
  });
});

test('the deployment default is restored even though the selection write is asynchronous', async () => {
  // Regression guard: reading `currentSelection()` once straight after `selectModel` returns the
  // OLD value, which previously made the restore look unnecessary — and the background write then
  // left every later DSH-default session routed to Codex.
  const { ctx, listeners, current } = harness({ provider: 'deepseek-official', model: 'deepseek-chat' });
  applyDeterministic(ctx);
  await listeners.get('agent/created')({ agent: agent('codex') });
  assert.deepEqual(current(), { provider: 'deepseek-official', model: 'deepseek-chat' });
});

test('an already-defaulted codex route is left untouched', async () => {
  const { ctx, listeners, calls } = harness({ provider: 'codex-local', model: 'gpt-5.5' });
  applyDeterministic(ctx);
  await listeners.get('agent/created')({ agent: agent('codex') });
  assert.deepEqual(calls.selectModel, []);
  assert.deepEqual(calls.saveSelection, []);
});

test('a configured model is used verbatim, overriding the local Codex default', async () => {
  const { ctx, listeners, calls } = harness();
  applyDeterministic(ctx, { model: 'gpt-5.6-terra' });
  await listeners.get('agent/created')({ agent: agent('codex', 'session-pinned') });
  assert.deepEqual(calls.selectModel, [
    { sessionId: 'session-pinned', provider: 'codex-local', model: 'gpt-5.6-terra' },
  ]);
});
