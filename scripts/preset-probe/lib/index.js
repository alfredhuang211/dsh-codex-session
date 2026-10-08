/**
 * Test-only probe. Runs inside a real DSH host (web composition, so `sessionController` and the
 * Agent-preset registry are mounted) and reproduces exactly what the desktop UI does when you pick
 * "Codex" in the new-session picker: `sessionController.create({ agentPreset: 'codex' })`.
 *
 * It then records what the plugin did, so the assertion does not depend on reading a GUI:
 *   - the session log's `model/selection` event (the pinned route),
 *   - the deployment default before/after (it must be restored),
 *   - a `standard`-preset session (it must be left alone).
 */
import { writeFileSync } from 'node:fs';

export const name = 'preset-probe';
export const inject = ['sessionController', 'agents', 'agentDefaultModel', 'agentPresets'];

const selections = (agent) =>
  (agent?.session?.ownEvents?.() ?? [])
    .filter((event) => event.type === 'model/selection')
    .map((event) => event.data);

export function apply(ctx, config = {}) {
  // Record the Host events the plugin listens to, so a missing pin can be attributed to either
  // "the event never fired" or "the plugin did not act on it".
  const observed = [];
  ctx.on('agent-preset/selected', (sessionId, agentPreset) => {
    observed.push(['agent-preset/selected', sessionId, agentPreset]);
  });
  ctx.on('agent/created', (payload) => {
    observed.push(['agent/created', payload?.agent?.session?.header?.id ?? null]);
  });

  const out = config.out ?? '/tmp/dsh-codex-preset-pin/result.json';
  ctx.effect(() => {
    let cancelled = false;
    (async () => {
      const result = {};
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      try {
        result.defaultBefore = ctx.agentDefaultModel.currentSelection();

        const codex = await ctx.sessionController.create({ cwd: config.cwd, agentPreset: 'codex' });
        await wait(5000);
        const codexAgent = ctx.agents.get(codex.sessionId);
        result.codex = {
          created: codex,
          headerPreset: codexAgent?.session?.header?.agentPreset ?? null,
          modelSelections: selections(codexAgent),
        };
        result.defaultAfterCodex = ctx.agentDefaultModel.currentSelection();

        const dsh = await ctx.sessionController.create({ cwd: config.cwd, agentPreset: 'standard' });
        await wait(4000);
        const dshAgent = ctx.agents.get(dsh.sessionId);
        result.dshDefaultSession = {
          created: dsh,
          headerPreset: dshAgent?.session?.header?.agentPreset ?? null,
          modelSelections: selections(dshAgent),
        };
        result.defaultAfterDsh = ctx.agentDefaultModel.currentSelection();

        // 3. exactly what the composer chip does: switch an EXISTING session's preset in place.
        const agent = ctx.agents.get(dsh.sessionId);
        await ctx.agentPresets.select(agent, 'codex');
        await wait(4000);
        result.afterChipSwitch = {
          modelSelections: selections(ctx.agents.get(dsh.sessionId)),
        };
        result.defaultAfterChipSwitch = ctx.agentDefaultModel.currentSelection();
        result.observed = observed;

      } catch (error) {
        result.error = String(error?.stack ?? error);
      }
      if (!cancelled) writeFileSync(out, JSON.stringify(result, null, 2));
    })();
    return () => {
      cancelled = true;
    };
  }, 'preset-probe');
}
