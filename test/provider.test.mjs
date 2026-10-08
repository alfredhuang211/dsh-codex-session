import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import {
  CodexAdapter,
  StepMapper,
  dynamicTools,
  historyItems,
  mapToolName,
  messageShape,
  originalToolName,
  splitTrailingUser,
  toolResultOutcome,
  toolResultText,
  trailingUserMessages,
} from '../lib/provider.js';

const notification = (method, params) => ({ kind: 'notification', method, params });

test('mapToolName always aliases into a namespace-safe name', () => {
  assert.equal(mapToolName('bash'), 'harness_bash');
  assert.equal(mapToolName('str/replace editor'), 'harness_str_replace_editor');
  assert.equal(mapToolName('skill'), 'harness_skill');
});

test('dynamicTools declares one namespace and reverses cleanly', () => {
  const tools = [
    { name: 'bash', description: 'Run a command.', parameters: { type: 'object', properties: { command: { type: 'string' } } } },
    { name: 'read', description: 'Read a file.', parameters: { type: 'object', properties: {} } },
  ];
  const declared = dynamicTools(tools);
  assert.equal(declared.length, 1);
  assert.equal(declared[0].type, 'namespace');
  assert.equal(declared[0].name, 'deepseek_harness');
  assert.deepEqual(
    declared[0].tools.map((tool) => tool.name),
    ['harness_bash', 'harness_read'],
  );
  assert.equal(declared[0].tools[0].inputSchema.properties.command.type, 'string');
  assert.equal(originalToolName('harness_read', tools), 'read');
  assert.equal(originalToolName('harness_nope', tools), undefined);
  assert.deepEqual(dynamicTools(undefined), []);
});

test('historyItems rebuilds Responses-style items from the Harness log', () => {
  const items = historyItems([
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'thinking' },
        { type: 'tool-call', id: 'call_1', name: 'bash', arguments: '{"command":"ls"}' },
        { type: 'text', text: 'running' },
      ],
    },
    { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: 'file.txt' }] },
    { role: 'user', content: [{ type: 'text', text: 'and now?' }] },
  ]);
  assert.deepEqual(items, [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    { type: 'function_call', name: 'harness_bash', arguments: '{"command":"ls"}', call_id: 'call_1', namespace: 'deepseek_harness' },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'running' }] },
    { type: 'function_call_output', call_id: 'call_1', output: [{ type: 'input_text', text: 'file.txt' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'and now?' }] },
  ]);
});

test('StepMapper publishes indexed text and reasoning blocks', () => {
  const mapper = new StepMapper();
  const chunks = [
    ...mapper.accept(notification('item/started', { item: { type: 'reasoning', id: 'r1' } })),
    ...mapper.accept(notification('item/reasoning/textDelta', { itemId: 'r1', delta: 'why' })),
    ...mapper.accept(notification('item/completed', { item: { type: 'reasoning', id: 'r1', text: 'why' } })),
    ...mapper.accept(notification('item/started', { item: { type: 'agentMessage', id: 'm1' } })),
    ...mapper.accept(notification('item/agentMessage/delta', { itemId: 'm1', delta: 'he' })),
    ...mapper.accept(notification('item/agentMessage/delta', { itemId: 'm1', delta: 'llo' })),
    ...mapper.accept(notification('item/completed', { item: { type: 'agentMessage', id: 'm1', text: 'hello' } })),
  ];
  assert.deepEqual(chunks, [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'why' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'why' } },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: 'he' },
    { type: 'text-delta', index: 1, text: 'llo' },
    { type: 'block-end', index: 1, block: { type: 'text', text: 'hello' } },
  ]);
});

test('StepMapper recovers a delta with no preceding item/started and reports usage', () => {
  const mapper = new StepMapper();
  const chunks = mapper.accept(notification('item/agentMessage/delta', { itemId: 'x', delta: 'orphan' }));
  assert.deepEqual(chunks, [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'orphan' },
  ]);
  mapper.accept(
    notification('thread/tokenUsage/updated', {
      tokenUsage: { total: { inputTokens: 10, outputTokens: 4, totalTokens: 14, cachedInputTokens: 6, reasoningOutputTokens: 2 } },
    }),
  );
  // DSH TokenUsage is disjoint: Codex folds cached input into inputTokens, so it is subtracted out.
  assert.deepEqual(mapper.usageChunk(), {
    type: 'usage',
    usage: { inputTokens: 4, outputTokens: 4, totalTokens: 14, cacheReadTokens: 6, reasoningTokens: 2 },
  });
  assert.deepEqual(mapper.closeOpen(), [{ type: 'block-end', index: 0, block: { type: 'text', text: 'orphan' } }]);
  assert.equal(mapper.closeOpen().length, 0);
});

