#!/usr/bin/env bash
# Capture the raw acpx --format json envelope for a TOOL-USING turn, so the trace
# parser (parseAcpxTrace) and skill-detection (§11) can be pinned to real shapes.
set -uo pipefail
export HERMES_HOME=/tmp/hh; mkdir -p "$HERMES_HOME"
cat > "$HERMES_HOME/config.yaml" <<YAML
model:
  default: ${DEEPSEEK_MODEL:-deepseek-v4-pro}
  provider: ${DEEPSEEK_PROVIDER:-deepseek}
  base_url: ${DEEPSEEK_BASE_URL:-https://api.deepseek.com}
memory:
  memory_enabled: false
YAML
npm install -g acpx@0.12.1 >/dev/null 2>&1
A='hermes acp'; W=/tmp/tool; rm -rf "$W"; mkdir -p "$W"; echo "hello from file" > "$W/note.txt"
acpx --agent "$A" --cwd "$W" sessions new >/dev/null 2>&1

echo "===== RAW stream for a bash-tool turn (unique sessionUpdate kinds first) ====="
OUT=$(timeout 150 acpx --agent "$A" --cwd "$W" --approve-all --format json \
  "Run the shell command: cat note.txt   — then tell me the file contents." 2>&1)
echo "--- distinct sessionUpdate kinds seen ---"
echo "$OUT" | grep -oE '"sessionUpdate":"[^"]*"' | sort | uniq -c
echo "--- any tool-ish records (pretty, first few) ---"
echo "$OUT" | grep -iE 'tool|command|execute|permission|kind' | head -20
echo "--- final result line ---"
echo "$OUT" | grep -E '"result"' | tail -1
echo
echo "===== also: does a tool_call carry a name+input we can key skill detection on? ====="
echo "$OUT" | grep -oE '"sessionUpdate":"tool[^"]*"[^}]*' | head -5
