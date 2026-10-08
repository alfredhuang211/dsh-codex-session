/**
 * codex-local — a DSH LLM provider backed by the locally authenticated Codex App Server.
 *
 * DSH owns the session log, the tool loop, approvals and the UI. This adapter owns exactly one
 * thing: turning one Harness model step into one Codex App Server turn, and translating the
 * App Server's notifications back into Harness `StreamChunk`s. Harness tools are declared to
 * Codex under the `deepseek_harness` namespace; when Codex calls one, the adapter ends the step
 * with a real Harness `tool-call` and keeps the JSON-RPC request pending until the next step
 * carries the tool result back.
 *
 * IMPORTANT: this file must never `import` an `@deepseek-ai/*` package. On DSH desktop
 * 0.2.0-rc.2 an out-of-tree Host plugin cannot resolve them (verified with a control plugin and
 * a full boot). Only `node:*` built-ins are used.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Provider route this adapter serves. */
export const CODEX_PROVIDER = 'codex-local';
/** App Server namespace whose callbacks belong to the outer Harness tool loop. */
export const HARNESS_TOOL_NAMESPACE = 'deepseek_harness';

const SAFE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;

/**
 * Codex integrations switched OFF for a DSH-driven thread.
 *
 * DSH owns the tool loop, the approval prompt and the trajectory, so a Codex-native capability that
 * reaches the machine on its own would silently bypass all three: it would not appear in the
 * transcript, would not be sandboxed by DSH, and would not be governed by DSH's approval policy.
 * `shell_tool` / `unified_exec` are the important ones — with them on, Codex runs its own
 * `commandExecution` instead of the Harness `bash` tool (verified against the local CLI).
 *
 * Override with the `disabledFeatures` config key; an empty list restores stock Codex behaviour.
 */
export const DEFAULT_DISABLED_FEATURES = [
  'apps',
  'browser_use',
  'browser_use_external',
  'browser_use_full_cdp_access',
  'computer_use',
  'hooks',
  'in_app_browser',
  'mcp_2026_07_28',
  'multi_agent',
  'multi_agent_v2',
  'plugins',
  'remote_plugin',
  'request_permissions_tool',
  'shell_tool',
  'skill_search',
  'standalone_web_search',
  'tool_call_mcp_elicitation',
  'unified_exec',
];

/** How long a discovered catalogue is reused before asking the CLI again. */
export const DEFAULT_MODEL_CACHE_TTL_MS = 300000;
/** Last-resort model when neither config nor `model/list` yields one. */
export const FALLBACK_MODEL = 'gpt-5.5';

/** Model catalogue used when the Loader entry config does not declare one AND discovery fails. */
export const DEFAULT_MODELS = [
  {
    id: 'gpt-5.5',
    name: 'GPT-5.5',
    description: 'Frontier model for complex coding, research, and real-world work.',
    contextWindow: 1050000,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    defaultReasoningEffort: 'medium',
  },
  {
    id: 'gpt-5.6-sol',
    name: 'GPT-5.6-Sol',
    description: 'Latest frontier agentic coding model.',
    contextWindow: 1050000,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    defaultReasoningEffort: 'low',
  },
  {
    id: 'gpt-5.6-terra',
    name: 'GPT-5.6-Terra',
    description: 'Balanced agentic coding model for everyday work.',
    contextWindow: 1050000,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    defaultReasoningEffort: 'medium',
  },
  {
    id: 'gpt-5.6-luna',
    name: 'GPT-5.6-Luna',
    description: 'Fast and affordable agentic coding model.',
    contextWindow: 1050000,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultReasoningEffort: 'medium',
  },
  {
    id: 'gpt-5.4',
    name: 'GPT-5.4',
    description: 'Strong model for everyday coding.',
    contextWindow: 1050000,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    defaultReasoningEffort: 'medium',
  },
  {
    id: 'gpt-5.4-mini',
    name: 'GPT-5.4-Mini',
    description: 'Small, fast, and cost-efficient model for simpler coding tasks.',
    contextWindow: 400000,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    defaultReasoningEffort: 'medium',
  },
  {
    id: 'gpt-5.3-codex-spark',
    name: 'GPT-5.3-Codex-Spark',
    description: 'Ultra-fast coding model.',
    contextWindow: 128000,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    defaultReasoningEffort: 'high',
  },
];

//#region small helpers

function asObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

/** Harness tool names are aliased so they can never collide with a Codex-native tool. */
export function mapToolName(name) {
  return `harness_${String(name).replace(/[^A-Za-z0-9._-]/gu, '_')}`;
}

/** Flatten a content-block array to plain text (used for tool results and fallbacks). */
function flattenText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    const b = asObject(block);
    if (b === undefined) continue;
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    else if (b.type === 'image') parts.push('[image attachment omitted]');
    else if (b.type === 'file' && typeof b.name === 'string') parts.push(`[file ${b.name}]`);
  }
  return parts.join('\n');
}

/**
 * The tool result carried by one Harness message, if any.
 *
 * Real DSH tool results are `role:'user'` messages with `source.kind:'tool'` and a single
 * `{type:'tool-result', toolCallId, content, isError}` block (see `createToolResultMessage`).
 * Older/simplified callers use `role:'tool'` with plain content. Both are accepted here.
 */
