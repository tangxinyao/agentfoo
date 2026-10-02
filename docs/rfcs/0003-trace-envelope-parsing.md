# RFC-0003：Trace 信封解析

- **状态**：已实现（Implemented）
- **对应提交**：`ff50aa5` `feat(agents): support opencode end-to-end and refactor trace parsing by wire envelope`
- **涉及模块**：`src/trace.ts`、`src/types.ts`（`Trace` / `TraceMessage` / `ToolCall`）、各适配器
- **关联文档**：外部文档 `../docs/agentfoo/05-trace-skill.md`

## 摘要

把"每个 agent 的原始输出"归一化成统一 `Trace` 的 parser，**按线上信封（wire envelope）组织，而不是按 agent 组织**。
四个内置 agent 映射到三种信封；每种信封一个 parser，共享一个流式归约层。

## 背景与动机

接入第二个 agent（opencode）时，最初为 hermes 写的 parser 被复制改造成 opencode 专用 parser，随后 pi/openclaw
（都经 acpx，讲 ACP 协议）又要第三个。继续"一个 agent 一个 parser"会导致：parser 数量随 agent 线性增长，
且 ACP 信封的解析逻辑要在 hermes/pi/openclaw 三个适配器里各写一遍。

更根本的教训是**静默空 trace**：几种协议差异很大（带 `role` 的记录 / 不带 role 的扁平 part 事件 / 把 tool call 与
tool result 拆开的 JSON-RPC 通知），每加一条"自动嗅探"分支就多一种误判并悄悄产出空 trace 的路径（§IX.1 失败模式）。

## 目标 / 非目标

**目标**

- 一种信封一个 parser，按线上格式命名，BYO CLI 可复用任意一个。
- 流式事件的归约逻辑只写一次（三种信封共享）。
- 识别不出来的流**响亮报错**，而不是返回空 trace。

**非目标**

- 不做一个"自动嗅探"的 `parseTrace`（曾作为 deprecated 别名保留）。
- 不发明新的 trace schema——归一化后的 `Trace` 形状照搬 OpenAI chat transcript。

## 设计

### 1. 三种信封 → 三种 parser（`src/trace.ts`）

| parser | 信封 | agent |
|---|---|---|
| `parseOpenAiChatTrace` | OpenAI chat jsonl，每条一个 `role` | BYO 默认（`CommandAgent`） |
| `parseOpencodePartTrace` | opencode `run --format json` 的 part 事件 | opencode |
| `parseAcpTrace` | ACP JSON-RPC `session/update` 流 | hermes / pi / openclaw |

### 2. 共享流式层 `reduceEventStream`

每个 stream parser 只是"信封 → `StreamEvent`"的映射器。`StreamEvent` 词汇表归一了流式 CLI 的各种形态：

- `text` / `reasoning` / `tool-call` / `tool-result` / `turn-end` / `available-commands`
- `tool-args`：pi 这类 agent 先声明 tool call（`rawInput: {}`）再逐 token 补参数，参数要**回填**到已 emit 的调用，而不是当成第二个调用。

归约器把事件折成 OpenAI 形状的消息记录，再交给 `buildTrace` 归一化。关键细节：文本与 reasoning 累积进 pending
assistant 消息，在 turn 边界 flush，或一收到 tool result 就 flush——保证 `assistant{tool_calls} → tool → assistant{text}`
的交错顺序与 OpenAI transcript 一致，避免把所有 tool result 堆到末尾、在 judge 打分的 `trace.text()` 里歪曲时序。

### 3. `available-commands` 捕获

ACP 的 `available_commands_update` 过去被当噪声丢掉。真实 hermes 抓包显示只有通用 gateway 命令
（`help`/`model`/`bash`…）、没有 per-skill 条目——这本身是 forced-mode 探测（见 RFC-0004）需要的证据：某 agent
是否在 ACP 上暴露 per-skill slash 命令，不是靠猜。归约时取 last-wins（流中途重发命令表应报当前集合）。

### 4. `Trace` 的两个视图

`Trace.text()`（含 tool result 的完整转录）与 `Trace.finalMessage`（最终回复）分离；`reasoning` 字段单独保存
（某些 agent 的 reasoning 是技能被预载触发的**唯一**可观测信号），但刻意排除在 `text()` 之外以免污染 judge 打分
（详见 RFC-0005）。

## 备选方案

- **一个 agent 一个 parser**：被重构前的状态。否决理由见背景。
- **自动嗅探 `parseTrace`**：否决。三种协议差异大，嗅探分支 = 静默空 trace 的温床。

## 风险与待办

- 信封一旦变更（agent 升级换协议），表现为"流里没有任何记录被识别"，`parseEventStream` 会转成响亮错误——这是设计行为，但需要维护者据此更新 parser。
- `tool-args` 回填依赖 id 关联；不提供 id 的 agent 无法回填，参数可能不完整。

## 参考

- `src/trace.ts` 文件头（信封表 + `reduceEventStream` 设计理由）
- 外部文档 `../docs/agentfoo/05-trace-skill.md`