test('StepMapper publishes a Harness tool call at an explicit index', () => {
  const mapper = new StepMapper();
  assert.deepEqual(mapper.toolCall(3, { id: 'call_9', name: 'bash', arguments: '{"command":"ls"}' }), [
    { type: 'block-start', index: 3, blockType: 'tool-call' },
    {
      type: 'block-end',
      index: 3,
      block: { type: 'tool-call', id: 'call_9', name: 'bash', arguments: '{"command":"ls"}' },
    },
  ]);
});

test('cold-start split keeps the trailing user message out of the injected history', () => {
  const cold = splitTrailingUser([
    { role: 'user', content: [{ type: 'text', text: 'first' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    { role: 'user', content: [{ type: 'text', text: 'second' }] },
  ]);
  assert.equal(cold.trailingUser, 'second');
  assert.equal(cold.items.length, 2);

  const trailingTool = splitTrailingUser([
    { role: 'user', content: [{ type: 'text', text: 'first' }] },
    { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'out' }] },
  ]);
  assert.equal(trailingTool.trailingUser, undefined);
  assert.equal(trailingTool.items.length, 2);
});

test('tool results and trailing user messages are located by call id', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'go' }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' }] },
    { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'result' }] },
    { role: 'user', content: [{ type: 'text', text: 'next' }] },
  ];
  assert.equal(toolResultText(messages, 'c1'), 'result');
  assert.equal(toolResultText(messages, 'missing'), undefined);
  assert.deepEqual(trailingUserMessages(messages), ['next']);
  assert.deepEqual(trailingUserMessages([{ role: 'user', content: [] }]), []);
});

test('messageShape ignores volatile ids so an append-only continuation is detectable', () => {
  const a = messageShape([{ role: 'user', id: 'msg_1', content: [{ type: 'text', text: 'hi' }] }]);
  const b = messageShape([{ role: 'user', id: 'msg_2', content: [{ type: 'text', text: 'hi' }] }]);
  assert.deepEqual(a, b);
  const c = messageShape([{ role: 'user', id: 'msg_2', content: [{ type: 'text', text: 'changed' }] }]);
  assert.notDeepEqual(a, c);
});

// ---------------------------------------------------------------------------
// Real DSH message shapes
// ---------------------------------------------------------------------------

/** A real DSH tool result: role:'user', source.kind:'tool', one tool-result block. */
const realToolResult = (callId, text, isError = false) => ({
  id: `msg_tool_${callId}`,
  role: 'user',
  source: { kind: 'tool', callId },
  content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }], isError }],
});

test('historyItems and toolResultOutcome accept the real DSH tool-result shape', () => {
  const messages = [
    { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'go' }] },
    { id: 'a1', role: 'assistant', source: { kind: 'model' }, content: [{ type: 'tool-call', id: 'call_1', name: 'echo', arguments: '{"message":"hi"}' }] },
    realToolResult('call_1', 'ECHO:hi'),
  ];
  assert.deepEqual(toolResultOutcome(messages, 'call_1'), { callId: 'call_1', text: 'ECHO:hi', isError: false });
  assert.equal(toolResultText(messages, 'call_1'), 'ECHO:hi');
  assert.equal(toolResultText(messages, 'missing'), undefined);
  assert.deepEqual(trailingUserMessages(messages), []);

  const items = historyItems(messages);
  assert.deepEqual(items.at(-1), {
    type: 'function_call_output',
    call_id: 'call_1',
    output: [{ type: 'input_text', text: 'ECHO:hi' }],
  });

  // A dangling trailing tool result stays in the injected history, not in the turn input.
  const split = splitTrailingUser(messages);
  assert.equal(split.trailingUser, undefined);
  assert.equal(split.items.at(-1).type, 'function_call_output');
});

// ---------------------------------------------------------------------------
// Adapter-level: scripted App Server over an in-memory child process
// ---------------------------------------------------------------------------

const echoTool = {
  name: 'echo',
  description: 'Echo a message back to the caller.',
  parameters: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'], additionalProperties: false },
};

const userTurn = (text) => ({ id: 'msg_u', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] });

const adapterConfig = (overrides = {}) => ({
  command: 'fake-codex',
  env: {},
  modelProvider: 'custom',
  models: [{ id: 'gpt-5.5', name: 'GPT-5.5', contextWindow: 1000, reasoningEfforts: [] }],
  timeoutMs: 30000,
  disposeGraceMs: 50,
  maxJsonRpcLineBytes: 1024 * 1024,
  maxStderrBytes: 4096,
  maxCachedSessions: 4,
  sessionIdleTimeoutMs: 600000,
  ...overrides,
});