function toolResultOf(message) {
  const m = asObject(message);
  if (m === undefined) return undefined;
  const source = asObject(m.source);
  const isToolSource = m.role === 'tool' || source?.kind === 'tool';
  if (!isToolSource) return undefined;
  const callId = m.toolCallId ?? source?.callId;
  for (const rawBlock of Array.isArray(m.content) ? m.content : []) {
    const block = asObject(rawBlock);
    if (block?.type !== 'tool-result') continue;
    return {
      callId: String(block.toolCallId ?? callId ?? ''),
      text: flattenText(block.content),
      isError: block.isError === true,
    };
  }
  if (m.role === 'tool' && callId !== undefined) {
    return { callId: String(callId), text: flattenText(m.content), isError: m.isError === true };
  }
  return undefined;
}

/** Stable stringify so a lease can compare request shapes cheaply. */
function fingerprint(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

//#endregion

//#region transport

/**
 * Newline-delimited JSON-RPC 2.0 over one child process.
 *
 * The incoming queue is persistent: between two Harness steps the App Server keeps talking (it is
 * still inside an open turn while a Harness tool runs), so frames must be buffered rather than
 * dropped when nobody is iterating.
 */
class JsonRpc {
  #child;
  #maxLineBytes;
  #pending = new Map();
  #nextId = 1;
  #queue = [];
  #waiter;
  #buffer = '';
  #failure;
  #closed = false;

  constructor(child, maxLineBytes) {
    this.#child = child;
    this.#maxLineBytes = maxLineBytes;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.#onData(chunk));
    child.stdout.on('end', () => this.#fail(new Error('Codex App Server closed its stdout')));
    child.stdout.on('error', (error) => this.#fail(error));
  }

  #onData(chunk) {
    this.#buffer += chunk;
    let index;
    while ((index = this.#buffer.indexOf('\n')) >= 0) {
      const line = this.#buffer.slice(0, index);
      this.#buffer = this.#buffer.slice(index + 1);
      if (line.trim().length === 0) continue;
      if (Buffer.byteLength(line, 'utf8') > this.#maxLineBytes) {
        this.#fail(new Error('Codex App Server sent an oversized JSON-RPC frame'));
        return;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue; // diagnostics on stdout are ignored rather than fatal
      }
      this.#dispatch(message);
    }
  }

  #dispatch(message) {
    const frame = asObject(message);
    if (frame === undefined) return;
    if (frame.method === undefined) {
      const pending = this.#pending.get(frame.id);
      if (pending === undefined) return;
      this.#pending.delete(frame.id);
      if (frame.error !== undefined) pending.reject(new Error(frame.error.message ?? 'Codex App Server error'));
      else pending.resolve(frame.result);
      return;
    }
    const kind = frame.id === undefined ? 'notification' : 'request';
    this.#push({ kind, id: frame.id, method: String(frame.method), params: asObject(frame.params) ?? {} });
  }

  #push(item) {
    this.#queue.push(item);
    const waiter = this.#waiter;
    this.#waiter = undefined;
    if (waiter !== undefined) waiter();
  }

  #fail(error) {
    if (this.#failure === undefined) this.#failure = error;
    for (const [, pending] of this.#pending) pending.reject(error);
    this.#pending.clear();
    const waiter = this.#waiter;
    this.#waiter = undefined;
    if (waiter !== undefined) waiter();
  }

  request(method, params) {
    const id = this.#nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#child.stdin.write(`${payload}\n`, (error) => {
        if (error === undefined || error === null) return;
        this.#pending.delete(id);
        reject(error);
      });
    });
  }

  notify(method, params) {
    this.#child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  respond(id, result) {
    this.#child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
  }

  respondError(id, code, message) {
    this.#child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
  }

  /** Next server frame, or `done` once the process is gone and the queue drained. */
  async next() {
    for (;;) {
      if (this.#queue.length > 0) return { value: this.#queue.shift(), done: false };
      if (this.#failure !== undefined) throw this.#failure;
      if (this.#closed) return { value: undefined, done: true };
      await new Promise((resolve) => {
        this.#waiter = resolve;
      });
    }
  }

  close() {
    this.#closed = true;
    const waiter = this.#waiter;
    this.#waiter = undefined;
    if (waiter !== undefined) waiter();
  }
}

//#endregion

/** Race a promise against a deadline; `onTimeout` runs once the deadline wins. */
function withDeadline(promise, ms, onTimeout) {
  // A missing or nonsensical bound must never mean "expire immediately".
  const delay = Number.isFinite(ms) && ms > 0 ? ms : 60000;
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try {
        onTimeout?.();
      } catch {
        /* the timeout itself is the signal; cleanup failures are not worth masking it */
      }
      reject(new Error(`Codex App Server did not answer within ${delay}ms`));
    }, delay);
  });
  timer?.unref?.();
  promise.catch(() => {}); // the race decides; never surface an unhandled rejection
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

//#region request translation

/**
 * Convert the Harness request into App Server items.
 *
 * The Harness session log is authoritative, so the whole App Server-visible conversation is
 * rebuilt from `options.messages` on every cold start.
 */
