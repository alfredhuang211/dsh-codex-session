# dsh-codex-session

DSH 桌面端（desktop profile）插件：**新建会话时可以选择「DSH 默认」或「Codex」会话**。

Codex 会话仍是一个普通的 DSH 会话——会话日志、工具循环、审批和整个界面都由 DSH 负责——
只有模型请求改由**本机已登录的 Codex App Server**提供。Codex 因此拿到的是 DSH 自己的工具：
Codex 请求调用工具时，插件把它转成真正的 DSH `tool-call`，由 DSH 执行、审批并写回日志，
再把结果交回同一个 Codex turn。

界面完全使用 DSH 桌面既有 UI，不新开窗口、不改任何 DSH 包、不遮蔽任何内置插槽。

## 组成

| 层 | 文件 | 内容 |
|---|---|---|
| LLM 提供方 | `lib/provider.js` | `codex-local` 路由：spawn 本机 `codex app-server`，newline-delimited JSON-RPC，事件→`StreamChunk` 映射，`deepseek_harness` 工具桥接，按会话缓存线程 |
| Host 半 | `lib/index.js` | 注册提供方；监听 `agent/created` / `agent-preset/selected`，把 `codex` 预设的会话钉在 `codex-local` 上，并复原被副作用改写的全局默认模型 |
| Agent 预设 | `cordis.patch.yml` | 声明 `codex` 预设，因此 DSH 自带的新会话 Agent 预设选择器会多出 **Codex** 一项 |
| Client 半 | `lib/client.js` | 输入框上方的「会话类型」选择器（`conversation.input.dock`）+ 已开始 Codex 会话的后端标识 + 设置页「Codex 会话」（`settings.plugins.tab`） |

**只用 Node 内置模块。** 这一点是硬约束：在 DSH 桌面 0.2.0-rc.2 上，树外 Host 插件**无法解析
`@deepseek-ai/*` 包**（profile 的 `node_modules` 里没有它们，DSH 的 peer 回退也不覆盖这条路径；
用一个最小对照插件 + 完整启动验证过）。所以本插件不 import 任何 DSH 包，一切通过 Cordis 注入的服务访问。

### 为什么不用 `dsh-llm-codex-app-server`

它是本插件最初的参考实现，语义完全对口，但它只在 peerDependencies 里声明兼容 dsh `0.1.0-rc.8`，
且它的 Host 半会 `import` 上面那批无法解析的包。隔离验证结论：**在本机 0.2.0-rc.2 上直接加载失败**
（`llm-codex-app-server ... failed to import`）。补装 peer 包只会把失败点推移到 `@deepseek-ai/cordis`，
并引入重复模块实例（`instanceof HarnessError` 失效、错误分类退化）。因此改为在插件内自带提供方。

### 为什么默认关掉一批 Codex 原生能力

DSH 负责工具循环、审批和轨迹，所以任何**绕过 DSH 直接动这台机器**的 Codex 原生能力都会同时绕过这三者：
动作不出现在会话记录里、不受 DSH 沙箱约束、也不经过 DSH 审批。

实测（本机 codex 0.146.1）：不关任何能力时，让 Codex 跑一条 shell，它会走自己的 `commandExecution`，
DSH 只看到一段文字——命令执行对用户完全不可见。加上 `--disable shell_tool --disable unified_exec`
等之后，同样的提示下 Codex 明确回答"本会话没有 shell 执行工具"，协议里也不再出现任何执行项。

`scripts/bypass-check.mjs` 就是这条性质的回归测试：只给一个无害的 `echo` 工具，然后要求 Codex
"用任何能力"写文件、再"用任何能力"跑 `touch`，断言两个副作用都没发生。

`DEFAULT_DISABLED_FEATURES` = `apps, browser_use*, computer_use, hooks, in_app_browser, mcp_2026_07_28,
multi_agent(_v2), plugins, remote_plugin, request_permissions_tool, shell_tool, skill_search,
standalone_web_search, tool_call_mcp_elicitation, unified_exec`。

### 为什么 Host 半要"钉"模型

