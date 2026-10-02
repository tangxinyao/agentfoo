# RFC-0002：多 agent 适配层与注册表

- **状态**：已实现（Implemented）
- **对应提交**：
  - `fbcd109` `feat(agents): introduce the multi-agent adapter registry with opencode and acpx`
  - `4c4d706` `feat(agents): add pi and openclaw adapters`
  - `4b52dcb` `feat(cli): select the agent under test with -a/--agent`
- **涉及模块**：`src/agent/{types,registry,acpx,hermes,pi,openclaw,opencode,command,shared}.ts`、`src/config-runtime.ts`、`dockers/*.Dockerfile`
- **关联文档**：外部文档 `../docs/agentfoo/03-agents.md`（本层是全仓库决策翻转最多的一层，翻转归档见其 §6）

## 摘要

把"被测的 coding agent"抽象成一个可插拔接口，让 agentfoo 从"给 hermes 写 skill 测试"横向扩成
**多 coding agent + 多 provider**。新增一个 agent = 一条注册表项 + 一个适配器（或一条 spec）+ 一个 Dockerfile。

## 背景与动机

最初的框架只认 hermes。接入第二个 agent（opencode）时暴露出硬编码问题：fixture/runtime 层到处
`if (kind === 'hermes')`。目标是把"选哪个 agent、怎么驱动它、它把 trace 写成什么线上格式"三者解耦，
让测试作者写一份 spec 能在多个 agent 上跑，且"四个 agent 跑同一份 spec 全绿"成为核心验收标准。

## 目标 / 非目标

**目标**

- 一个稳定的 `Agent` 接口，fixture 与 matcher 只依赖它。
- 一个运行时注册表，内置四个 kind，并支持消费者 `registerAgent` / `registerCommandAgent` 注册 BYO agent 而无需 fork。
- `-a/--agent` 让同一份 spec 可切换被测 agent。

**非目标**

- 不隐藏每个 agent 的差异到"一份通用配置"里——差异收敛到 `AcpxSpec` 等描述符，但每个 agent 仍保留自己的 Dockerfile 与 home 目录变量。

## 设计

### 1. `Agent` 接口（`src/agent/types.ts`）

小而稳的表面，七个方法：`init()` / `loadSkill()` / `loadWorkspace()` / `run()` / `reset()` / `teardown()` + 只读 `workspacePath` / `traces`。
`AgentBootOptions` 让 fixture 层对任何 kind 用同一段代码构造，并通过 `currentTest` 回调把"每个测试一个新会话"注入进去，适配器本身保持 vitest 无关。

### 2. 注册表（`src/agent/registry.ts`）

`AgentSpec` 三项：`create(opts)` 构造适配器、`homeEnvVar`（运行时把隔离 home 指给哪个环境变量）、`dockerfile`（内置镜像名）。
内置四个 kind，落到**三个适配器实现 + 三种线上信封**：

| Kind | 适配器 | 驱动方式 | homeEnvVar |
|---|---|---|---|
| hermes | acpx 适配器（`hermesAcpxSpec`） | `acpx --agent 'hermes acp' --cwd <ws>`，隔离键是 `--cwd` | `HERMES_HOME` |
| opencode | 原生 `OpencodeAgent` | `opencode run … --format json --auto` | `XDG_CONFIG_HOME` |
| pi | acpx 适配器（`piAcpxSpec`） | `acpx --cwd <ws> pi`，provider 配置写 `models.json` | `PI_CODING_AGENT_DIR` |
| openclaw | acpx 适配器（`openclawAcpxSpec`） | `acpx` + 常驻 Gateway | `OPENCLAW_STATE_DIR` |

`registerAgent(kind, spec)` 运行时覆盖/新增；`registerCommandAgent()` 是更高层的糖，给"我只有一个 CLI"的消费者按 `CommandAgentDef` 自动建 spec。

### 3. acpx 统一适配器（`src/agent/acpx.ts`）

hermes / pi / openclaw 都经 acpx（ACP 客户端）驱动，共享同一适配器；差异收敛为一条 `AcpxSpec`
（如何渲染 config、如何解析 trace 信封、是否支持 forced mode 等）。

### 4. BYO 通用 CLI 适配器（`src/agent/command.ts`）

`CommandAgentDef` 描述一次对话回合的 CLI 调用：`run(ctx)` 拿 prompt/model/provider/已加载技能/sessionId 等，
`extractSessionId` 决定如何续会话，`init` 可选。默认用 OpenAI chat 信封的 trace parser。

### 5. `-a/--agent` 选择（`src/config-runtime.ts` → `selectedAgentKind`）

`bootAgent()` 省略 kind 时，从 CLI 的 `-a/--agent`（环境变量 `AGENTFOO_AGENT`）取值，否则取唯一配置的 agent。
显式传 kind 则固定 fixture 到该 agent 并忽略 `-a`。npm 会吞掉 `-a`，故文档强调要用 `-- -a x`。

## 备选方案

- **每个 agent 一套独立 fixture/runtime 代码路径**：否决——这正是要消除的硬编码。
- **用 `npm_config_agent` 作为 `-a` 的 fallback**：随后被丢弃（`refactor: drop the npm_config_agent fallback`，现已并入 `4b52dcb`），因为 npm 会吞 `-a`，把裸值当路径过滤器，造成"ambiguous"的假报错。

## 风险与待办

- 宿主与容器版本漂移（见 README 奠基性前提 3）：`--local` 跑宿主二进制、docker 跑钉死版本，pi 实测差 9 个 minor 并产生过真实 bug。立场是记录版本、暴露错误、不追兼容。
- openclaw 的 Gateway 常驻、端口写死、宿主模式未验证（外部文档 03 §3.4b、04 §5）。
- 强制技能模式（forced mode）的杠杆 per-agent 各异，未验证的适配器显式抛"未实现"（见 RFC-0004）。

## 参考

- `src/agent/registry.ts`、`src/agent/types.ts`、`src/agent/acpx.ts`、`src/agent/command.ts` 文件头注释
- 外部文档 `../docs/agentfoo/03-agents.md`（职责表、决策翻转归档 §6）
