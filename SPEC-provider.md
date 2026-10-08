# Implementation spec — `codex-local` provider inside `dsh-codex-session`

## Goal

Add a real DSH LLM provider route `codex-local` to `lib/index.js` / a new `lib/provider.js`,
implemented with **Node built-ins only**. DSH keeps the session log, the tool loop, approvals
and the UI; Codex owns model inference, instructions and reasoning.

## Hard constraints (violating these breaks loading — verified)

1. **Never `import` any `@deepseek-ai/*` package.** On DSH desktop 0.2.0-rc.2 an out-of-tree
   host plugin cannot resolve them (verified with a minimal control plugin + full boot).
   A `link:`-installed plugin resolves imports from its link target, where DSH peers do not exist.
   Use only `node:*` built-ins.
2. **Never import `react`/browser packages in the host half.**
3. The adapter is registered by duck typing — there is no `instanceof` check on adapters:
   `ctx.llm.registerAdapter(['codex-local'], adapter)`.
4. Every listener/async path must never reject in a way that breaks the caller.

## 1. Adapter contract (methods the host calls; all may be sync or async)

```js
{
  providerInfo(provider)                      // -> { id: provider, name: 'Codex (local app server)' }
  providerRetryPolicy(provider)               // -> undefined  (use harness defaults)
  imageRequestPricing(provider, model)        // -> undefined
  listModels(provider)                        // -> LlmModelInfo[]  [{provider,id,name,description?,inputModalities?}]
  resolveModel(provider, model, signal)       // -> LlmResolvedModelInfo
  prepareCall(provider, model, signal)        // -> { model, stream(options) }
  stream(options)                             // -> AsyncIterable<StreamChunk>
}
```

`resolveModel` must return at least:
```js
{ provider, id: model, name, context: { contextWindow }, defaultMaxTokens?, reasoning?: { efforts:[{id,name}], defaultEffort } }
```
`reasoningEfforts` are strings like `low|medium|high|xhigh`. If the model is unknown, still return a
text-only entry with a default context window (do not throw for unknown but well-formed ids).

`GenerateOptions` (input to `stream`):
```js
{ provider, model, reasoningEffort?, messages, system?, tools?, toolHistory?, temperature?, maxTokens?,
  stop?, signal?, sessionId?, purpose?: 'compaction' | 'session-title' }
```
- `messages`: array of `Message`: `{role:'user'|'assistant'|'tool'|'system'|'developer', content:[...], id?, source?, toolCallId?}`
  Content blocks: `{type:'text',text}`, `{type:'reasoning',text}`, `{type:'tool-call',id,name,arguments}`,
  `{type:'image',attachment:{...}}`, `{type:'file',...}`.
- `tools`: `[{ name, description, parameters /* JSON schema */ }]`
- `toolHistory`: `{ tools, updates }` — ignore.

## 2. Stream chunk vocabulary (emit exactly these)

```js
{ type:'block-start', index, blockType }      // blockType: 'text' | 'reasoning' | 'tool-call'
{ type:'text-delta', index, text }
{ type:'reasoning-delta', index, text }
{ type:'block-end', index, block: <ContentBlock> }
{ type:'usage', usage: { inputTokens, outputTokens, totalTokens?, cacheReadTokens?, reasoningTokens? } }
{ type:'finish', reason: { kind:'stop' } | { kind:'tool-calls' } | { kind:'max-tokens' } | { kind:'aborted', failure } | { kind:'error', failure } }
```
- `block-end` for a tool call must be `block: {type:'tool-call', id, name, arguments}` where `arguments`
  is a **JSON string**.
- Failure object: `{ message, code }` (plain object is fine).
- Emit exactly one `finish` chunk, last. Close every open block before it.

## 3. App Server protocol (verified against real `codex 0.146.1` on this machine)

Transport: newline-delimited JSON-RPC 2.0 over the child's stdin/stdout.

Spawn argv: `['app-server', '--stdio']` using the configured command (default: resolve `codex`
from `PATH`, else `/opt/homebrew/bin/codex`). Env: inherit `process.env`, add
`CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'deepseek-harness'`, plus configured `env`.
`CODEX_HOME` is inherited (native login state).