Agent 预设在 DSH 里只组合 Agent 的子插件，**不能决定模型路由**：`sessionController` 新建 Agent 时
一律取 `agentDefaultModel.currentSelection()`。所以插件在 Agent 创建后为 `codex` 预设的会话安装
Session 级模型选择。

而 `session.selectModel` 会**顺带把该选择存成全局默认**。若不复原，一个 Codex 会话会把之后所有
「DSH 默认」的新会话也带到 Codex 上。Host 半因此在选择落定后把之前的默认写回，并且只在默认仍等于
我们刚写入的值时才写——期间用户手动改过则尊重用户的改动。

## 安装

```sh
dsh plugin --profile desktop add /absolute/path/to/dsh-codex-session
dsh --profile desktop --dump-config
```

前置条件：本机 Codex 已登录（`codex login status`），且 `~/.codex/config.toml` 里
`[model_providers.custom]` 指向可用后端（本机为本地 Codex 代理）。

## 配置

`cordis.patch.yml` 中 `codex-session` 行：

| 键 | 默认值 | 说明 |
|---|---|---|
| `preset` | `codex` | 触发钉模型的 Agent 预设 id |
| `provider` | `codex-local` | 对外暴露的提供方路由 |
| `model` | 未设置 | 留空即用**本机 Codex 报告的默认模型**；设了就固定用它 |
| `models` | 未设置 | 留空即向本机 Codex 问 `model/list`；写一份完整列表则以此为准、不再询问 |
| `modelCacheTtlMs` | `300000` | 发现结果的缓存时长 |
| `modelProvider` | `custom` | 传给 `thread/start` 的 Codex 内部提供方 id，需与 `~/.codex/config.toml` 的 `[model_providers.*]` 对应；用官方登录时改成 `openai` |
| `command` | `codex` | Codex CLI。裸名会先在 PATH 上找，找不到再探测常见安装位置（`/opt/homebrew/bin/codex`、`~/.local/bin/codex`、`Codex.app` 资源目录等） |
| `timeoutMs` | `300000` | 单个 turn 上限，同时约束流式阶段每一次 JSON-RPC 请求 |
| `handshakeTimeoutMs` | `60000` | `initialize` / `thread/start` 握手超时；超时即杀掉子进程 |
| `maxCachedSessions` | `4` | 保活的 Codex 线程数（LRU） |
| `sessionIdleTimeoutMs` | `600000` | 空闲回收 |
| `env` | `{}` | 叠加到子进程环境（例如非标准位置的 `CODEX_HOME`） |
| `disabledFeatures` | 见下 | 关掉的 Codex 原生能力列表；设为 `[]` 即恢复 Codex 原样 |

## 如何更新可用的模型

**模型列表不写死**——默认向本机 Codex 问 `model/list`，结果缓存 5 分钟。所以：

```sh
npm run models-check      # 打印当前会提供哪些模型（本机实测 5 个：gpt-5.6-sol 为默认）
```

- **升级了 Codex 或换了代理**：重启 App 即可，列表自动跟着变（也可把 `modelCacheTtlMs` 调小）。
- **想手动固定列表**：把上面的 `models:` 取消注释并写全，写了就以它为准，不再询问 Codex。
- **想固定新 Codex 会话的默认模型**：设 `model: gpt-5.6-sol`；留空则跟随本机 Codex 的默认。
- **只想改某一个会话**：用输入框自带的模型选择器（DSH 原生），它列出的就是发现到的这些。

之前那份硬编码列表是错的，正好说明为什么改成发现：它提供了本机**并不存在**的 `gpt-5.4`/`gpt-5.4-mini`/
`gpt-5.3-codex-spark`（选了会失败），又漏掉了本机**确实有**的 `gpt-5.2`，默认值也与本机默认
（`gpt-5.6-sol`）不一致。

## 验证