export function historyItems(messages) {
  const items = [];
  for (const raw of messages ?? []) {
    const message = asObject(raw);
    if (message === undefined) continue;
    const content = Array.isArray(message.content) ? message.content : [];
    const toolResult = toolResultOf(message);
    if (toolResult !== undefined) {
      items.push({
        type: 'function_call_output',
        call_id: toolResult.callId,
        output: [{ type: 'input_text', text: toolResult.text }],
      });
      continue;
    }
    if (message.role === 'user') {
      const parts = [];
      for (const block of content) {
        const b = asObject(block);
        if (b === undefined) continue;
        if (b.type === 'text' && typeof b.text === 'string') parts.push({ type: 'input_text', text: b.text });
        else if (b.type === 'image') parts.push({ type: 'input_text', text: '[image attachment omitted]' });
        else if (b.type === 'file' && typeof b.name === 'string') parts.push({ type: 'input_text', text: `[file ${b.name}]` });
      }
      if (parts.length > 0) items.push({ type: 'message', role: 'user', content: parts });
      continue;
    }
    if (message.role === 'assistant') {
      const texts = [];
      for (const block of content) {
        const b = asObject(block);
        if (b === undefined) continue;
        if (b.type === 'text' && typeof b.text === 'string') texts.push({ type: 'output_text', text: b.text });
        else if (b.type === 'tool-call' && typeof b.name === 'string' && b.id !== undefined) {
          items.push({
            type: 'function_call',
            name: mapToolName(b.name),
            arguments: typeof b.arguments === 'string' ? b.arguments : '{}',
            call_id: String(b.id),
            namespace: HARNESS_TOOL_NAMESPACE,
          });
        }
      }
      if (texts.length > 0) items.push({ type: 'message', role: 'assistant', content: texts });
      continue;
    }
  }
  return items;
}

/** Declare the Harness tool catalogue to Codex under the ownership namespace. */
export function dynamicTools(tools) {
  const declared = [];
  for (const raw of tools ?? []) {
    const tool = asObject(raw);
    if (tool === undefined || typeof tool.name !== 'string') continue;
    const mapped = mapToolName(tool.name);
    if (!SAFE_MODEL_ID.test(mapped)) continue;
    declared.push({
      type: 'function',
      name: mapped,
      description: typeof tool.description === 'string' ? tool.description : tool.name,
      inputSchema: asObject(tool.parameters) ?? { type: 'object', properties: {} },
    });
  }
  if (declared.length === 0) return [];
  return [
    {
      type: 'namespace',
      name: HARNESS_TOOL_NAMESPACE,
      description: 'Tools provided by the outer DeepSeek Harness agent loop.',
      tools: declared,
    },
  ];
}

/** Reverse lookup for one callback, or `undefined` when Codex named something we never declared. */
export function originalToolName(mapped, tools) {
  for (const raw of tools ?? []) {
    const tool = asObject(raw);
    if (tool === undefined || typeof tool.name !== 'string') continue;
    if (mapToolName(tool.name) === mapped) return tool.name;
  }
  return undefined;
}

//#endregion

//#region event -> chunk mapping

/**
 * Stateful translation of one App Server turn into indexed Harness blocks.
 *
 * Harness requires `block-start` / deltas / `block-end` per block with a stable index, so open
 * blocks are keyed by the App Server item id and closed when that item completes.
 */
export class StepMapper {
  #nextIndex = 0;
  #open = new Map(); // itemId -> { index, blockType, text, call? }
  #lastTextBlock;
  #usage;
  #failure;

  accept(event) {
    const chunks = [];
    if (event.kind === 'notification') {
      const method = event.method;
      if (method === 'item/started') {
        const item = asObject(event.params.item);
        if (item !== undefined) chunks.push(...this.#openItem(item));
      } else if (method === 'item/agentMessage/delta') {
        chunks.push(...this.#delta(String(event.params.itemId ?? ''), 'text', String(event.params.delta ?? '')));
      } else if (method === 'item/reasoning/textDelta' || method === 'item/reasoning/summaryTextDelta') {
        chunks.push(...this.#delta(String(event.params.itemId ?? ''), 'reasoning', String(event.params.delta ?? '')));
      } else if (method === 'item/completed') {
        const item = asObject(event.params.item);
        if (item !== undefined) chunks.push(...this.#closeItem(item));
      } else if (method === 'thread/tokenUsage/updated') {
        const tokenUsage = asObject(event.params.tokenUsage);
        const usage = asObject(tokenUsage?.last) ?? asObject(tokenUsage?.total);
        if (usage !== undefined) this.#usage = usage;
      }
      return chunks;
    }
    if (event.kind === 'turn-failed') {
      this.#failure = { message: event.message, code: event.code };
      return chunks;
    }
    return chunks;
  }

  #openItem(item) {
    const id = typeof item.id === 'string' ? item.id : undefined;
    if (item.type === 'agentMessage') {
      return this.#start(id, 'text');
    }
    if (item.type === 'reasoning') {
      return this.#start(id, 'reasoning');
    }
    return [];
  }

  #start(id, blockType) {
    const index = this.#nextIndex++;
    if (id !== undefined) this.#open.set(id, { index, blockType, text: '' });
    return [{ type: 'block-start', index, blockType }];
  }

  #delta(id, blockType, text) {
    if (text.length === 0) return [];
    let entry = this.#open.get(id);
    if (entry === undefined) {
      // Some App Server versions stream deltas without a preceding item/started.
      const chunks = this.#start(id, blockType);
      entry = this.#open.get(id);
      if (entry === undefined) return chunks;
      chunks.push({ type: 'text-delta', index: entry.index, text: text });
      entry.text += text;
      return chunks;
    }
    if (entry.blockType !== blockType) return [];
    entry.text += text;
    return [{ type: blockType === 'reasoning' ? 'reasoning-delta' : 'text-delta', index: entry.index, text }];
  }

  #closeItem(item) {
    const id = typeof item.id === 'string' ? item.id : undefined;
    if (id === undefined) return [];
    const entry = this.#open.get(id);
    if (entry === undefined) return [];
    this.#open.delete(id);
    const text = typeof item.text === 'string' && item.text.length > 0 ? item.text : entry.text;
    if (entry.blockType === 'text' && text.length > 0) this.#lastTextBlock = true;
    return [
      {
        type: 'block-end',
        index: entry.index,
        block: entry.blockType === 'reasoning' ? { type: 'reasoning', text } : { type: 'text', text },
      },
    ];
  }

