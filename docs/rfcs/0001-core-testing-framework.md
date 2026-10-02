# RFC-0001：核心测试框架

- **状态**：已实现（Implemented）
- **对应提交**：`ddae677` `feat: scaffold the agentfoo skill-testing framework`
- **涉及模块**：`src/{types,config,skill,judge,matchers,trace,fixtures,index,cli,reporter,progress,retry,artifacts}.ts`、`src/runtime/*`、`src/agent/hermes.ts`、`src/agent/types.ts`
- **关联文档**：外部设计文档 `../docs/agentfoo/`（01-cli-config、02-fixtures-dsl、05-trace-skill、06-assertions-judge、07-retry、08-artifacts-progress）

## 摘要

agentfoo 的初始骨架。它确立了一个核心命题：**"用起来像 vitest 的 skills / agents 单元测试框架"**。
测试作者用熟悉的 vitest DSL 写 `.spec.ts`，agentfoo 在 vitest 之上补齐三样东西——在容器里启动被测 agent、
检测"技能是否真的被触发"、用 LLM judge 给自由文本输出打分。

## 背景与动机

对 agent skill 做测试有三个 vitest 本身解决不了的问题：

1. **被测对象不是纯函数，而是一个会起容器、跑 shell、读文件、连网络的 coding agent。** 需要一个可复现、且能兜住副作用爆炸半径的执行环境。
2. **"技能被用上了"没有现成的断言。** 传统单测断言返回值，而技能是否触发是 agent 内部行为，需要 spy 式的检测信号。
3. **输出是自由文本。** "写得对不对、好不好"无法用 `toEqual` 断言，需要 LLM judge 按 rubric 打分。

因此第一个 commit 把这三块（runtime + skill 检测 + judge）连同 vitest 的接缝一起立起来。

## 目标 / 非目标

**目标**

- 复用 vitest 的 runner / CLI / watch / reporter，只在其上加 agentfoo 特有表面（`run`/`watch` 动词、`.env` 加载、`agentfoo.config.ts` 自动发现）。
- 提供稳定、小而薄的公开导入面：测试作者从 `agentfoo` 一个入口 import vitest 原语 + 自定义 matcher。
- 每次测试默认跑在干净的 Docker 环境；`--local` 作为开发逃生舱（见 [RFC-0004](./0004-runtime-and-isolation.md)）。

**非目标**

- 不从零实现 test runner。`src/cli.ts` 是"对 vitest CLI 的薄翻译层"，`agentfoo run → vitest run --config agentfoo.config.ts`。
- v0.1 不追求 API 稳定，公开类型显式标记 pre-1.0。

## 设计

### 1. 公开入口（`src/index.ts`）

```ts
import './matchers.js'                       // 副作用：注册自定义 matcher
export { test, expect, describe, it, … } from 'vitest'
export { bootAgent, createAgentPool, retry, converse, … }
```

- 测试作者 import `agentfoo` 即拿到 vitest 原语 + 已注册的 `toSatisfy` / `toHaveBeenCalled`。
- 接口层刻意不泄露 vitest 内部类型（`src/types.ts` 头注：vitest 基础是"可撤回的赌注"）。

### 2. 配置（`src/config.ts` / `src/config-runtime.ts`）

`defineConfig()` 是 vitest config 的薄包装，额外做了三件事：

- 携带 agentfoo 专属配置（judge model、per-agent 默认、retries）进 worker——序列化进 `AGENTFOO_CONFIG` 环境变量，worker 内由 `loadConfig()` 读回，fixture/matcher 不直接解析 env。
- 注册 artifact reporter。
- 应用适合"慢、外部资源"测试的默认值：默认不 watch、`testTimeout` 默认 300s、串行执行（避免容器/LLM 调用踩踏）。

### 3. 测试组织（`src/fixtures.ts`）

`bootAgent()` 是唯一的启动入口：查注册表 → 解析配置 → 选运行时 → 写 agent 配置到隔离 home → 返回 `Agent`。
不强制固定 fixture 名，交给 `test.extend({ agent: async ({}, use) => { … } })` 模式，按 vitest 语义控制生命周期。

### 4. 技能检测（`src/skill.ts`）

`SkillHandle` 既是"加载这个技能"的动作，也是 spy 目标。检测器是可插拔的：

- 默认 `detectSkillInvocations`（按 tool call 名猜）。
- `reasoningReferenceDetector`：hermes 这类把技能预载进 system prompt 的 agent，触发信号是模型在 reasoning 里点名技能 → 合成 `skill:<name>` 标记调用。
- `skillFileReadDetector`：pi/openclaw 这类"给路径让模型自己读"的 agent，触发信号是读取 `<skill>/SKILL.md` 的路径或返回的 frontmatter。

`activeDetector()` 的分辨顺序：全局 `setSkillDetector` → 适配器自带默认 → 内置猜测。

### 5. 断言（`src/matchers.ts`）

- `await expect(trace).toSatisfy(rubric, { threshold })`——LLM judge matcher，**异步、必须 await**（网络往返不可能同步）。
- `expect(skill).toHaveBeenCalled()` / `.toHaveBeenCalledWith()`——同步 spy matcher。

### 6. 判分（`src/judge.ts` + `src/providers.ts`）

judge model 用 provider 前缀字符串（`anthropic/claude-…`、`deepseek/…`）。provider 路由与每个 provider 的 endpoint / API-key env / wire 方言由 `providers.ts` 统一拥有，`judge.ts` 只拥有 anthropic 与 openai 两种请求/响应方言。未知 provider 响亮报错而非静默错路由。

## 备选方案

- **自造 runner**：否决。vitest 的 `test.extend` fixture 机制（`use()` 划分 setup/teardown、`scope` 控制生命周期、按参数解构自动依赖解析）恰好解决"容器要不要在用例间共享、谁清理"的问题，自造全局命令式 API 更不彻底。
- **拆分 skillfoo / agentfoo 两个产品**：否决。见 README 的奠基性前提 1。

## 风险与待办

- vitest 面向"快速进程内 watch"的假设，与"起容器 + 等 LLM 往返"的慢测场景可能冲突——这是显式可撤回决策，换底层时接口层尽量不动。
- 默认技能检测启发式（§11 部分验证）对未知 agent 可能误判，需按 agent 各自 pin 信号（后续 RFC-0002 落地）。

## 参考

- `src/index.ts`、`src/types.ts`、`src/config.ts`、`src/skill.ts`、`src/judge.ts`、`src/matchers.ts` 文件头注释
- 外部文档 `../docs/agentfoo/README.md` §0–§1（定位与奠基性前提）
