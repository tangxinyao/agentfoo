#!/usr/bin/env bash
# agentfoo 本机体检（第 0 步）。只读、零成本：不装依赖、不建镜像、不调模型。
#
# 用法（在 Windows 终端里跑，不要在 DSH 沙箱里跑——沙箱进不了发行版，会报 E_ACCESSDENIED）：
#   wsl -d Ubuntu -- bash -l /mnt/c/Users/shayt/Documents/github.com/agentfoo/scripts/dev-check.sh
#
# 输出里的 [MISS] / [warn] 就是下一步该补的东西，末尾会打印对应命令。
# 别把它塞进一行 `wsl ... bash -lc '...'`：wsl.exe 会用双引号把整串重新包一遍，
# 里面的引号/括号会被提前闭合，报 “syntax error near unexpected token `('”。

REPO="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"

hr()   { printf '\n== %s ==\n' "$1"; }
ok()   { printf '  [ok]    %s\n' "$1"; }
miss() { printf '  [MISS]  %s\n' "$1"; }
warn() { printf '  [warn]  %s\n' "$1"; }
info() { printf '          %s\n' "$1"; }

# ── 1. WSL 本身 ────────────────────────────────────────────────────────────
hr "WSL / 系统"
[ -r /etc/os-release ] && { . /etc/os-release; info "${PRETTY_NAME:-unknown}"; }
info "kernel $(uname -r)   arch $(uname -m)   cpu $(nproc)"
info "内存 $(free -h | awk '/^Mem:/{print $2}') 总 / $(free -h | awk '/^Mem:/{print $7}') 可用"
info "仓库（WSL 视角）：$REPO"

# ── 2. node / npm ─────────────────────────────────────────────────────────
# 非交互 shell 常拿不到 fnm/nvm 写进 .bashrc 的 PATH，这里按已知落点补一次。
hr "Node.js / npm"
for d in "$HOME/.local/share/fnm/aliases/default/bin" "$HOME/.local/bin"; do
  [ -d "$d" ] && case ":$PATH:" in *":$d:"*) ;; *) PATH="$d:$PATH" ;; esac
