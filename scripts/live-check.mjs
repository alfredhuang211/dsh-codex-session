/**
 * Live acceptance check for the codex-local provider.
 *
 * Drives the REAL adapter against the REAL local Codex App Server with a stub Host context, so no
 * DSH runtime is needed. Three steps, each designed so that a broken implementation cannot pass:
 *
 *   step 1  Codex calls the bridged Harness tool
 *           -> tool-call block + finish{tool-calls}, RPC left pending
 *   step 2  the Harness tool result carries a RANDOM token the model has never seen
 *           -> the assistant can only echo that token if the result really reached Codex
 *   step 3  a follow-up user message on the same session (append-only continuation)
 *           -> the token comes back again, and the same lease object is reused
 *
 * The token is generated here and never appears in any prompt, so a dropped tool result
 * (e.g. treating a DSH tool result as an ordinary user message) fails step 2 instead of
 * silently passing on an inferable answer.
 *
 * Run: node scripts/live-check.mjs
 */

import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

import { CodexAdapter, DEFAULT_MODELS } from '../lib/provider.js';

const CODEX_HOME = '/tmp/dsh-codex-live/codexhome';
const SESSION_ID = 'session-live-check';
const MODEL = 'gpt-5.5';
const TOKEN = `TOKEN-${randomBytes(6).toString('hex').toUpperCase()}`;

function prepareHome() {
  rmSync('/tmp/dsh-codex-live', { recursive: true, force: true });
  mkdirSync(CODEX_HOME, { recursive: true });
  // The real ~/.codex is not writable from this sandbox and the App Server needs a writable
  // state database, so the native login state is copied into a private home.
  for (const file of ['auth.json', 'config.toml']) {
    cpSync(`/Users/alfredhuang/.codex/${file}`, `${CODEX_HOME}/${file}`);
  }
}

function log(prefix, chunk) {
  if (chunk.type === 'finish') return console.log(`${prefix} finish ${JSON.stringify(chunk.reason)}`);
  if (chunk.type === 'usage') return console.log(`${prefix} usage ${JSON.stringify(chunk.usage)}`);
  console.log(`${prefix} ${JSON.stringify(chunk)}`);
}

const tools = [
  {
    name: 'echo',
    description: 'Echo a message back to the caller.',
    parameters: {
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
      additionalProperties: false,
    },
  },
];

prepareHome();

const adapter = new CodexAdapter(
  {
    command: '/opt/homebrew/bin/codex',
    env: { CODEX_HOME },
    models: DEFAULT_MODELS,
    timeoutMs: 180000,
    disposeGraceMs: 3000,
    maxJsonRpcLineBytes: 8 * 1024 * 1024,
    maxStderrBytes: 65536,
    maxCachedSessions: 4,
    sessionIdleTimeoutMs: 600000,
  },
  { debug: () => {}, warn: (m) => console.warn('[warn]', m) },
);

const system = 'You are a coding agent. Use the provided tools when asked and never invent tool output.';

/** Run one step and collect what the assertions need. */
async function step(prefix, messages) {
  let toolCall;
  let text = '';
  const reasons = [];
  for await (const chunk of adapter.stream({
    provider: 'codex-local',
    model: MODEL,
    sessionId: SESSION_ID,
    system,
    tools,
    messages,
  })) {
    log(prefix, chunk);
    if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') toolCall = chunk.block;
    if (chunk.type === 'text-delta') text += chunk.text;
    if (chunk.type === 'finish') reasons.push(chunk.reason.kind);
  }
  return { toolCall, text, reasons };
}

const failures = [];
const check = (ok, label) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) failures.push(label);
};

// ---- step 1 -------------------------------------------------------------------------------
console.log(`--- step 1 (expect tool-call + finish{tool-calls}); hidden token ${TOKEN} ---`);
const messages1 = [
  {
    role: 'user',
    content: [{ type: 'text', text: 'Call the deepseek_harness echo tool with message "hi". Do not guess the result.' }],
  },
];
const r1 = await step('  [1]', messages1);
check(r1.toolCall !== undefined, 'step 1 produced a Harness tool-call block');
check(r1.reasons.includes('tool-calls'), 'step 1 finished with tool-calls');
const leaseAfter1 = adapter.leases.get(SESSION_ID);
check(leaseAfter1 !== undefined, 'step 1 left a live lease for the session');

if (r1.toolCall === undefined) {
  await adapter.dispose();
  console.log('\nFAIL: no tool call, cannot continue');
  process.exit(1);
}

// ---- step 2: the tool result carries the hidden token --------------------------------------
console.log('--- step 2 (the tool result is the only source of the token) ---');
const messages2 = [
  ...messages1,
  { role: 'assistant', content: [{ type: 'tool-call', id: r1.toolCall.id, name: r1.toolCall.name, arguments: r1.toolCall.arguments }] },
  // The REAL DSH shape: a tool result is a USER-role message carrying a `tool-result` block
  // (see @deepseek-ai/dsh-llm createToolResultMessage). Feeding the simplified `role:'tool'`
  // form here would hide exactly the bug this step exists to catch.
  {
    role: 'user',
    source: { kind: 'tool', callId: r1.toolCall.id },
    content: [
      { type: 'tool-result', toolCallId: r1.toolCall.id, content: [{ type: 'text', text: TOKEN }], isError: false },
    ],
  },
];
const r2 = await step('  [2]', messages2);
check(r2.reasons.length === 1 && r2.reasons[0] !== 'error', 'step 2 finished cleanly');
check(r2.text.includes(TOKEN), 'step 2 assistant text contains the tool-supplied token');
check(adapter.leases.get(SESSION_ID) === leaseAfter1, 'step 2 reused the same lease (no cold restart)');

// ---- step 3: append-only continuation ------------------------------------------------------
console.log('--- step 3 (append-only continuation on the same thread) ---');
const messages3 = [
  ...messages2,
  { role: 'assistant', content: [{ type: 'text', text: r2.text }] },
  { role: 'user', content: [{ type: 'text', text: 'Repeat the exact tool output you received. Reply with that value only.' }] },
];
const r3 = await step('  [3]', messages3);
check(r3.reasons.length === 1 && r3.reasons[0] !== 'error', 'step 3 finished cleanly');
check(r3.text.includes(TOKEN), 'step 3 still knows the token after an append-only continuation');
check(adapter.leases.get(SESSION_ID) === leaseAfter1, 'step 3 reused the same lease');

await adapter.dispose();

console.log('--- verdict ---');
console.log('step finishes:', [r1.reasons, r2.reasons, r3.reasons].map((r) => r.join(',')).join(' | '));
if (failures.length > 0) {
  console.log(`FAIL (${failures.length}): ${failures.join('; ')}`);
  process.exit(1);
}
console.log('PASS: live tool round trip, tool-result fidelity and thread reuse all verified');
