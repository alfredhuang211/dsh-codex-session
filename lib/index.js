/**
 * dsh-codex-session — Host half.
 *
 * Two independent jobs:
 *
 *  1. Register the `codex-local` LLM provider route (see `lib/provider.js`). A "Codex session" is
 *     an ordinary DSH session — DSH keeps the session log, the tool loop, approvals and the UI —
 *     whose model requests are served by the locally authenticated Codex App Server.
 *
 *  2. Pin that route onto sessions whose Agent preset is `codex` (declared by this bundle's
 *     `cordis.patch.yml`, so DSH's own new-session picker offers "Codex").
 *
 * They are deliberately decoupled. The provider needs only `llm`, so it registers in any
 * composition that has an LLM registry (including headless ones). The pinning half additionally
 * needs the API session controller, so it mounts through `ctx.inject` and simply stays dormant in
 * a composition that does not provide one.
 *
 * An Agent preset composes an Agent's child plugins but cannot choose the model route:
 * `sessionController` seeds every fresh Agent from `agentDefaultModel.currentSelection()`. So this
 * plugin watches Agent creation and installs the Session-local model selection for codex sessions.
 * `sessionController.selectModel` also saves the deployment default in the background, and a Codex
 * session must not become the default for later DSH sessions — so the previous default is restored
 * once the selection settled.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { CodexAdapter, CODEX_PROVIDER, DEFAULT_DISABLED_FEATURES } from './provider.js';

/** Loader entry id of this row. */
export const name = 'codex-session';

/** Only the LLM registry is required up front; the pinning half injects the rest lazily. */
export const inject = ['llm'];

const DEFAULTS = {
  preset: 'codex',
  provider: CODEX_PROVIDER,
  // `model` is intentionally unset: the session starts on whatever the local Codex reports as its
  // default model, so the plugin follows the machine instead of pinning a stale id.
  model: null,
  modelCacheTtlMs: 300000,
  modelProvider: null,
  command: 'codex',
  timeoutMs: 300000,
  handshakeTimeoutMs: 60000,
  disposeGraceMs: 3000,
  maxJsonRpcLineBytes: 8388608,
  maxStderrBytes: 65536,
  maxCachedSessions: 4,
  sessionIdleTimeoutMs: 600000,
};

/** Well-known Codex CLI locations, used when a bare command name is not on the Host's PATH. */
const COMMAND_CANDIDATES = [
  '/opt/homebrew/bin/codex',
  '/usr/local/bin/codex',
  '/usr/bin/codex',
  join(homedir(), '.local', 'bin', 'codex'),
  join(homedir(), '.codex', 'bin', 'codex'),
  '/Applications/Codex.app/Contents/Resources/codex',
];

/**
 * Resolve the CLI once. A GUI-launched Host often has a minimal PATH, so an absolute path is
 * preferred and well-known install locations are probed before giving up.
 */
