# RFC-0006：技能改进循环（review / suggest / compare / score / optimize）

- **状态**：已实现（Implemented）
- **对应提交**：`1c89058` `feat(cli): add review, suggest, compare, score, and optimize commands`
- **涉及模块**：`src/{review,review-page,suggest,compare,compare-page,score,optimize,optimize-description,cli}.ts`、`src/agent/shared.ts`
- **关联文档**：外部文档 `../docs/agentfoo/01-cli-config.md`；算法参照 SkillOpt（arXiv 2605.23904）

## 摘要

在已有"跑测试 + 判分"的 forward pass 之上，补上 SkillOpt 风格的 backward pass 与门禁，组成一个
**可人工介入的技能自我改进循环**：先度量（score）→ 对比（compare）→ 提出有界修改（suggest）→ 门禁接受（optimize）→ 人工复核（review）。

## 背景与动机

判分只能回答"这轮过没过"，不能回答"怎么改"。且技能改进**不能只交给 judge**：rubric 可能错、judge 可能吵、
"这是不是好文章"归根结底是人的判断。因此把改进拆成五个各司其职的 CLI 命令，每一步都可独立使用、可人工插桩。

## 目标 / 非目标

**目标**

- `score`：跑 `repeat` 次，给每个 case 的 pass 数、均分与方差、按 tag 分组——一次跑分不出真回归与硬币翻转。
- `compare`：两个技能版本跑同一套件，逐 case 问"哪个更好"（pairwise 偏好比绝对分更锐利）。
- `suggest`：读一次 run 的证据，让 optimizer 模型提出**有界**的 SKILL.md 修改，只写出、不应用。
- `optimize`：train→suggest→gated sel 的循环，候选只有超过 margin 才接受；被优化的技能**从不被写入**。
- `optimize-description`：只调 frontmatter `description`，用 trigger F1 做信号（决定 agent 是否"去够"技能）。
- `review`：本地页面人工打分、逐条同意/驳回 judge 结论、编辑 rubric。

**非目标**

- 不自动应用修改到原技能——输出到 `best/SKILL.md` + diff，由人决定。
- 不实现 SkillOpt 的 epoch 级慢更新与 optimizer 侧 meta-skill。

## 设计

### 1. `score`（`src/score.ts`）

整套件跑 `repeat` 次，每个 case 得到 pass 计数、分数的均值与方差；suite 级给 overall 的均值/方差/pass rate，
并按 `meta` 分组。测出的方差同时是 `optimize --margin` 的合理取值。

### 2. `compare`（`src/compare.ts` + `src/compare-page.ts`）

对 skill A/B 跑同一套件，逐 case 用 LLM 做 pairwise 判断。**消除位置偏差**：每个 case 在两个呈现顺序下各判一次，
`winner` 只在两个顺序都赢时才判胜；原始 [a-first, b-first] 结果保留供检查位置偏差。`review --compare` 给盲测的
人工并排偏好页面。

### 3. `suggest`（`src/suggest.ts`）

backward pass 的关键取舍照搬论文：

- 失败与成功**分开**做 minibatch 分析（单条 trajectory 给的是轶事，批量才暴露反复出现的修复）；
- 失败修复在合并时优先，成功贡献"要保留的规则"；
- 合并池裁剪到 edit budget——**文本学习率**，保证一步不会把技能整篇重写；
- 修改是四种原子 op（锚点上的 edit/insert/delete/replace），每条记录是否应用成功；
- 不碰 frontmatter（`description` 管触发，与此处证据无关）。

human review 的结果作为**最高优先级证据**注入：`overruled`（人驳回的 judge 结论）与 `criteriaEdits`（人改的 rubric）。

### 4. `optimize`（`src/optimize.ts`）

每步：跑 train split → `suggest` 提出 ≤ L_t 条编辑（余弦衰减的 budget）→ 跑 sel split 打分 → 只有 sel 分数比当前高
超过 `margin` 才接受。被拒候选的编辑与分数差进入 buffer，下一步 backward pass 可见。相同候选按哈希只打分一次。

### 5. `optimize-description`（`src/optimize-description.ts`）

触发那一半的优化。信号是 trigger 记录聚成的 precision / recall / F1（RFC-0005），跑时设 `AGENTFOO_TRIGGER_ONLY=1`
使 `toSatisfy` no-op——评估 description 只花 agent 回合、不花 judge。每步收集 train split 的误报/漏报，让 optimizer
写几个候选 description，在 sel split 上打分，只接受 F1 超过 margin 的最佳者。只改 `description`。

### 6. `review`（`src/review.ts` + `src/review-page.ts`）

本地页面（127.0.0.1）给每个 case：1–5 评分、对每条 judge 结论 agree/disagree、编辑评价点本身（edit/remove/add，
可指定 layer）。保存到 `.agentfoo/runs/<id>/review.json`。agentfoo 保持套件无关：rubric 编辑记为"这条 criteria → 那段文本"，
映射回套件自己的 case 文件是套件的职责。

### 7. 技能替换机制（`src/agent/shared.ts` → `resolveSkillOverride`）

`optimize` 评估候选 SKILL.md 时，通过 `AGENTFOO_SKILL_OVERRIDES`（`{"<name>": "<dir>"}`）在 `bootAgent` 内把技能目录
换成候选，用户 spec/fixture 一行不改，也从不写被优化的技能。

## 备选方案

- **让 judge 自己全自动改进**：否决。rubric/judge 都可能错，`review` 把人的判断作为最高优先级证据注入 `suggest`。
- **绝对分比较版本**：否决。绝对分粗且吵，pairwise 偏好 + 双向顺序控制位置偏差是更锐利的信号。

## 风险与待办

- `optimize` 的 train/sel split 由测试名 pattern（`-t '\[train/'` / `-t '\[sel/'`）选择，依赖套件自带标签。
- 未实现论文的慢更新与 meta-skill；候选接受仍以单步 sel 分数为准。
- 所有 LLM 环节共用 judge 的 provider 路由（`optimizer: JudgeConfig`），成本与稳定性受同一套 provider 影响。

## 参考

- `src/suggest.ts`、`src/optimize.ts`、`src/compare.ts`、`src/review.ts` 文件头注释
- 外部文档 `../docs/agentfoo/01-cli-config.md`（CLI 一览）
