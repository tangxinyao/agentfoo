#!/usr/bin/env bash
# Verify option 1: disabling the session_search (+ memory) toolset at runtime
# (a) composes with a full config.yaml, and (b) actually stops cross-session leak.
set -uo pipefail
export HERMES_HOME=/tmp/hh; rm -rf "$HERMES_HOME"; mkdir -p "$HERMES_HOME"
# Full config.yaml like renderConfigYaml writes it:
cat > "$HERMES_HOME/config.yaml" <<YAML
model:
  default: ${DEEPSEEK_MODEL:-deepseek-v4-pro}
  provider: ${DEEPSEEK_PROVIDER:-deepseek}
  base_url: ${DEEPSEEK_BASE_URL:-https://api.deepseek.com}
memory:
  memory_enabled: false
YAML
npm install -g acpx@0.12.1 >/dev/null 2>&1

echo "===== (a) run 'hermes tools disable session_search memory' ====="
hermes tools disable session_search memory 2>&1 | tail -2
echo "--- config.yaml still has base_url + memory? ---"
grep -E 'base_url|memory_enabled|session_search' "$HERMES_HOME/config.yaml" || echo "(session_search correctly absent from allowlist)"
echo "--- tools list confirms disabled ---"
hermes tools list 2>&1 | grep -iE 'session_search|memory ' | head

echo; echo "===== (b) re-run the BANANA leak test with toolset disabled ====="
A='hermes acp'; W=/tmp/iso; rm -rf "$W"; mkdir -p "$W"
say(){ timeout 120 acpx --agent "$A" --cwd "$W" --approve-all --format json "$1" 2>&1 \
  | grep -oE '"text":"[^"]*","sessionUpdate":"agent_message_chunk"' | sed 's/.*"text":"//;s/".*//' | tr -d '\n'; echo; }
acpx --agent "$A" --cwd "$W" sessions new >/dev/null 2>&1
say "Remember this secret word: BANANA. Reply with only: OK" >/dev/null
acpx --agent "$A" --cwd "$W" sessions new >/dev/null 2>&1   # test 2 boundary
echo "test2 answer (want UNKNOWN, not BANANA):"
acpx --agent "$A" --cwd "$W" --approve-all --format json \
  "What was the secret word I told you earlier? If you don't know, reply exactly: UNKNOWN" 2>&1 \
  | grep -oE '"text":"[^"]*","sessionUpdate":"agent_message_chunk"' | sed 's/.*"text":"//;s/".*//' | tr -d '\n'; echo