**Requests**
| method | params | result |
|---|---|---|
| `initialize` | `{clientInfo:{name:'deepseek-harness',title:'DeepSeek Harness',version:'0.1.0'}, capabilities:{experimentalApi:true, requestAttestation:false}}` | `{userAgent, codexHome, platformFamily, platformOs}` |
| notification `initialized` | `{}` | — |
| `thread/start` | `{model, modelProvider, cwd, approvalPolicy:'never', sandbox:'read-only', baseInstructions, developerInstructions:'', personality:'none', multiAgentMode:null, ephemeral:true, historyMode:'legacy', dynamicTools:[...]}` | `{thread:{id, sessionId, ...}}` — also announced as notification `thread/started` |
| `turn/start` | `{threadId, input:[{type:'text',text}]}` | `{turn:{id,...}}` |
| `turn/steer` | `{threadId, input:[...]}` | same |

`historyMode:'legacy'` **requires** `capabilities.experimentalApi` (verified failure otherwise).

**Notifications (server → client)**
- `thread/started {thread:{id,...}}`
- `turn/started {threadId, turn:{id, status}}`
- `item/started {item, threadId, turnId}` / `item/completed {item, threadId, turnId}`
  Item shapes seen: `{type:'userMessage',id,content:[{type:'text',text}]}`,
  `{type:'reasoning',id,summary:[],content:[]}`,
  `{type:'agentMessage',id,text,phase}`,
  `{type:'dynamicToolCall',id,namespace,tool,arguments,status,contentItems,success}`
- `item/agentMessage/delta {threadId, turnId, itemId, delta}` → text delta
- `item/reasoning/textDelta` / `item/reasoning/summaryTextDelta` → reasoning delta
  (both may appear; treat `textDelta` as reasoning text, ignore unknown reasoning channels)
- `thread/tokenUsage/updated {threadId, turnId, tokenUsage:{total:{inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens, totalTokens}, last:{...}}}`
- `turn/completed {threadId, turn:{id, items, status, error}}` → terminal
- `thread/status/changed`, `account/rateLimits/updated`, `mcpServer/startupStatus/updated`,
  `remoteControl/status/changed`, `thread/compacted` → ignore (log at debug)

**Server → client requests** (must be answered or the turn stalls)
- `item/tool/call {threadId, turnId, callId, namespace, tool, arguments}` → **the DSH tool handoff**
  reply: `{callId, success: true|false, contentItems:[{type:'inputText', text:'<string>'}]}`
  NOTE: the tag is `inputText` (camelCase). `input_text` was rejected by the server as
  "dynamic tool response was invalid" in the live probe — do not repeat that.
- `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`,
  `item/tool/requestUserInput`, and any other unknown server request → reply
  `{decision:'declined'}` and continue (never hang).

**Comments** are arbitrary JSON-RPC — ignore frames with an unknown shape.
Correlate responses by numeric id.

## 4. Dynamic tool bridging

Declare once per thread:
```js
dynamicTools = [{
  type:'namespace',
  name:'deepseek_harness',
  description:'Tools provided by the outer DeepSeek Harness agent loop.',
  tools: tools.map(t => ({ type:'function', name: mapped(t.name), description: t.description, inputSchema: t.parameters }))
}]
```
- `mapped(name)` = `'harness_' + name.replace(/[^A-Za-z0-9._-]/g,'_')` (always prefixed, so it can
  never collide with a Codex-native tool).
- Only bridged names may cross. When `item/tool/call` arrives with `namespace !== 'deepseek_harness'`
  or an unknown mapped name, respond with `{callId, success:false, contentItems:[{type:'inputText', text:'<reason>'}]}`
  and keep waiting.
- For a valid call: emit `block-start(tool-call)` … `block-end({type:'tool-call', id: callId, name: <original tool name>, arguments: JSON.stringify(args)})`,
  then **emit `finish` with `{kind:'tool-calls'}` and end the model step while leaving the JSON-RPC
  request pending** (store `id` keyed by `callId`).
- On the next `stream()` call for the same session, find the tool result for that callId in
  `options.messages` (the `tool` role message whose `source.callId`/`toolCallId` matches) and reply to
  the pending JSON-RPC request with `{callId, success: !isError, contentItems:[{type:'inputText',text:<flattened text>}]}`,
  then continue the same turn and stream the remainder.

## 5. History reconstruction and thread reuse

Keep a per-session lease in memory: `{ child, threadId, watermark, pendingTool: {callId, rpcId} }`.