  /** Publish a Harness-owned tool call, then end the step while the RPC stays pending. */
  toolCall(index, { id, name, arguments: args }) {
    return [
      { type: 'block-start', index, blockType: 'tool-call' },
      { type: 'block-end', index, block: { type: 'tool-call', id, name, arguments: args } },
    ];
  }

  /** Close every block still open at a terminal event. */
  closeOpen() {
    const chunks = [];
    for (const [id, entry] of [...this.#open.entries()]) {
      this.#open.delete(id);
      const text = entry.text;
      if (entry.blockType === 'text' && text.length === 0) continue;
      chunks.push({
        type: 'block-end',
        index: entry.index,
        block: entry.blockType === 'reasoning' ? { type: 'reasoning', text } : { type: 'text', text },
      });
    }
    return chunks;
  }

  get sawText() {
    return this.#lastTextBlock === true;
  }

  usageChunk() {
    if (this.#usage === undefined) return undefined;
    const total = asObject(this.#usage);
    if (total === undefined) return undefined;
    // DSH TokenUsage counts are DISJOINT: `inputTokens` is uncached input only, and
    // Codex reports cached tokens inside `inputTokens`, so subtract them back out.
    const rawInput = Number(total.inputTokens ?? 0);
    const cacheRead = Number(total.cachedInputTokens ?? 0);
    const cacheWrite = Number(total.cacheWriteInputTokens ?? 0);
    const inputTokens = Math.max(0, rawInput - cacheRead - cacheWrite);
    const outputTokens = Number(total.outputTokens ?? 0);
    return {
      type: 'usage',
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: Number(total.totalTokens ?? inputTokens + cacheRead + cacheWrite + outputTokens),
        cacheReadTokens: cacheRead,
        ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
        reasoningTokens: Number(total.reasoningOutputTokens ?? 0),
      },
    };
  }

  get failure() {
    return this.#failure;
  }
}

//#endregion

//#region model discovery

/**
 * Map `model/list` rows onto the catalogue shape this adapter keeps internally.
 *
 * The CLI is the authority on what this machine can actually run, so the picker is built from this
 * rather than from a guess baked into the plugin. Hidden rows are skipped: Codex hides them from
 * its own picker, and offering them here produced models the local install refuses.
 */
export function mapDiscoveredModels(entries) {
  const rows = [];
  for (const raw of Array.isArray(entries) ? entries : []) {
    const entry = asObject(raw);
    if (entry === undefined || entry.hidden === true) continue;
    const id = typeof entry.id === 'string' ? entry.id : typeof entry.model === 'string' ? entry.model : undefined;
    if (id === undefined || !SAFE_MODEL_ID.test(id)) continue;
    const efforts = (Array.isArray(entry.supportedReasoningEfforts) ? entry.supportedReasoningEfforts : [])
      .map((effort) => asObject(effort)?.reasoningEffort)
      .filter((effort) => typeof effort === 'string');
    rows.push({
      id,
      name: typeof entry.displayName === 'string' && entry.displayName.length > 0 ? entry.displayName : id,
      ...(typeof entry.description === 'string' && entry.description.length > 0
        ? { description: entry.description }
        : {}),
      ...(efforts.length === 0 ? {} : { reasoningEfforts: efforts }),
      ...(typeof entry.defaultReasoningEffort === 'string'
        ? { defaultReasoningEffort: entry.defaultReasoningEffort }
        : {}),
      isDefault: entry.isDefault === true,
    });
  }
  return rows;
}

/** Ask the local Codex which models it offers: one short-lived process, no thread. */
export async function queryAppServerModels(options) {
  const workdir = await mkdtemp(join(tmpdir(), 'dsh-codex-models-'));
  const spawnProcess = options.spawn ?? spawn;
  const disabled = (options.disabledFeatures ?? []).flatMap((feature) => ['--disable', feature]);
  const child = spawnProcess(options.command, ['app-server', '--stdio', ...disabled], {
    cwd: workdir,
    env: { ...process.env, ...options.env, CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'deepseek-harness' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-4096);
  });
  const rpc = new JsonRpc(child, options.maxJsonRpcLineBytes);
  try {
    await withDeadline(
      rpc.request('initialize', {
        clientInfo: { name: 'deepseek-harness', title: 'DeepSeek Harness', version: '0.1.0' },
        capabilities: { experimentalApi: true, requestAttestation: false },
      }),
      options.handshakeTimeoutMs,
      () => child.kill('SIGKILL'),
    );
    rpc.notify('initialized', {});
    const listed = asObject(
      await withDeadline(rpc.request('model/list', {}), options.handshakeTimeoutMs, () => child.kill('SIGKILL')),
    );
    const rows = Array.isArray(listed?.data) ? listed.data : Array.isArray(listed) ? listed : [];
    return mapDiscoveredModels(rows);
  } catch (error) {
    throw new Error(`Codex App Server model/list failed: ${stderr.trim() || String(error)}`);
  } finally {
    rpc.close();
    try {
      child.stdin.end();
    } catch {
      /* already gone */
    }
    child.kill('SIGKILL');
    await rm(workdir, { recursive: true, force: true }).catch(() => {});
  }
}

//#endregion

//#region adapter

/**
 * Spawn one App Server, start one ephemeral thread, and keep it for the session lease.
 */
async function openThread(options) {
  const workdir = await mkdtemp(join(tmpdir(), 'dsh-codex-session-'));
  const spawnProcess = options.spawn ?? spawn;
  const disabled = (options.disabledFeatures ?? []).flatMap((feature) => ['--disable', feature]);
  const child = spawnProcess(options.command, ['app-server', '--stdio', ...disabled], {
    cwd: workdir,
    env: { ...process.env, ...options.env, CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'deepseek-harness' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-options.maxStderrBytes);
  });
  const rpc = new JsonRpc(child, options.maxJsonRpcLineBytes);
  const exited = new Promise((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
    child.once('error', (error) => resolve({ code: -1, signal: String(error) }));
  });

  const fail = (error) => {
    throw error instanceof Error ? error : new Error(String(error));
  };

  try {
    await withDeadline(
      rpc.request('initialize', {
        clientInfo: { name: 'deepseek-harness', title: 'DeepSeek Harness', version: '0.1.0' },
        capabilities: { experimentalApi: true, requestAttestation: false },
      }),
      options.handshakeTimeoutMs,
      () => child.kill('SIGKILL'),
    );
  } catch (error) {
    fail(new Error(`Codex App Server did not initialize: ${stderr.trim() || String(error)}`));
  }
  rpc.notify('initialized', {});

  let threadId;
  try {
    const started = asObject(await withDeadline(rpc.request('thread/start', {
      model: options.model,
      // Only send this when explicitly configured. Codex otherwise uses the `model_provider` from
      // the machine's own ~/.codex/config.toml, which is both more faithful to "use the local
      // Codex" and portable: naming a provider that config does not define is a HARD error
      // ("Model provider `x` not found"), so a baked-in name breaks every other machine.
      ...(typeof options.modelProvider === 'string' && options.modelProvider.length > 0
        ? { modelProvider: options.modelProvider }
        : {}),
      cwd: options.cwd ?? workdir,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      baseInstructions: options.system ?? '',
      developerInstructions: '',
      personality: 'none',
      multiAgentMode: null,
      ephemeral: true,
      historyMode: 'legacy',
      dynamicTools: options.dynamicTools ?? [],
    }), options.handshakeTimeoutMs, () => child.kill('SIGKILL')));
    threadId = asObject(started?.thread)?.id ?? started?.threadId;
  } catch (error) {
    fail(new Error(`Codex App Server refused thread/start: ${stderr.trim() || String(error)}`));
  }
  if (typeof threadId !== 'string') throw new Error('Codex App Server returned no thread id');

  return { rpc, child, exited, threadId, workdir };
}

async function closeThread(lease, graceMs) {
  try {
    lease.rpc.close();
    lease.child.stdin.end();
    lease.child.kill('SIGTERM');
    const timer = setTimeout(() => lease.child.kill('SIGKILL'), Math.max(200, graceMs));
    await lease.exited;
    clearTimeout(timer);
  } catch {
    /* disposal is best effort */
  }
  try {
    await rm(lease.workdir, { recursive: true, force: true });
  } catch {
    /* the private directory is disposable */
  }
}

/**
 * Duck-typed Harness LLM adapter. `ctx` is only used for logging; no Harness package is imported.
 */
export class CodexAdapter {
  constructor(config, logger, spawnProcess) {
    this.config = config;
    this.logger = logger;
    // Test seam: production always uses node:child_process.spawn.
    this.spawnProcess = spawnProcess ?? spawn;
    this.leases = new Map(); // sessionId -> lease
    this.modelsCache = undefined; // { at, models }
    this.modelsPromise = undefined;
  }

  /**
   * The catalogue this provider advertises.
   *
   * An explicit `models` config wins outright. Otherwise the local Codex is asked (`model/list`)
   * and the answer is cached, because a hard-coded list drifts from what the machine can actually
   * run — it offered models the local install refuses and hid ones it does offer.
   */
  async effectiveModels() {
    if (this.config.models.length > 0) return this.config.models;
    const cached = this.modelsCache;
    if (cached !== undefined && Date.now() - cached.at < this.config.modelCacheTtlMs) return cached.models;
    if (this.modelsPromise === undefined) {
      this.modelsPromise = queryAppServerModels({
        command: this.config.command,
        env: this.config.env,
        disabledFeatures: this.config.disabledFeatures,
        handshakeTimeoutMs: this.config.handshakeTimeoutMs,
        maxJsonRpcLineBytes: this.config.maxJsonRpcLineBytes,
        spawn: this.spawnProcess,
      })
        .then((models) => {
          if (models.length > 0) this.modelsCache = { at: Date.now(), models };
          return models;
        })
        .catch((error) => {
          this.logger?.warn?.(
            `dsh-codex-session: could not list the local Codex models (${String(error)}); ` +
              'falling back to the built-in catalogue',
          );
          return [];
        })
        .finally(() => {
          this.modelsPromise = undefined;
        });
    }
    const discovered = await this.modelsPromise;
    return discovered.length > 0 ? discovered : DEFAULT_MODELS;
  }

  /** Model id a Codex session should start on when the config does not name one. */
  async defaultModelId() {
    const models = await this.effectiveModels();
    return (models.find((entry) => entry.isDefault === true) ?? models[0])?.id ?? FALLBACK_MODEL;
  }

  providerInfo(provider) {
    return { id: provider, name: 'Codex (local app server)' };
  }

  providerRetryPolicy() {
    return undefined;
  }

  imageRequestPricing() {
    return undefined;
  }

  async listModels(provider) {
    const models = await this.effectiveModels();
    return models.map((model) => ({
      provider,
      id: model.id,
      name: model.name ?? model.id,
      ...(model.description === undefined ? {} : { description: model.description }),
      // Images are not bridged to the App Server yet, so text is the honest modality here.
      inputModalities: ['text'],
    }));
  }

  async resolveModel(provider, model) {
    const known = (await this.effectiveModels()).find((entry) => entry.id === model);
    const efforts = (known?.reasoningEfforts ?? []).map((id) => ({ id, name: id }));
    return {
      provider,
      id: model,
      name: known?.name ?? model,
      ...(known?.description === undefined ? {} : { description: known.description }),
      context: { contextWindow: known?.contextWindow ?? 128000 },
      inputModalities: ['text'],
      ...(efforts.length === 0
        ? {}
        : {
            reasoning: {
              efforts,
              ...(known?.defaultReasoningEffort === undefined
                ? {}
                : { defaultEffort: known.defaultReasoningEffort }),
            },
          }),
    };
  }

  async prepareCall(provider, model) {
    const resolved = await this.resolveModel(provider, model);
    return { model: resolved, stream: (options) => this.stream({ ...options, provider, model }) };
  }

  /** One Harness model step. */
  async *stream(options) {
    const signal = options.signal;
    const sessionKey = options.sessionId === undefined ? undefined : String(options.sessionId);
    const oneShot = options.purpose !== undefined || sessionKey === undefined;
    const messages = Array.isArray(options.messages) ? options.messages : [];

    let lease = oneShot ? undefined : this.leases.get(sessionKey);
    if (lease !== undefined && Date.now() - (lease.lastUsed ?? 0) > this.config.sessionIdleTimeoutMs) {
      await this.#evict(sessionKey, lease);
      lease = undefined;
    }
    let mode = lease === undefined ? 'cold' : this.#continuation(lease, options);
    if (lease !== undefined && mode === undefined) {
      await this.#evict(sessionKey, lease);
      lease = undefined;
    }
    if (lease === undefined) {
      try {
        lease = await openThread({
          command: this.config.command,
          env: this.config.env,
          model: options.model,
          modelProvider: this.config.modelProvider,
          system: options.system ?? '',
          dynamicTools: dynamicTools(options.tools),
          maxJsonRpcLineBytes: this.config.maxJsonRpcLineBytes,
          maxStderrBytes: this.config.maxStderrBytes,
          handshakeTimeoutMs: this.config.handshakeTimeoutMs,
          disabledFeatures: this.config.disabledFeatures,
          spawn: this.spawnProcess,
        });
      } catch (error) {
        // A failed spawn/initialize must still end the step with one terminal chunk.
        yield { type: 'finish', reason: { kind: 'error', failure: { message: String(error?.message ?? error), code: 'TRANSPORT' } } };
        return;
      }
      lease.system = options.system ?? '';
      lease.model = options.model;
      lease.lastUsed = Date.now();
      mode = 'cold';
    }
    if (lease.idleTimer !== undefined) {
      clearTimeout(lease.idleTimer);
      lease.idleTimer = undefined;
    }

    const mapper = new StepMapper();
    let nextIndex = 0;

    const emitFinish = function* (reason) {
      const usage = mapper.usageChunk();
      if (usage !== undefined) yield usage;
      yield { type: 'finish', reason };
    };

    try {
      if (mode === 'cold') {
        const { items, trailingUser } = splitTrailingUser(messages);
        if (items.length > 0) await this.#request(lease, 'thread/inject_items', { threadId: lease.threadId, items });
        await this.#request(lease, 'turn/start', {
          threadId: lease.threadId,
          // Codex needs a non-empty turn input; a dangling tool result (lease lost between the
          // call and its result) injects the full history and then asks the model to continue.
          input: [{ type: 'text', text: trailingUser ?? 'Continue.' }],
        });
      } else if (mode === 'tool') {
        // The previous step handed a Harness tool call to the outer loop; answer that callback first
        // and then let the App Server continue the turn it is still holding open.
        const pending = lease.pendingTool;
        lease.pendingTool = undefined;
        const outcome = toolResultOutcome(messages, pending.callId);
        lease.rpc.respond(pending.rpcId, {
          callId: pending.callId,
          success: outcome?.isError !== true,
          contentItems: [{ type: 'inputText', text: outcome?.text ?? '' }],
        });
        for (const extra of trailingUserMessages(messages)) {
          await this.#request(lease, 'turn/steer', {
            threadId: lease.threadId,
            ...(pending.turnId === undefined ? {} : { expectedTurnId: pending.turnId }),
            input: [{ type: 'text', text: extra }],
          });
        }
      } else {
        // Append-only continuation: the App Server already holds this exact prefix.
        const appended = appendedUserTexts(messages.slice(lease.consumed));
        const started = asObject(
          await this.#request(lease, 'turn/start', {
            threadId: lease.threadId,
            input: appended.map((text) => ({ type: 'text', text })),
          }),
        );
        lease.turnId = asObject(started?.turn)?.id ?? lease.turnId;
      }

      if (!oneShot && sessionKey !== undefined) {
        lease.consumed = messages.length;
        lease.historyShape = fingerprint(messageShape(messages));
        this.#remember(sessionKey, lease);
      }

      const deadline = Date.now() + this.config.timeoutMs;
      for (;;) {
        if (signal?.aborted === true) {
          yield* mapper.closeOpen();
          yield* emitFinish({ kind: 'aborted', failure: { message: 'model request aborted', code: 'ABORTED' } });
          await this.#evict(sessionKey, lease);
          lease = undefined;
          return;
        }
        if (Date.now() > deadline) {
          yield* mapper.closeOpen();
          yield* emitFinish({
            kind: 'error',
            failure: { message: `Codex App Server turn timed out after ${this.config.timeoutMs}ms`, code: 'TIMEOUT' },
          });
          await this.#evict(sessionKey, lease);
          lease = undefined;
          return;
        }

        const step = await Promise.race([
          lease.rpc.next(),
          lease.exited.then(() => ({ value: undefined, done: true })),
        ]);
        if (step.done === true) {
          // The turn had not reached `turn/completed`: the process died mid-step. This is a
          // transport failure, not a clean stop (a normal turn returns from the branch below).
          yield* mapper.closeOpen();
          yield* emitFinish({
            kind: 'error',
            failure: { message: 'Codex App Server exited before the turn completed', code: 'TRANSPORT' },
          });
          await this.#evict(sessionKey, lease);
          lease = undefined;
          return;
        }

        const event = step.value;
        if (event.kind === 'request') {
          const handoff = this.#handleServerRequest(lease, event, options, nextIndex);
          if (handoff !== undefined) {
            yield* handoff.chunks;
            yield* emitFinish({ kind: 'tool-calls' });
            lease.pendingTool = handoff.pending;
            return;
          }
          continue;
        }
        if (event.kind === 'notification') {
          if (event.method === 'turn/completed') {
            const status = asObject(asObject(event.params.turn)?.status);
            yield* mapper.closeOpen();
            const failure = mapper.failure;
            if (failure !== undefined) yield* emitFinish({ kind: 'error', failure });
            else if (status?.type === 'failed') {
              yield* emitFinish({
                kind: 'error',
                failure: { message: 'Codex reported a failed turn', code: 'PROVIDER_ERROR' },
              });
            } else yield* emitFinish({ kind: 'stop' });
            if (oneShot) await this.#evict(sessionKey, lease);
            return;
          }
          const chunks = mapper.accept(event);
          if (chunks.length > 0) {
            for (const chunk of chunks) {
              if (chunk.type === 'block-start') nextIndex = Math.max(nextIndex, chunk.index + 1);
              yield chunk;
            }
          }
          continue;
        }
      }
    } finally {
      if (oneShot && lease !== undefined) await this.#evict(undefined, lease);
    }
  }

  /** Reply to every server request; a valid Harness tool call becomes a Harness `tool-call`. */
  #handleServerRequest(lease, event, options, index) {
    if (event.method !== 'item/tool/call') {
      lease.rpc.respond(event.id, { decision: 'declined' });
      return undefined;
    }
    const params = event.params;
    const callId = typeof params.callId === 'string' ? params.callId : undefined;
    const mapped = typeof params.tool === 'string' ? params.tool : undefined;
    const name = mapped === undefined ? undefined : originalToolName(mapped, options.tools);
    if (params.namespace !== HARNESS_TOOL_NAMESPACE || callId === undefined || name === undefined) {
      lease.rpc.respond(event.id, {
        callId: callId ?? 'unknown',
        success: false,
        contentItems: [{ type: 'inputText', text: 'This tool is not available to the outer Harness loop.' }],
      });
      return undefined;
    }
    const args = asObject(params.arguments) ?? {};
    const mapper = new StepMapper();
    return {
      chunks: mapper.toolCall(index, { id: callId, name, arguments: JSON.stringify(args) }),
      pending: {
        rpcId: event.id,
        callId,
        ...(typeof params.turnId === 'string' ? { turnId: params.turnId } : {}),
      },
    };
  }

  /**
   * Decide how an existing lease can serve this step.
   *
   *   'tool'      the previous step ended on a Harness tool call that this request now answers
   *   'append'    this request only extends the exact message prefix the App Server already holds
   *   undefined   the lease cannot serve it, so the caller cold-starts a new process and thread
   */
  #continuation(lease, options) {
    if (lease.system !== (options.system ?? '') || lease.model !== options.model) return undefined;
    const messages = Array.isArray(options.messages) ? options.messages : [];
    if (lease.pendingTool !== undefined) {
      return toolResultText(messages, lease.pendingTool.callId) === undefined ? undefined : 'tool';
    }
    if (lease.consumed === undefined || messages.length <= lease.consumed) return undefined;
    if (fingerprint(messageShape(messages.slice(0, lease.consumed))) !== lease.historyShape) return undefined;
    const appended = messages.slice(lease.consumed);
    if (appended.length === 0) return undefined;
    // A tool result needs the pending-callback path, never a plain turn.
    if (appended.some((message) => toolResultOf(message) !== undefined)) return undefined;
    // The App Server already produced its own assistant replies, so only the user messages in the
    // tail are new to it. DSH's history therefore interleaves assistant text with them.
    return appendedUserTexts(appended).length === 0 ? undefined : 'append';
  }

  /** One App Server request bounded by the turn deadline; a hung peer is killed, not waited on. */
  #request(lease, method, params) {
    return withDeadline(lease.rpc.request(method, params), this.config.timeoutMs, () =>
      lease.child.kill('SIGKILL'),
    );
  }

  #remember(sessionKey, lease) {
    lease.lastUsed = Date.now();
    this.leases.set(sessionKey, lease);
    if (lease.idleTimer !== undefined) clearTimeout(lease.idleTimer);
    lease.idleTimer = setTimeout(() => {
      void this.#evict(sessionKey, lease);
    }, this.config.sessionIdleTimeoutMs);
    lease.idleTimer.unref?.();
    if (this.leases.size <= this.config.maxCachedSessions) return;
    for (const [key, value] of this.leases) {
      if (key === sessionKey) continue;
      void this.#evict(key, value);
      break;
    }
  }

  async #evict(sessionKey, lease) {
    if (lease === undefined) return;
    if (lease.idleTimer !== undefined) {
      clearTimeout(lease.idleTimer);
      lease.idleTimer = undefined;
    }
    if (sessionKey !== undefined && this.leases.get(sessionKey) === lease) this.leases.delete(sessionKey);
    await closeThread(lease, this.config.disposeGraceMs);
  }

  async dispose() {
    const leases = [...this.leases.values()];
    this.leases.clear();
    await Promise.all(leases.map((lease) => closeThread(lease, this.config.disposeGraceMs)));
  }
}

