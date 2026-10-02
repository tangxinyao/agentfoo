# agentfoo RFC 索引

本目录是按**功能模块**组织的 RFC（设计提案）文档，每一篇对应清洗后 git 历史里的一个或多个关键提交。
RFC 回答"为什么这么设计"，与仓库内的实现（`src/`）和外部设计文档
（`../docs/agentfoo/`，按代码架构组织）互补：那边按层讲实现，这里按模块讲**决策与取舍**。

## 约定

- 每篇 RFC 头部标注**对应提交**（清洗后的 commit sha + message），可直接 `git show <sha>` 对照。
- 结构统一为：摘要 → 背景与动机 → 目标 / 非目标 → 设计 → 备选方案 → 风险与待办 → 参考。
- 状态均为 **已实现（Implemented）**——它们是先实现、后补的"决策记录"，不是待评审的提案。

## 目录

| RFC | 标题 | 对应提交 |
|---|---|---|
| [0001](./0001-core-testing-framework.md) | 核心测试框架 | `ddae677` feat: scaffold the agentfoo skill-testing framework |
| [0002](./0002-agent-adapter-registry.md) | 多 agent 适配层与注册表 | `fbcd109` 多 agent 适配器注册表；`4c4d706` pi/openclaw；`4b52dcb` `-a/--agent` |
| [0003](./0003-trace-envelope-parsing.md) | Trace 信封解析 | `ff50aa5` opencode 端到端 + 按线上信封拆分 trace parser |
| [0004](./0004-runtime-and-isolation.md) | 运行时与隔离 | `744ef5d` `--local` 加固 + 强制技能模式 + 每测试隔离 + CI；`3ee7627` writeFile/逐轮超时/provider 探针 |
| [0005](./0005-eval-loop.md) | 评测循环（grading / sampling / triggers / concurrency） | `e9e77a5` feat(eval): persisted gradings, final-message grading, sampling, triggers, concurrency |
| [0006](./0006-skill-improvement-loop.md) | 技能改进循环（review / suggest / compare / score / optimize） | `1c89058` feat(cli): review, suggest, compare, score, optimize |

## 三条奠基性前提（贯穿所有 RFC）

1. **单一框架，不拆分 skillfoo / agentfoo。** skill 测试本质是"只加载一个 skill 的 agent 测试"，共享的 Docker 编排、config 扫描、judge、reporter 占绝大部分复杂度。
2. **v1 直接构建在 vitest 之上（可撤回）。** 复用 vitest 的 runner / CLI / watch / fixture 机制，而非自造；接口层尽量不泄露 vitest 内部，以便将来可换底层。
3. **`--local` 与 docker 跑的不是同一个 agent。** 宿主二进制与 Dockerfile 钉死的版本会漂移，框架立场是"记录版本、暴露错误、不追兼容"。

> 更完整的论证与历次真机验证、被证伪假设的归档，见外部设计文档 `../docs/agentfoo/`（01-cli-config … 09-packaging）。