/**
 * One scripted `codex app-server --stdio` conversation. The first `turn/start` opens a turn
 * that asks the Harness to run `harness_echo`; the adapter answers that deferred request on
 * the next `stream()` call, and only then does the scripted turn complete.
 */
function makeFakeServer() {
  const spawns = [];
  const state = { turnStarts: 0, injected: [], toolResponses: [] };

  const dispatch = (child, msg) => {
    const send = (frame) => child.stdout.write(`${JSON.stringify(frame)}\n`);
    const notify = (method, params) => send({ jsonrpc: '2.0', method, params });
    const complete = () => {
      notify('thread/tokenUsage/updated', {
        tokenUsage: { last: { inputTokens: 10, cachedInputTokens: 4, outputTokens: 2, totalTokens: 12, reasoningOutputTokens: 0 } },
      });
      notify('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [] } });
    };

    if (msg.method === 'initialize') {
      send({ jsonrpc: '2.0', id: msg.id, result: { userAgent: 'fake', codexHome: '/tmp', platformFamily: 'unix', platformOs: 'macos' } });
      return;
    }
    if (msg.method === 'thread/start') {
      send({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: 'thread-1' } } });
      return;
    }
    if (msg.method === 'thread/inject_items') {
      state.injected.push(msg.params.items);
      send({ jsonrpc: '2.0', id: msg.id, result: {} });
      return;
    }
    if (msg.method === 'turn/steer') {
      send({ jsonrpc: '2.0', id: msg.id, result: { turnId: 'turn-1' } });
      return;
    }
    if (msg.method === 'turn/start') {
      state.turnStarts += 1;
      send({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: 'turn-1' } } });
      if (state.turnStarts === 1) {
        notify('item/started', { item: { type: 'agentMessage', id: 'm1' } });
        notify('item/agentMessage/delta', { itemId: 'm1', delta: 'Calling the tool.' });
        notify('item/completed', { item: { type: 'agentMessage', id: 'm1', text: 'Calling the tool.' } });
        send({
          jsonrpc: '2.0',
          id: 0,
          method: 'item/tool/call',
          params: { threadId: 'thread-1', turnId: 'turn-1', callId: 'call_1', namespace: 'deepseek_harness', tool: 'harness_echo', arguments: { message: 'hi' } },
        });
      } else {
        notify('item/started', { item: { type: 'agentMessage', id: `m${state.turnStarts}` } });
        notify('item/agentMessage/delta', { itemId: `m${state.turnStarts}`, delta: 'done' });
        notify('item/completed', { item: { type: 'agentMessage', id: `m${state.turnStarts}`, text: 'done' } });
        complete();
      }
      return;
    }
    // The adapter's answer to the deferred `item/tool/call` request (id 0).
    if (msg.id === 0 && msg.result !== undefined) {
      state.toolResponses.push(msg.result);
      notify('item/started', { item: { type: 'agentMessage', id: 'm2' } });
      notify('item/agentMessage/delta', { itemId: 'm2', delta: 'ECHO:hi' });
      notify('item/completed', { item: { type: 'agentMessage', id: 'm2', text: 'ECHO:hi' } });
      complete();
    }
  };

  const spawnFn = () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = () => {
      child.exitCode = 0;
      child.emit('close', 0, null);
      return true;
    };
    spawns.push(child);
    let buffer = '';
    child.stdin.setEncoding('utf8');
    child.stdin.on('data', (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim().length === 0) continue;
        dispatch(child, JSON.parse(line));
      }
    });
    return child;
  };

  return { spawnFn, spawns, state };
}

async function collect(adapter, options) {
  const chunks = [];
  for await (const chunk of adapter.stream(options)) chunks.push(chunk);
  return chunks;
}

const finishesOf = (chunks) => chunks.filter((chunk) => chunk.type === 'finish').map((chunk) => chunk.reason.kind);