//#endregion

//#region request helpers

/** Stable, id-free shape of a message list — the basis for append-only reuse decisions. */
export function messageShape(messages) {
  return (Array.isArray(messages) ? messages : []).map((raw) => {
    const message = asObject(raw);
    if (message === undefined) return null;
    const content = Array.isArray(message.content)
      ? message.content.map((rawBlock) => {
          const block = asObject(rawBlock);
          if (block === undefined) return null;
          if (block.type === 'text') return { type: 'text', text: block.text };
          if (block.type === 'tool-call') {
            return { type: 'tool-call', id: String(block.id), name: block.name, arguments: block.arguments };
          }
          if (block.type === 'image') {
            return { type: 'image', id: String(asObject(block.attachment)?.attachmentId ?? '') };
          }
          if (block.type === 'tool-result') {
            return {
              type: 'tool-result',
              toolCallId: String(block.toolCallId ?? ''),
              text: flattenText(block.content),
              isError: block.isError === true,
            };
          }
          return { type: String(block.type) };
        })
      : [];
    return {
      role: message.role,
      content,
      ...(message.toolCallId === undefined ? {} : { toolCallId: String(message.toolCallId) }),
      ...(message.isError === true ? { isError: true } : {}),
    };
  });
}

/** Harness messages minus a trailing user message, which starts the cold turn instead. */
export function splitTrailingUser(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const last = asObject(list[list.length - 1]);
  // A trailing tool result is history (it belongs in the injected items), not a user turn.
  if (last?.role !== 'user' || toolResultOf(last) !== undefined) {
    return { items: historyItems(list), trailingUser: undefined };
  }
  const text = flattenText(last.content);
  return { items: historyItems(list.slice(0, -1)), trailingUser: text.length > 0 ? text : undefined };
}