done
if ! command -v node >/dev/null 2>&1; then
  for d in "$HOME"/.nvm/versions/node/*/bin "$HOME"/.fnm/node-versions/*/installation/bin \
           "$HOME"/.local/share/fnm/node-versions/*/installation/bin; do
    [ -x "$d/node" ] && PATH="$d:$PATH"
  done
fi
if command -v node >/dev/null 2>&1; then
  ok "node $(node -v)   →   $(command -v node)"
  if command -v npm >/dev/null 2>&1; then ok "npm $(npm -v)"; else miss "npm（node 在但 npm 不在 PATH 上）"; fi
else
  miss "node —— WSL 里还没有 Node，先装（见文末）"
fi

# ── 3. Docker ─────────────────────────────────────────────────────────────
hr "Docker（第 4 步的端到端要用）"
if command -v docker >/dev/null 2>&1; then
  ok "$(docker --version 2>&1 | head -1)"
  if timeout 20 docker ps >/dev/null 2>&1; then
    ok "docker ps 免 sudo 可用 → AGENTFOO_DOCKER 留空即可"
    info "运行中容器 $(docker ps -q | wc -l) 个，本地镜像 $(docker images -q | wc -l) 个"
  elif timeout 20 sudo -n docker ps >/dev/null 2>&1; then
    warn "docker 需要 sudo → 在 .env 里写 AGENTFOO_DOCKER=sudo docker"
  else
    miss "docker ps 失败（daemon 没起？当前用户不在 docker 组？）"
  fi
  docker buildx version >/dev/null 2>&1 && ok "buildx $(docker buildx version | awk '{print $2}' | head -1)"
else
  miss "docker 命令不存在"
fi

# ── 4. agent 二进制（只影响 --local，不影响 Docker 路径）────────────────────
hr "Agent 二进制（只影响 --local）"
for b in hermes opencode pi openclaw acpx; do
  if command -v "$b" >/dev/null 2>&1; then
    v="$(timeout 10 "$b" --version 2>&1 | head -1)"
    ok "$b → $(command -v "$b")   [$v]"
  else
    miss "$b"
  fi
done
info "缺了不影响 Docker 路径；--local 需要它们，acpx 缺失时会自动 npx 兜底"

# ── 5. 仓库状态 ───────────────────────────────────────────────────────────
hr "仓库状态"
if cd "$REPO" 2>/dev/null; then
  info "分支 $(git rev-parse --abbrev-ref HEAD 2>/dev/null) @ $(git rev-parse --short HEAD 2>/dev/null)"
  if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
    warn "工作区有未提交改动（$(git status --porcelain | wc -l) 个文件）"
  else
    ok "工作区干净"
  fi
  info "领先 origin/main $(git rev-list --count origin/main..HEAD 2>/dev/null || echo '?') 个提交"
else
  miss "进不去 $REPO"
fi
[ -d "$REPO/node_modules" ] && ok "node_modules 已装"        || miss "node_modules 未装 → npm ci"
[ -d "$REPO/dist" ]         && ok "dist 已构建"              || miss "dist 未构建 → npm run build（example 走 dist/，不 build 会跑到旧代码）"
if [ -f "$REPO/.env" ]; then
  if grep -qE '^DEEPSEEK_API_KEY=.+' "$REPO/.env"; then
    ok ".env 存在，DEEPSEEK_API_KEY 非空"
  else
    warn ".env 存在但 DEEPSEEK_API_KEY 为空（judge 和容器内 agent 都会 401）"
  fi
else
  miss ".env 不存在 → cp .env.example .env 后填 key"
fi
[ -n "${AGENTFOO_DOCKER:-}" ] && info "当前 shell 里有 AGENTFOO_DOCKER=$AGENTFOO_DOCKER"

# ── 6. 行尾 ───────────────────────────────────────────────────────────────
hr "行尾（这个 checkout 是 core.autocrlf=true，仓库里没有 .gitattributes）"
crlf=0; total=0
while IFS= read -r f; do
  [ -f "$f" ] || continue
  total=$((total + 1))
  if grep -q "$(printf '\r')" "$f" 2>/dev/null; then crlf=$((crlf + 1)); fi
done < <(git -C "$REPO" ls-files 'scripts/*.sh' 'dockers/*.Dockerfile' 2>/dev/null)
info "受检 shell/Dockerfile $total 个，其中 CRLF $crlf 个"
if [ "$crlf" -gt 0 ]; then
  warn ".sh 带 CRLF 时直接执行会 bad interpreter；Dockerfile 一般没问题，build 报怪错时先查它"
  info "要统一成 LF：git config core.autocrlf input && git ls-files -z | xargs -0 sed -i 's/\r$//'"
else
  ok "全是 LF"
fi

# ── 7. 网络 ───────────────────────────────────────────────────────────────
hr "网络（WSL2 在 Win10 上只有 NAT，127.0.0.1 的宿主代理够不到）"
if [ -n "${HTTPS_PROXY:-}${https_proxy:-}${HTTP_PROXY:-}${http_proxy:-}" ]; then
  ok "shell 里已设代理：${HTTPS_PROXY:-${https_proxy:-${HTTP_PROXY:-$http_proxy}}}"
else
  info "shell 里没设代理（默认如此；国内镜像不需要，GitHub/npm 前先 proxy-on）"
fi
code="$(timeout 12 curl -s -o /dev/null -w '%{http_code}' https://api.deepseek.com 2>/dev/null || echo 000)"
case "$code" in
  2*|3*|4*) ok "api.deepseek.com 可达（HTTP $code）" ;;
  *)        warn "api.deepseek.com 不可达（HTTP $code）——第 4 步要用它，先 proxy-on 再重试" ;;
esac

# ── 8. 下一步 ─────────────────────────────────────────────────────────────
hr "下一步"
info "仓库路径（Windows）：C:\\Users\\shayt\\Documents\\github.com\\agentfoo"
info "仓库路径（WSL）：$REPO"
cat <<'EOF'
  依次跑：

  npm ci                                   # 只在 node_modules 缺失时需要
  cp -n .env.example .env                  # 然后编辑 .env，填 DEEPSEEK_API_KEY

  # 第 2 步：CI 同款离线门禁（零成本、不用 Docker、不花钱）
  npm test && npm run typecheck

  # 第 3 步：零成本接线检查（不建容器、不调模型）
  npm run build
  cd example && node --import ../scripts/register-ts.mjs ../src/cli.ts list

  # 第 4 步：真容器 + 真 token（第一次会 build 镜像，较慢）
  npm run example -- -a hermes frontend-design
  npm run example -- -a hermes
  npm run example -- -a opencode      # 单回合实测 195s，先把 config 里 timeout 抬到 600_000
  npm run example -- -a pi
  npm run example -- -a openclaw      # 约需 1.5GB 空闲内存

  # 第 5 步：宿主模式（需要上面第 4 节里的二进制）
  pkill -f "acpx/dist/cli.js __queue-owner"; pkill -f pi-acp
  AGENTFOO_FORCE_LOCAL=1 npm run example -- -a pi frontend-design

  没装 Node 的话：先 `proxy-on`，再
  curl -fsSL https://fnm.vercel.app/install | bash && fnm install --lts
EOF
