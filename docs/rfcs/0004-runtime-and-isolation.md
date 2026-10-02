# RFC-0004：运行时与隔离

- **状态**：已实现（Implemented）
- **对应提交**：
  - `744ef5d` `feat(runtime): harden the --local runtime with forced skill mode, per-test isolation, and CI`
  - `3ee7627` `feat(runtime,agents): add writeFile, per-turn timeouts, and provider probing`
- **涉及模块**：`src/runtime/{types,docker,local}.ts`、`src/agent/{shared,provider-probe}.ts`、`src/config.ts`、`.github/workflows/ci.yml`
- **关联文档**：外部文档 `../docs/agentfoo/04-runtime.md`、`05-trace-skill.md` §6.1

## 摘要

执行环境的两个实现（docker 默认 / local 逃生舱）+ 三项可靠性能力：**每测试隔离**、**逐轮超时**、**provider 探针**，
外加强制技能模式（forced skill mode）和离线 CI 门禁。

## 背景与动机

- docker 是默认路径（CI 安全、副作用爆炸半径受控），但开发迭代慢，需要 `--local` 快速逃生舱。
- `--local` 曾有三个**静默失败** bug：跑的是宿主二进制、宿主 env 泄漏进子进程、隔离承诺只对 `homeEnvVar` 成立。
- 一个 LLM 回合可能跑几分钟，vitest 的整体超时给不出"哪一轮"卡住的信息。
- ACP 桥会把 provider 401 吞成"空回合 + exit 0"，排查只能看到静默失败。

## 目标 / 非目标

**目标**

- 同一 `RuntimeEnv` 接口下 swap local↔docker，适配器与 fixture 代码零改动。
- `--local` 至少保证：独立 workspace、独立 agent home、最小化环境变量白名单。
- 逐轮超时直接杀进程并报出是哪一轮。
- 空回合时主动问 provider 一句，把"key/model 被拒"与"provider 收了但 agent 内部配置错"两个分支分开。

**非目标**

- `--local` 不做沙箱——它**不是** CI 安全的，reporter 必须响亮标注 local run。
- 不追版本兼容（README 奠基性前提 3）。

## 设计

### 1. `RuntimeEnv` 接口（`src/runtime/types.ts`）

`exec(argv, opts)` / `copyDir` / `readFile` / `writeFile` / `teardown` + `workspacePath` / `skillsPath` / `agentHome` / `homeEnvVar`。
适配器只依赖这个接口，换运行时不动适配器代码。

### 2. Docker 运行时（`src/runtime/docker.ts`）

- 每个 agent 实例一个 fresh 容器。
- 镜像可预构建（`image`）或按 Dockerfile 现场构建——构建一次、按内容哈希打 tag、复用直到 Dockerfile 变。
- `AGENTFOO_DOCKER` 环境变量（按空白拆分）让 `sudo docker` 或 podman 无需改代码。

### 3. Local 运行时（`src/runtime/local.ts`）

- 在临时目录起一个 throwaway workspace + agent home。
- `ENV_ALLOWLIST = [PATH, HOME, LANG, LC_ALL, TERM, TMPDIR]`：**故意不是**整个 `process.env`。曾把宿主真实的
  `PI_CODING_AGENT_DIR` / `OPENCLAW_STATE_DIR` / 无关 API key 泄漏给从未通过 `passEnv` 索要它们的子进程。

### 4. 每测试隔离（`isolatePerTest`）

`AgentBootOptions.currentTest` 回调注入"当前测试名"，测试名在两次 `run()` 之间变化时适配器重置会话——每个测试开
新对话，适配器保持 vitest 无关。`test.concurrent` 下由 `createAgentPool` 显式把 checkout 的 agent 绑定到测试。

### 5. 逐轮超时（`run(prompt, { timeout })`）

`timeout` 只约束这一轮：进程被杀、`run()` reject 并报出哪一轮超时，而不是整个测试带着泛化消息超时而 agent 还在跑。
`turnTimedOut()` 附上 prompt 预览与最后输出尾部。

### 6. `writeFile`

替换旧的 per-adapter `cat <<'EOF'` heredoc——heredoc 在内容含分隔符时破裂，且对 YAML 与 `${VAR}` 引用做 shell 转义极敏感。
`RuntimeEnv.writeFile` 是适配器放置配置文件的唯一方式，创建父目录。

### 7. provider 探针（`src/agent/provider-probe.ts`）

空回合时用同一 endpoint/key/model 发一个最小请求，从宿主发出（不容器内），只求区分
"provider 拒绝" vs "provider 接受，故障在 agent 自身配置"。永不 throw。

### 8. 强制技能模式（forced skill mode）

`loadSkill(hostPath, { force: true })` 绕过 agent 自己的发现步骤，把 SKILL.md 内容确定性注入
（`inlineSkillPrompt` 把正文 inline 到 prompt 前，并声明相对路径的目录）。用于单独给 SKILL.md 内容质量打分。
只有验证过杠杆的适配器支持；其它显式抛错。`force` 与 `toHaveBeenCalled` 不可组合（否则 throw）。

### 9. CI 门禁（`.github/workflows/ci.yml`）

最小离线门禁：`npm test` + `tsc --noEmit`，不触发真机 LLM 调用。

## 备选方案

- **`--local` 铺整个 `process.env`**：否决。docker 侧 env 已是最小集，铺满宿主 env 会让"隔离"承诺只对 `homeEnvVar` 成立。
- **heredoc 写配置**：被 `writeFile` 取代（见 §6）。
- **整体超时兜底逐轮超时**：否决。拿不到"哪一轮"。

## 风险与待办

- openclaw Gateway 端口写死（P1.5），宿主模式未验证。
- forced mode 的杠杆 per-agent：仅 hermes 有已验证杠杆；opencode/BYO 显式抛"未实现"。
- 每测试隔离对"多轮跨测试会话"型测试是破坏性的——这是刻意取舍，测试应自足。

## 参考

- `src/runtime/types.ts`、`src/runtime/local.ts`、`src/runtime/docker.ts`、`src/agent/shared.ts`、`src/agent/provider-probe.ts` 文件头注释
- 外部文档 `../docs/agentfoo/04-runtime.md`