/**
 * The durable tool result for one call id, or `undefined` when the step has not produced it yet.
 * Accepts both the real DSH shape (`role:'user'` + `source.kind:'tool'`) and the simplified
 * `role:'tool'` shape.
 */
export function toolResultOutcome(messages, callId) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const result = toolResultOf(list[i]);
    if (result !== undefined && String(result.callId) === String(callId)) return result;
  }
  return undefined;
}

/** The text of the durable tool result for one call id, or `undefined` when not produced yet. */
/** Plain text of the user messages in one append-only tail, dropping empty turns. */
export function appendedUserTexts(messages) {
  return messages
    .filter((message) => asObject(message)?.role === 'user')
    .map((message) => flattenText(asObject(message)?.content))
    .filter((text) => text.length > 0);
}

/** The durable tool result for one call id, or `undefined` when the step has not produced it yet. */
export function toolResultText(messages, callId) {
  return toolResultOutcome(messages, callId)?.text;
}

/** Ordinary user messages that arrived after the newest tool result, in order. */
export function trailingUserMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  let lastTool = -1;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (toolResultOf(list[i]) !== undefined) {
      lastTool = i;
      break;
    }
  }
  if (lastTool === -1) return [];
  const found = [];
  for (let i = lastTool + 1; i < list.length; i += 1) {
    const message = asObject(list[i]);
    if (message?.role === 'user' && toolResultOf(message) === undefined) found.push(flattenText(message.content));
  }
  return found;
}

//#endregion
