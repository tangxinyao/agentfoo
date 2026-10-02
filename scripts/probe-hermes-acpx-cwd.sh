#!/usr/bin/env bash
# Real-container probe (run INSIDE agentfoo-hermes): can hermes stay on acpx via
# the CWD-scoped session model instead of the falsified `-s agentfoo-<n>` named
# model (TODO §V / §VI)? Upgrades acpx to 0.12.1 first (image ships 0.12.0, but
# §VI's reopening hinges on 0.12.1's improved bug#3). Needs DEEPSEEK_API_KEY.
set -uo pipefail

export HERMES_HOME=/tmp/hh
W=/tmp/probe-cwd
mkdir -p "$HERMES_HOME" "$W"

# hermes config.yaml (mirrors renderConfigYaml): deepseek, memory off.
cat > "$HERMES_HOME/config.yaml" <<YAML
model:
  default: ${DEEPSEEK_MODEL:-deepseek-v4-pro}
  provider: ${DEEPSEEK_PROVIDER:-deepseek}
  base_url: ${DEEPSEEK_BASE_URL:-https://api.deepseek.com}
memory:
  memory_enabled: false
YAML

echo "===== [0] upgrade acpx 0.12.0 -> 0.12.1 (reopened path needs it) ====="
npm install -g acpx@0.12.1 >/dev/null 2>&1; echo "acpx now: $(acpx --version)"

echo; echo "===== [1] hermes acp readiness (free, no model) ====="
hermes acp --check 2>&1 | tail -5; echo "check-exit=${PIPESTATUS[0]}"

AGENT='hermes acp'
echo; echo "===== [2] create per-cwd session via --agent (bug#3 runtime half) ====="
timeout 90 acpx --agent "$AGENT" --cwd "$W" sessions new 2>&1 | tail -8; echo "new-exit=${PIPESTATUS[0]}"

echo; echo "===== [3] turn one — cwd default session, NO -s (bug#2 avoided) ====="
timeout 120 acpx --agent "$AGENT" --cwd "$W" --approve-all --format json \
  "Reply with exactly one word: ALPHA" 2>&1 | tail -15; echo "t1-exit=${PIPESTATUS[0]}"

echo; echo "===== [4] turn two — SAME cwd, does it remember? ====="
timeout 120 acpx --agent "$AGENT" --cwd "$W" --approve-all --format json \
  "What single word did you say a moment ago? Reply with only that word." 2>&1 | tail -15; echo "t2-exit=${PIPESTATUS[0]}"

echo; echo "===== [5] trace/history export options ====="
echo "--- 5a acpx sessions list ---";    timeout 60 acpx --agent "$AGENT" --cwd "$W" sessions list 2>&1 | tail -8
echo "--- 5b acpx sessions history ---"; timeout 60 acpx --agent "$AGENT" --cwd "$W" sessions history 2>&1 | tail -8
echo "--- 5c hermes native sessions list ---"; hermes sessions list --limit 3 2>&1 | tail -8

echo; echo "==== VERDICT INPUTS: check[1]=ok? new[2] initialized? t1/t2 returned ALPHA? [5] exportable? ===="