function resolveCommand(configured) {
  if (configured.includes('/')) return configured;
  for (const candidate of COMMAND_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return configured;
}

function normalizeConfig(config) {
  const models = Array.isArray(config.models) ? config.models : [];
  return {
    preset: config.preset ?? DEFAULTS.preset,
    provider: config.provider ?? DEFAULTS.provider,
    model: config.model ?? DEFAULTS.model,
    modelCacheTtlMs: config.modelCacheTtlMs ?? DEFAULTS.modelCacheTtlMs,
    modelProvider: config.modelProvider ?? DEFAULTS.modelProvider,
    command: resolveCommand(config.command ?? DEFAULTS.command),
    timeoutMs: config.timeoutMs ?? DEFAULTS.timeoutMs,
    handshakeTimeoutMs: config.handshakeTimeoutMs ?? DEFAULTS.handshakeTimeoutMs,
    disposeGraceMs: config.disposeGraceMs ?? DEFAULTS.disposeGraceMs,
    maxJsonRpcLineBytes: config.maxJsonRpcLineBytes ?? DEFAULTS.maxJsonRpcLineBytes,
    maxStderrBytes: config.maxStderrBytes ?? DEFAULTS.maxStderrBytes,
    maxCachedSessions: config.maxCachedSessions ?? DEFAULTS.maxCachedSessions,
    sessionIdleTimeoutMs: config.sessionIdleTimeoutMs ?? DEFAULTS.sessionIdleTimeoutMs,
    env: config.env ?? {},
    disabledFeatures: Array.isArray(config.disabledFeatures)
      ? config.disabledFeatures
      : DEFAULT_DISABLED_FEATURES,
    models,
  };
}

function selectionOf(config) {
  const selection = { provider: config.provider, model: config.model };
  if (config.reasoningEffort !== undefined) selection.reasoningEffort = config.reasoningEffort;
  return selection;
}

/**
 * Wait until the deployment default actually reports `target`.
 *
 * `sessionController.selectModel` persists the selection in the BACKGROUND, so right after it
 * resolves `currentSelection()` still returns the previous value. Reading it once here would look
 * like "someone else already moved the default" and skip the restore — and then the background
 * write lands, leaving every later DSH-default session routed to Codex.
 */
async function defaultSettledTo(agentDefaultModel, target, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (sameSelection(agentDefaultModel.currentSelection(), target)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }
}

/** Narrow an unknown service value to a model selection, or `undefined`. */
function asSelection(value) {
  if (value === null || typeof value !== 'object') return undefined;
  if (typeof value.provider !== 'string' || typeof value.model !== 'string') return undefined;
  return {
    provider: value.provider,
    model: value.model,
    ...(typeof value.reasoningEffort === 'string' ? { reasoningEffort: value.reasoningEffort } : {}),
  };
}

/** Route identity: provider + model only. The effort is a materialized default, not a choice. */
function sameRoute(a, b) {
  return a !== undefined && b !== undefined && a.provider === b.provider && a.model === b.model;
}

function sameSelection(a, b) {
  return (
    a !== undefined &&
    b !== undefined &&
    a.provider === b.provider &&
    a.model === b.model &&
    (a.reasoningEffort ?? null) === (b.reasoningEffort ?? null)
  );
}

export function apply(ctx, config = {}) {
  const resolved = normalizeConfig(config);

  //#region 1. the codex-local provider

  const adapter = new CodexAdapter(resolved, ctx.logger);
  ctx.effect(() => {
    const handle = ctx.llm.registerAdapter([resolved.provider], adapter);
    return async () => {
      try {
        handle?.();
      } finally {
        await adapter.dispose();
      }
    };
  }, 'dsh-codex-session: codex-local provider');

  ctx.logger?.debug?.(
    `dsh-codex-session: registered ${resolved.provider} via ${resolved.command} ` +
      `(model provider "${resolved.modelProvider}")`,
  );

  //#endregion

  //#region 2. pin the route for codex-preset sessions (only where a session controller exists)

  ctx.inject(['agents', 'agentDefaultModel', 'sessionController'], (scope) => {
    /**
     * The selection a codex session is pinned to.
     *
     * Resolved lazily because the model may come from the local Codex itself: with no `model` in the
     * config, the session starts on whatever the machine reports as its default, so the plugin
     * follows an upgraded Codex instead of pinning an id that no longer exists.
     */
    let wanted;
    const resolveWanted = async () => {
      if (wanted !== undefined) return wanted;
      const model = resolved.model ?? (await adapter.defaultModelId());
      wanted = selectionOf({ ...resolved, model, reasoningEffort: config.reasoningEffort });
      return wanted;
    };

    /** Sessions currently being pinned, so a repeated announcement cannot re-enter. */
    const inFlight = new Set();
    const presetOf = (agent) => agent?.session?.header?.agentPreset;

    /**
     * `expected` is the preset the caller already resolved.
     *
     * It cannot be re-read from the header: a session that SWITCHES preset keeps the header it was
     * created with, and only the `agent-preset/selected` event carries the new identity. Re-checking
     * the header there silently skipped the switch (caught by scripts/verify-preset-pin.sh).
     */
    const pin = async (agent, source, expected) => {
      if (agent === undefined) return;
      const actual = expected ?? presetOf(agent);
      if (actual !== resolved.preset) return;
      const sessionId = agent.session.header.id;
      if (inFlight.has(sessionId)) return;
      inFlight.add(sessionId);
      try {
        const selection = await resolveWanted();
        const label = `${selection.provider}/${selection.model}`;
        const previous = scope.agentDefaultModel.currentSelection();
        if (sameRoute(previous, selection)) return; // already routed to this provider+model

        // `selectModel` returns the RESOLVED selection: it materializes the adapter's default
        // reasoning effort, so the recorded selection can carry an effort our config never named.
        const installed = asSelection(
          (await scope.sessionController.selectModel({ sessionId, ...selection }))?.selected,
        ) ?? selection;

        // `selectModel` persisted the Codex route as the deployment default too. Put the previous
        // default back — but only once that background write has actually landed, and only if the
        // default now really is ours: a concurrent user change to something else wins.
        if (!(await defaultSettledTo(scope.agentDefaultModel, installed))) return;
        try {
          await scope.agentDefaultModel.saveSelection(previous);
        } catch (error) {
          ctx.logger?.warn?.(
            `dsh-codex-session: session ${sessionId} is on ${label} but the previous deployment default ` +
              `(${previous.provider}/${previous.model}) could not be restored: ${String(error)}`,
          );
        }
      } catch (error) {
        ctx.logger?.warn?.(
          `dsh-codex-session: could not route session ${sessionId} to the Codex route from ${source}: ${String(error)}`,
        );
      } finally {
        inFlight.delete(sessionId);
      }
    };

    // A fresh Agent is entered and announced here; its preset is already recorded.
    scope.on('agent/created', (payload) => pin(payload.agent, 'agent/created'));

    // Switching an existing session to the Codex preset re-pins it in place.
    scope.on('agent-preset/selected', (sessionId, agentPreset) => {
      if (agentPreset !== resolved.preset) return;
      return pin(scope.agents.get(sessionId), 'agent-preset/selected', agentPreset);
    });

    ctx.logger?.debug?.(
      `dsh-codex-session: preset "${resolved.preset}" pins its sessions to ` +
        `${resolved.provider}/${resolved.model ?? '(local Codex default)'}`,
    );
  });

  //#endregion
}
