# RFC-0005：评测循环（grading / sampling / triggers / concurrency）

- **状态**：已实现（Implemented）
- **对应提交**：`e9e77a5` `feat(eval): add persisted gradings, final-message grading, sampling, triggers, and concurrency`
- **涉及模块**：`src/{judge,matchers,artifacts,reporter,converse,fixtures}.ts`、`src/types.ts`
- **关联文档**：外部文档 `../docs/agentfoo/06-assertions-judge.md`、`08-artifacts-progress.md`

## 摘要

把 LLM judge 从"跑一次给个分"升级成**可复现、可聚合、可采样**的评测循环：判分落盘、默认按最终回复打分、
触发器（trigger）统计、agent 池并发采样、脚本化多轮对话。

## 背景与动机

单次 `toSatisfy` 判分有几个缺口：

1. 判分结果只在内存里，跑完就没了——无法事后审计、无法跨轮比较。
2. 默认拿"整个转录"打分有系统性偏差：对 pi/openclaw 这类"读 SKILL.md 来加载技能"的 agent，转录里含技能自己的指令，
   "解释这个类比的局限"会被当成答案来打。实测 pi 上同一弱答案：按转录 3/3 通过，单独按最终回复 1/3。
3. "技能是否触发"此前没有量化，只有 pass/fail。
4. 一个真实 agent 回答 + judge 打分都随机，单次跑分不出真回归与硬币翻转的区别。
5. 交互式技能（头脑风暴、面试）单轮 `run()` 只测得出开场白。

## 目标 / 非目标

**目标**

- 判分、trigger 断言、agent 版本等全部落盘到 `.agentfoo/runs/<id>/`，reporter 汇总成 `report.json`。
- 打分目标默认 `finalMessage`，可显式选 `transcript`。
- trigger 断言可聚合成 precision / recall / F1。
- agent 池按宿主内存上界并发采样，支持 `test.concurrent` 下的正确归属。
- `converse()` 提供脚本化多轮对话。

**非目标**

- 不做分布式评测调度——单机、进程内并发即可。
- 不把"重复跑直到稳定"做成默认行为（那是 `agentfoo score` 的职责，见 RFC-0006）。

## 设计

### 1. 判分落盘（`src/artifacts.ts` + `src/reporter.ts`）

- 每次 `toSatisfy` 写 `judge-<n>.json`（含逐条 rubric 的完整 breakdown）；trigger 断言写 trigger 记录。
- run id 经 `AGENTFOO_RUN_ID` 在 worker 间共享，一个 `agentfoo run` 写进同一目录。
- reporter 只做两件事：写 `report.json` 汇总、结尾打印 artifacts 目录（一键可点）。
- 路径段用 `sanitize()` 保留任意文字的字母数字——纯 ASCII 过滤器会把 CJK 命名测试都塌成同一个 `_` 目录互相覆盖。

### 2. 打分目标（`src/matchers.ts` → `satisfyTarget`）

`toSatisfy(received, rubric, { target })` 默认 `final`（即 `trace.finalMessage`），显式 `target: 'transcript'` 才用 `trace.text()`。
`reasoning` 字段从来不在打分文本里（见 RFC-0003）。

### 3. 触发器统计（trigger）

每个 `toHaveBeenCalled` / `.not` 断言写一条 trigger 记录（技能、是否触发、是否期望触发），`triggerStats` 聚合成
precision / recall / F1。`AGENTFOO_TRIGGER_ONLY=1` 让 `toSatisfy` 变 no-op——评估"description 是否让 agent 去够技能"
时只花 agent 回合、不花 judge 调用（RFC-0006 `optimize-description` 依赖它）。

### 4. 并发采样（`src/fixtures.ts` → `createAgentPool`）

- `AgentPoolOptions.size` 是存活 agent（容器）上界，默认取配置 `concurrency`；文档提示按宿主内存定
  （pi 容器 ~270MB，openclaw ~850MB）。
- `testNameOf(task)` 从测试自己的 task 对象推导名字（`describe > it`），`test.concurrent` 下仍正确归属到具体测试，
  而不是"最后启动的那个测试"。

### 5. 多轮对话（`src/converse.ts`）

`converse(agent, prompt, responder, { maxTurns })` 扮演用户：每轮 agent 回合后问 responder 下一句说什么，
responder 返回 `undefined` 或到 `maxTurns`（默认 8）停。`dialogue()` 只输出交替的 `User:` / `Agent:` 最终回复块——
不含 tool call / tool result，所以打分不会把"agent 读过的文件"算成它的产出。

## 备选方案

- **默认按转录打分**：实测被推翻（pi 3/3 vs 1/3），改为默认 finalMessage。
- **`test.concurrent` 用全局当前测试名**：`globalTestName` 会指向最后启动的测试，被 `testNameOf` 取代。

## 风险与待办

- judge 自身的 token 预算曾出 bug（reasoning judge 被截断返回半截 JSON）——`truncated` 与 `text` 同等重要。
- 采样规模仍受单机内存约束；更大规模要外置调度。

## 参考

- `src/matchers.ts`（`satisfyTarget` 的 pi 实测理由）、`src/artifacts.ts`、`src/converse.ts`、`src/fixtures.ts` 文件头注释
- 外部文档 `../docs/agentfoo/06-assertions-judge.md`、`08-artifacts-progress.md`