```sh
npm test                        # 38 个测试：历史重建、工具命名空间、chunk 映射、续接判定、
                                #   真实 DSH tool-result 形状、apply() 注册与钉模型/复原默认，
                                #   以及客户端半（bundle 装载、两个界面渲染、按钮走的 Remote）
npm run models-check            # 打印本机 Codex 真实提供的模型列表
npm run live-check              # 对真实本机 Codex 跑三步（工具调用 / 随机 token 回传 / 追加续接）
npm run bypass-check            # 只给无害工具，断言 Codex 无法自行写文件或跑 shell
./scripts/verify-preset-pin.sh  # 隔离真实 Host：验证「新建会话选 Codex」与「给已存在的会话切 Codex」
                                #   两条路径、部署默认被复原、标准会话不受影响
../verify-codex-session.sh      # 在 /tmp 隔离 profile 中启动，确认所有 entry 无警告激活
```

`live-check` 需要一个可写的 `CODEX_HOME`（脚本会把 `auth.json`/`config.toml` 复制到 `/tmp`），
因为 App Server 需要写 sqlite 状态库。

## 已验证（2026-10-07 本机实测）

| 验证 | 命令 | 结果 |
|---|---|---|
| 单元 + Host + 客户端 | `npm test` | **38 pass / 0 fail**（含客户端 bundle 装载与两个界面的渲染/交互测试、模型发现的缓存与回退） |
| 模型发现 | `npm run models-check` | 本机实测返回 5 个模型、默认 `gpt-5.6-sol`，与 Codex 自己报告的完全一致 |
| 不可绕过性 | `npm run bypass-check` | 只提供无害 `echo` 工具时，Codex 写文件与跑 shell 两个副作用**均未发生**；关掉原生能力前实测它会走自己的 `commandExecution` |
| 预设 → 钉模型 → 路由（真实 Host） | `./scripts/verify-preset-pin.sh` | 四条全过：新建即选 Codex 被钉到 `codex-local/gpt-5.5`；给已存在的会话切 Codex 同样被钉；部署默认复原为 `opencode-go/deepseek-v4.1-flash`；`standard` 会话不受影响 |
| 真实 Codex 三步往返 | `npm run live-check` | 工具调用 → 隐藏随机 token 回传 → 追加式续接复用同一线程，9 项断言全通过；第二步**用真实 DSH tool-result 形状**（`role:'user'` + `tool-result` 块）喂入 |
| DSH agent loop 端到端 | `dsh --profile <p> --patch <overlay> "<task>"` | 让模型用 bash 工具跑 `echo BRIDGE-$RANDOM-$RANDOM`，模型无法预测输出；DSH 执行后回传，模型逐字复述该随机值 |
| 桌面同构 profile 启动 | `./verify-codex-session.sh` | 隔离 DSH_HOME 中启动，**所有 entry 无警告激活** |
| 运行中的桌面 GUI | host/client inspector | `preset-codex` 已生效；`conversation.input.dock` 与 `settings.plugins.tab` 都有 `codex-session` 占用且 active |

握手（`initialize` / `thread/start`）与流式阶段每一次 JSON-RPC 请求都有超时，超时即杀掉子进程并以 `TRANSPORT` 报错，不会把一次模型请求永久挂住。

`live-check` 的第二、三步是刻意的防伪设计：工具输出是运行时随机生成的，且从不出现在任何提示词里，
所以一旦实现把 DSH 的 tool-result 当成普通用户消息丢掉，第二步就会失败，而不是靠模型"猜"出 `echo` 的输出来蒙混过关。

## 限制

- 图片输入暂不支持：含图片的块会被替换为占位文本（Codex 原生图片通道尚未接通）。
- `codex` 预设的子插件列表是内置 `standard` 预设的复制。注册表会整体替换预设的子列表，
  所以这是有意为之的副本；DSH 升级后需要重新同步一次。
- 「会话类型」选择器只在**空白会话**上出现（已开始的 Codex 会话只显示后端标识）。
- 切换走的是 `agentPresets.select`；若会话尚未就绪会显示宿主返回的原因。
- Codex 自己的沙箱是 `read-only`、审批 `never`：它不能直接改工作区，必须经由 DSH 工具。
- 会话级线程缓存在内存中；进程重启、空闲回收或请求形状变化都会冷启动一个新线程并重建历史。
