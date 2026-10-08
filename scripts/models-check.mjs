/**
 * Prints the model catalogue this plugin would advertise, straight from the local Codex.
 *
 * Use it after upgrading Codex or changing the proxy behind it: whatever it prints is what the
 * composer's model picker will offer for a Codex session.
 *
 * Run: node scripts/models-check.mjs
 */

import { cpSync, mkdirSync, rmSync } from 'node:fs';

import { CodexAdapter } from '../lib/provider.js';

const CODEX_HOME = '/tmp/dsh-codex-models/codexhome';

rmSync('/tmp/dsh-codex-models', { recursive: true, force: true });
mkdirSync(CODEX_HOME, { recursive: true });
// The App Server needs a writable state DB, and this sandbox cannot write the real ~/.codex.
for (const file of ['auth.json', 'config.toml']) {
  cpSync(`/Users/alfredhuang/.codex/${file}`, `${CODEX_HOME}/${file}`);
}

const adapter = new CodexAdapter(
  {
    command: process.env.CODEX_COMMAND ?? '/opt/homebrew/bin/codex',
    env: { CODEX_HOME },
    disabledFeatures: [],
    handshakeTimeoutMs: 60000,
    maxJsonRpcLineBytes: 8 * 1024 * 1024,
    models: [],
    modelCacheTtlMs: 300000,
  },
  { debug: () => {}, warn: (m) => console.warn('[warn]', m) },
);

const models = await adapter.effectiveModels();
const defaultId = await adapter.defaultModelId();
await adapter.dispose();

console.log(`provider      : codex-local`);
console.log(`default model : ${defaultId}`);
console.log(`models (${models.length}):`);
for (const model of models) {
  console.log(
    `  ${model.isDefault === true ? '*' : ' '} ${model.id.padEnd(20)} ${model.name ?? ''}` +
      `${model.reasoningEfforts ? `  efforts=[${model.reasoningEfforts.join(',')}]` : ''}` +
      `${model.defaultReasoningEffort ? ` default=${model.defaultReasoningEffort}` : ''}`,
  );
}