test('adapter stream() bridges a two-step tool round trip and reuses the lease', async () => {
  const { spawnFn, spawns, state } = makeFakeServer();
  const adapter = new CodexAdapter(adapterConfig(), null, spawnFn);

  const first = await collect(adapter, {
    provider: 'codex-local',
    model: 'gpt-5.5',
    sessionId: 's1',
    system: 'sys',
    tools: [echoTool],
    messages: [userTurn('call echo')],
  });
  assert.deepEqual(finishesOf(first), ['tool-calls']);
  const toolBlock = first.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call').block;
  assert.equal(toolBlock.name, 'echo');
  assert.equal(toolBlock.arguments, '{"message":"hi"}');
  assert.equal(spawns.length, 1);

  const messages2 = [
    userTurn('call echo'),
    { id: 'a1', role: 'assistant', source: { kind: 'model' }, content: [{ type: 'tool-call', id: toolBlock.id, name: 'echo', arguments: toolBlock.arguments }] },
    realToolResult(toolBlock.id, 'ECHO:hi'),
  ];
  const second = await collect(adapter, {
    provider: 'codex-local',
    model: 'gpt-5.5',
    sessionId: 's1',
    system: 'sys',
    tools: [echoTool],
    messages: messages2,
  });
  assert.deepEqual(finishesOf(second), ['stop']);
  assert.equal(second.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join(''), 'ECHO:hi');
  assert.equal(spawns.length, 1, 'the tool continuation must reuse the live lease');
  assert.equal(state.turnStarts, 1, 'the continuation must not open a new turn');
  assert.equal(state.toolResponses.length, 1);
  assert.equal(state.toolResponses[0].callId, toolBlock.id);
  assert.equal(state.toolResponses[0].success, true);
  assert.equal(state.toolResponses[0].contentItems[0].type, 'inputText');
  assert.equal(state.toolResponses[0].contentItems[0].text, 'ECHO:hi');
  const usage = second.find((chunk) => chunk.type === 'usage').usage;
  assert.equal(usage.inputTokens, 6, 'cached input is reported separately');
  await adapter.dispose();
});

test('adapter stream() cold-starts when the request shape changed', async () => {
  const { spawnFn, spawns, state } = makeFakeServer();
  const adapter = new CodexAdapter(adapterConfig(), null, spawnFn);

  await collect(adapter, { provider: 'codex-local', model: 'gpt-5.5', sessionId: 's2', system: 'sys', tools: [echoTool], messages: [userTurn('call echo')] });
  assert.equal(spawns.length, 1);

  const messages2 = [
    userTurn('call echo'),
    { id: 'a1', role: 'assistant', source: { kind: 'model' }, content: [{ type: 'tool-call', id: 'call_1', name: 'echo', arguments: '{"message":"hi"}' }] },
    realToolResult('call_1', 'ECHO:hi'),
  ];
  const second = await collect(adapter, { provider: 'codex-local', model: 'gpt-5.5', sessionId: 's2', system: 'changed', tools: [echoTool], messages: messages2 });
  assert.deepEqual(finishesOf(second), ['stop']);
  assert.equal(spawns.length, 2, 'a changed system prompt cannot reuse the lease');
  const injected = state.injected.at(-1);
  assert.ok(
    injected.some((item) => item.type === 'function_call_output' && item.call_id === 'call_1' && item.output[0].text === 'ECHO:hi'),
    'the cold start must reconstruct the tool output into history',
  );
  await adapter.dispose();
});

test('the real DSH user-role tool result is recognized everywhere', () => {
  const toolResult = {
    role: 'user',
    source: { kind: 'tool', callId: 'call_1' },
    content: [
      {
        type: 'tool-result',
        toolCallId: 'call_1',
        content: [{ type: 'text', text: 'NON-DERIVABLE-72' }],
        isError: false,
      },
    ],
  };
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'go' }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'call_1', name: 'bash', arguments: '{}' }] },
    toolResult,
  ];

  // history rebuilds a real function_call_output, not a stray empty user message
  const items = historyItems(messages);
  assert.deepEqual(items.at(-1), {
    type: 'function_call_output',
    call_id: 'call_1',
    output: [{ type: 'input_text', text: 'NON-DERIVABLE-72' }],
  });
  assert.equal(items.length, 3);

  // the pending-call continuation is detected ...
  assert.equal(toolResultText(messages, 'call_1'), 'NON-DERIVABLE-72');
  // ... and a trailing tool result is never mistaken for a user turn
  assert.equal(splitTrailingUser(messages).trailingUser, undefined);
  assert.equal(splitTrailingUser(messages).items.length, 3);
  assert.deepEqual(trailingUserMessages(messages), []);
});

test('an error tool result is carried through with isError', () => {
  const messages = [
    {
      role: 'user',
      source: { kind: 'tool', callId: 'c9' },
      content: [{ type: 'tool-result', toolCallId: 'c9', content: [{ type: 'text', text: 'boom' }], isError: true }],
    },
  ];
  assert.equal(toolResultText(messages, 'c9'), 'boom');
  assert.equal(trailingUserMessages(messages).length, 0);
});

test('user messages queued behind a tool result are found for steering', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'first' }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' }] },
    {
      role: 'user',
      source: { kind: 'tool', callId: 'c1' },
      content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'out' }], isError: false }],
    },
    { role: 'user', content: [{ type: 'text', text: 'also do this' }] },
    { role: 'user', content: [{ type: 'text', text: 'and this' }] },
  ];
  assert.deepEqual(trailingUserMessages(messages), ['also do this', 'and this']);
  assert.equal(toolResultText(messages, 'c1'), 'out');
});
