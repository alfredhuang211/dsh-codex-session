# 发布与其他设备安装

本文档说明如何把这个插件提交到 GitHub，以及**别人（或你的另一台设备）怎么装**。

已在本机验证：`./scripts/verify-install-from-git.sh` 会把这个仓库 clone 成一个裸仓库（模拟 GitHub），
再用 `git+file://…` 装进一个全新的 DSH profile 并启动，确认所有 entry 激活；同时校验 npm tarball
的内容。两条安装路径都通过。

---

## 0. 先改掉仓库地址里的用户名

我在 `package.json` 里用了占位的 GitHub 用户名 `alfredhuang`。**如果那不是你的 GitHub 用户名，先改这 4 处**：

```sh
cd /Users/alfredhuang/Documents/deepseek-harness/default-workspace/dsh-codex-session
grep -rl 'github.com/alfredhuang' package.json README.md
# 用你的用户名替换，例如：
#   sed -i '' 's#github.com/alfredhuang#github.com/<你的用户名>#g' package.json README.md
```

---

## 1. 一次性：推到 GitHub

```sh
cd /Users/alfredhuang/Documents/deepseek-harness/default-workspace/dsh-codex-session

# 仓库已经初始化并提交好了（分支 main）。先在 GitHub 网页上建一个空的公开仓库
# dsh-codex-session（不要勾选 README / .gitignore / License，避免冲突），然后：
git remote add origin https://github.com/alfredhuang211/dsh-codex-session.git
git push -u origin main
```

推送前建议先看一眼会推什么——本地那份 DSH profile 备份**必须**留在本地：

```sh
git status --short          # 应只有你刚改的文件
git check-ignore -v .backup-desktop-profile-20261007-170236/package.json
# .gitignore 已忽略 .backup-desktop-profile-*/，内含你自己的 profile 配置，不要外发
```

用 GitHub CLI 的话可以一步到位（本机未安装 `gh`）：

```sh
gh repo create dsh-codex-session --public --source=. --push
```

---

## 2. 其他设备怎么装

前提（三选一都一样）：目标设备已装 **DSH 桌面版 0.2.0-rc.2 或更新**，并已装好、登录好 **`codex` CLI**
（`codex` 在 `PATH` 上，或 `~/.codex` 已登录）。插件本身**零依赖**，不需要联网装任何 npm 包
（除了方式 A/B 拉取仓库本身）。

### 方式 A：直接从 GitHub 装（推荐，不用发 npm）

```sh
dsh plugin --profile desktop add git+https://github.com/alfredhuang211/dsh-codex-session.git
```

锁版本（建议，避免上游改动影响你）：

```sh
dsh plugin --profile desktop add git+https://github.com/alfredhuang211/dsh-codex-session.git#v0.1.0
```

### 方式 B：从 npm 装（需要你先 `npm publish`）

```sh
npm login
npm publish          # package.json 已设好 publishConfig.access=public
# 其他设备：
dsh plugin --profile desktop add dsh-codex-session
```

### 方式 C：手动克隆（内网 / 离线 / 想改代码）

```sh
git clone https://github.com/alfredhuang211/dsh-codex-session.git ~/plugins/dsh-codex-session
dsh plugin --profile desktop add ~/plugins/dsh-codex-session
```

装完**重启 DSH 桌面 App**（Host 半的 bundle patch 在启动时读取）。然后新建会话，输入框上方会出现
会话类型选择器，Agent 预设里会多出「Codex」。

### 装完自检

```sh
cd <插件目录或 ~/.dsh/profiles/desktop/node_modules/dsh-codex-session>
npm run models-check        # 应列出本机 Codex 真实提供的模型
```

---

## 3. 后续升级

```sh
# 改完代码，提升版本号（package.json 的 version）
git add -A && git commit -m "…"
git tag v0.1.1 && git push && git push --tags
```

其他设备更新（git 方式）——按 tag 装即锁版本，不指定 tag 则取默认分支最新提交：

```sh
dsh plugin --profile desktop add git+https://github.com/alfredhuang211/dsh-codex-session.git#v0.1.1
```

---

## 4. 别人装之前你需要知道的三件事

1. **`modelProvider` 默认不指定**，Codex 会用它自己 `~/.codex/config.toml` 里的 `model_provider`。
   这是刻意的：写死一个别人机器上不存在的名字会**硬报错**
   （`Model provider \`x\` not found`）。所以无论对方用官方登录还是本地代理，默认都能跑。
2. **模型列表是运行时从本机 Codex 发现的**（`model/list`）。插件不携带模型清单，因此不会像固定
   列表那样提供本机不存在的模型；`npm run models-check` 可查看。
3. **`cordis.patch.yml` 里 `preset-codex` 的 19 个子插件是从 DSH 内置 `standard` 预设复制的**。
   这是为了让 Codex 会话拥有与标准会话一致的工具集；DSH 大版本升级后若 builtin `standard` 变了，
   这份列表需要重新对齐。README 的「已知限制」里也写了。

## 5. 仓库里都有什么

| 路径 | 作用 |
|---|---|
| `lib/provider.js` | `codex-local` 适配器，App Server JSON-RPC 客户端（零依赖，只用 `node:*`） |
| `lib/index.js` | 注册适配器 + 把 codex 预设的会话钉到该路由 |
| `lib/client.js` | 客户端半：新会话选择器、会话标识、设置页 |
| `cordis.patch.yml` | `codex` Agent 预设 + provider 配置行 |
| `test/` | 38 个测试（`npm test`） |
| `scripts/` | 对真实 Codex / 真实 Host 的验证脚本，见 README「验证」 |
| `SPEC-provider.md` | 实现规格与协议实测记录 |
| `LICENSE` | MIT |