- **Cold start** (no matching lease): flatten `options.system` into `baseInstructions`; convert
  `options.messages` into app-server items and send them via `thread/inject_items`
  (`{threadId, items:[...]}`) *before* `turn/start` with an empty input, OR include the latest user
  message as `turn/start.input` and inject the rest as items. Prefer:
  - `items` = all messages up to the last user message, converted to Responses-style items:
    - user text → `{type:'message', role:'user', content:[{type:'input_text',text}]}`
    - assistant text → `{type:'message', role:'assistant', content:[{type:'output_text',text}]}`
    - assistant tool call → `{type:'function_call', name: mapped(name), arguments: <string>, call_id: id, namespace:'deepseek_harness'}`
    - tool result → `{type:'function_call_output', call_id: id, output:[{type:'input_text',text}]}`
    - reasoning blocks → skip
  - then `turn/start {threadId, input:[{type:'text',text:<last user text>}]}`
- **Warm continuation**: if the lease exists and the only new messages since `watermark` are a tool
  result for the pending call (plus optional trailing user text), reply to the pending RPC and use
  `turn/steer` for trailing user messages. Do not re-inject history.
- Any other shape (history rewritten, compaction, system changed, model changed) → dispose the lease
  and cold start.
- `purpose: 'compaction' | 'session-title'` → always a fresh one-shot process, no reuse, no tools.

Lease eviction: LRU cap (`maxCachedSessions`, default 4) + idle timeout (`sessionIdleTimeoutMs`,
default 600000). Dispose on plugin unload via `ctx.effect`.

## 6. Multi-turn within one `stream()` call

One `stream()` == one model step. It may serve several Codex turns only in the tool-continuation
case above. Emit the block sequence for the whole step, then exactly one `finish`.

## 7. Safety

- `sandbox: 'read-only'` and `approvalPolicy: 'never'` — Codex's own file/command tools must not run;
  the workspace is reached only through bridged DSH tools.
- `cwd`: use a fresh private empty dir (`mkdtemp` under `os.tmpdir()`), removed on dispose.
- Bound stderr retention and per-line size; kill the child on dispose with a grace period.

## 8. Config (Loader entry config, defaults)

```yaml
- id: codex-session
  name: dsh-codex-session
  config:
    preset: codex
    provider: codex-local
    model: gpt-5.5
    modelProvider: custom
    command: codex            # or an absolute path
    models: [ {id, name, contextWindow, reasoningEfforts?, defaultReasoningEffort?, inputModalities?} ]
    timeoutMs: 300000
    maxCachedSessions: 4
    sessionIdleTimeoutMs: 600000
    env: {}
```

## 9b. Verified addendum (measured after this spec was first written)

Confirmed by direct probes against the real local `codex 0.146.1`:

- **`thread/inject_items` works and is the right cold-start mechanism.** Sending
  `{threadId, items:[{type:'message',role:'user',content:[{type:'input_text',text:'...'}]},
  {type:'message',role:'assistant',content:[{type:'output_text',text:'...'}]}]}` before
  `turn/start` made the model recall the injected content in a later turn. The request result was
  `{}` — treat success as "no `error` field", not as a specific shape.
- The `input_text` / `output_text` tags inside injected items are correct as written above.
- `initialize` **must** carry `capabilities:{experimentalApi:true, requestAttestation:false}`,
  otherwise `thread/start` fails with `-32600 historyMode requires experimentalApi capability`.
- The dynamic-tool result tag is `inputText` (camelCase), **not** `input_text`. Using
  `input_text` makes the server complete the call as failed with
  `contentItems:[{type:'inputText',text:'dynamic tool response was invalid'}]`.
- `item/tool/call` arrives as a **server→client request**; in the probe its `id` was `0`.
  Correlate by `params.callId` and keep the frame's own `id` for the reply.
- After a valid reply to `item/tool/call`, the server emits `item/completed` for the
  `dynamicToolCall` item and continues the same turn, so a warm continuation can keep streaming
  on the already-open thread instead of restarting it.

If your implementation disagrees with any statement above, re-probe rather than trust either.

## 9. Acceptance criteria

1. `node --check` passes on every file; no `@deepseek-ai/` string in any import.
2. A headless script can: construct the adapter with a stub context, call `stream()` with a trivial
   system + one user message, and receive `text-delta` chunks followed by exactly one
   `finish {kind:'stop'}`.
3. A scripted tool round trip: `stream()` with one tool call emits a `tool-call` block and
   `finish {kind:'tool-calls'}` while the RPC stays pending; a second `stream()` carrying the tool
   result resolves the pending RPC and completes the turn.
4. The plugin still loads in a real DSH boot with no "did not activate" warning.
