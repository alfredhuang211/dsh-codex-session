import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * The client half is a `window.__ModuleLoader__` bundle, so it is evaluated exactly the way the
 * browser boots it: capture the registration, run the factory with a stub `react`, then call
 * `apply` with a stub Cordis context and RENDER both components.
 *
 * This is the only part of the plugin the browser exercises, and a render-time crash there would
 * otherwise be invisible to every other test.
 */
function loadClientBundle() {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  const captured = [];
  const fakeWindow = { __ModuleLoader__: { load: (entry) => captured.push(entry) } };
  // eslint-disable-next-line no-new-func
  new Function('window', source)(fakeWindow);
  assert.equal(captured.length, 1, 'the bundle must register exactly one module');
  const entry = captured[0];
  assert.equal(entry.id, 'dsh-codex-session', 'the module id must equal the package name');

  const react = {
    createElement: (type, props, ...children) => ({
      type,
      props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children },
    }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useMemo: (factory) => factory(),
    useRef: (value) => ({ current: value }),
    useSyncExternalStore: (_subscribe, get) => get(),
  };
  const module = entry.factory((request) => {
    assert.equal(request, 'react', `the bundle must only require baseline modules, got ${request}`);
    return react;
  });
  assert.equal(typeof module.apply, 'function');
  return { module, react };
}

/** Minimal Cordis client context: records slot registrations and runs effects eagerly. */
function harness(module) {
  const registrations = [];
  const localeRegistrations = [];
  const remoteCalls = [];
  const ctx = {
    effect: (callback) => callback(),
    on: () => {},
    locale: {
      register: (ns, dictionaries) => {
        localeRegistrations.push({ ns, dictionaries });
        return () => {};
      },
      bind: () => (key) => key,
    },
    slots: {
      inject: (_name, callback) => callback(),
      register: (options, Component) => {
        registrations.push({ options, Component });
        return () => {};
      },
    },
    remote: {
      agentPresets: {
        list: async () => {
          remoteCalls.push(['agentPresets.list']);
          return { ok: true, value: { presets: [{ id: 'standard', isDefault: true }, { id: 'codex', name: 'Codex' }] } };
        },
        select: async (sessionId, id) => {
          remoteCalls.push(['agentPresets.select', sessionId, id]);
          return { ok: true, value: id };
        },
      },
      settings: {
        update: async (ns, patch, revision) => {
          remoteCalls.push(['settings.update', ns, patch, revision]);
          return { ok: true, value: null };
        },
      },
    },
  };
  module.apply(ctx);
  return { registrations, localeRegistrations, remoteCalls };
}

const textOf = (node) => {
  if (node === undefined || node === null || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  const children = node.props?.children;
  if (Array.isArray(children)) return children.map(textOf).join(' ');
  return textOf(children);
};

/** Every element with a click handler, so a test can press the component's controls. */
const pressables = (node, found = []) => {
  if (node === undefined || node === null || typeof node !== 'object') return found;
  if (typeof node.props?.onClick === 'function') found.push(node);
  const children = node.props?.children;
  if (Array.isArray(children)) children.forEach((child) => pressables(child, found));
  else pressables(children, found);
  return found;
};

test('apply registers the two shipped surfaces and both locale dictionaries', () => {
  const { module } = loadClientBundle();
  const { registrations, localeRegistrations } = harness(module);

  assert.deepEqual(
    registrations.map((registration) => registration.options.name),
    ['conversation.input.dock', 'settings.plugins.tab'],
  );
  for (const registration of registrations) {
    assert.equal(registration.options.id, 'codex-session');
  }
  assert.equal(localeRegistrations.length, 1);
  assert.equal(localeRegistrations[0].ns, 'codexSession');
  assert.ok(localeRegistrations[0].dictionaries.zh && localeRegistrations[0].dictionaries.en);
  assert.deepEqual(module.inject, ['slots', 'locale', 'remote', 'remote.agentPresets', 'remote.settings']);
});

test('the composer control renders the chooser on a blank session and switches to Codex', () => {
  const { module } = loadClientBundle();
  const { registrations, remoteCalls } = harness(module);
  const { options, Component } = registrations.find((r) => r.options.name === 'conversation.input.dock');

  const injected = options.inject('session-1');
  const tree = Component({
    locked: false,
    t: (key) => key,
    session: { blank: true },
    useProjection: () => 'standard',
    ...injected,
  });

  const text = textOf(tree);
  assert.match(text, /chooserLabel/);
  assert.match(text, /chooserDsh/);
  assert.match(text, /chooserCodex/);

  // Pressing "Codex" must ask the Host to switch this session's Agent preset.
  const codexButton = pressables(tree).find((node) => textOf(node) === 'chooserCodex');
  assert.ok(codexButton, 'the Codex option must be pressable');
  codexButton.props.onClick();
  return Promise.resolve().then(() => {
    assert.deepEqual(remoteCalls.at(-1), ['agentPresets.select', 'session-1', 'codex']);
  });
});

test('the composer control is a passive badge on a started Codex session', () => {
  const { module } = loadClientBundle();
  const { registrations } = harness(module);
  const { options, Component } = registrations.find((r) => r.options.name === 'conversation.input.dock');
  const tree = Component({
    locked: false,
    t: (key) => key,
    session: { blank: false },
    useProjection: () => 'codex',
    ...options.inject('session-2'),
  });
  const text = textOf(tree);
  assert.match(text, /Codex/);
  assert.doesNotMatch(text, /chooserLabel/, 'a started session shows no chooser');
  assert.equal(pressables(tree).length, 0, 'the badge is not interactive');
});

test('the composer control renders nothing for a started DSH-default session', () => {
  const { module } = loadClientBundle();
  const { registrations } = harness(module);
  const { options, Component } = registrations.find((r) => r.options.name === 'conversation.input.dock');
  assert.equal(
    Component({
      locked: false,
      t: (key) => key,
      session: { blank: false },
      useProjection: () => 'standard',
      ...options.inject('session-3'),
    }),
    null,
  );
});

test('the composer control stays inert when the owner locks the session', () => {
  const { module } = loadClientBundle();
  const { registrations } = harness(module);
  const { options, Component } = registrations.find((r) => r.options.name === 'conversation.input.dock');
  const tree = Component({
    locked: true,
    t: (key) => key,
    session: { blank: true },
    useProjection: () => 'standard',
    ...options.inject('session-4'),
  });
  assert.equal(textOf(tree), '', 'a locked session must not offer the switch');
  assert.equal(pressables(tree).length, 0);
});

test('the settings page renders before its roster arrives', () => {
  const { module } = loadClientBundle();
  const { registrations } = harness(module);
  const { options, Component } = registrations.find((r) => r.options.name === 'settings.plugins.tab');
  const tree = Component({ t: (key) => key, ...options.inject() });
  const text = textOf(tree);
  assert.match(text, /intro/);
  assert.match(text, /routeValue/);
  assert.match(text, /makeDefault/);
  assert.match(text, /rosterLoading/);
});

test('the settings page can make Codex the new-session default', async () => {
  const { module } = loadClientBundle();
  const { registrations, remoteCalls } = harness(module);
  const { options, Component } = registrations.find((r) => r.options.name === 'settings.plugins.tab');
  const tree = Component({ t: (key) => key, ...options.inject() });
  const button = pressables(tree).find((node) => textOf(node) === 'makeDefault');
  assert.ok(button, 'the default action must be pressable');
  button.props.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(remoteCalls.at(-1), [
    'settings.update',
    'agent-preset-registry',
    { selectedDefault: 'codex' },
    undefined,
  ]);
});
