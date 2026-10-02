#!/usr/bin/env bash
# Real-container probe (run INSIDE agentfoo-opencode): resolve every VERIFY-CLI
# unknown in src/agent/opencode.ts + dockers/opencode.Dockerfile in ONE session,
# so the adapter can be rewritten against captured output instead of guesses
# (TODO §3 / §5 / PLAN.5). This mirrors how the hermes/acpx adapter was fixed:
# capture first, then rewrite the parser against the capture.
#
# Answers:
#   [1] the real `run` CLI surface — flags, non-interactive mode, approval flag
#   [2] can opencode reach DeepSeek (custom openai-compatible provider + baseURL),
#       and is renderOpencodeConfig's schema right
#   [3] the `--format json` envelope → input for parseOpencodePartTrace
#   [4] session continuation: `--session <id>` vs `-c`, and the real id JSON key
#   [5] WHERE opencode reads skills from (agentfoo copies to $XDG_CONFIG_HOME/skills)
#   [6] what a skill firing looks like in the trace (expected: a real `skill` tool
#       call — the one agent where the built-in §11 heuristic should just work)
#
# Needs DEEPSEEK_API_KEY. Costs a handful of short model turns.
set -uo pipefail

MODEL="${DEEPSEEK_MODEL:-deepseek-v4-pro}"
PROVIDER="${DEEPSEEK_PROVIDER:-deepseek}"
BASE_URL="${DEEPSEEK_BASE_URL:-https://api.deepseek.com}"

# Mirror the container layout agentfoo actually uses (src/runtime/docker.ts):
# XDG_CONFIG_HOME=/tmp/agenthome, skills copied to /tmp/agenthome/skills,
# workspace /workspace. Probing anywhere else would answer the wrong question.
export XDG_CONFIG_HOME=/tmp/agenthome
W=/workspace
OUT=/tmp/probe-opencode
mkdir -p "$XDG_CONFIG_HOME" "$W" "$OUT"
cd "$W" || exit 1

hr() { echo; echo "===== $* ====="; }

hr "[0] versions / layout"
echo "opencode: $(opencode --version 2>&1 | head -1)"
echo "node:     $(node --version 2>&1)"
echo "XDG_CONFIG_HOME=$XDG_CONFIG_HOME  cwd=$(pwd)"
echo "model=$MODEL provider=$PROVIDER base_url=$BASE_URL"
echo "DEEPSEEK_API_KEY set: $([ -n "${DEEPSEEK_API_KEY:-}" ] && echo yes || echo NO)"

# ---------------------------------------------------------------- [1] CLI surface
# Free (no model call). This is what decides whether `opencode run "<prompt>"
# --model <p/m> --format json` in buildRunArgv is real, and whether there is an
# approval/non-interactive flag agentfoo must pass (hermes needed --approve-all).
hr "[1a] opencode --help"
timeout 60 opencode --help 2>&1 | head -60
hr "[1b] opencode run --help"
timeout 60 opencode run --help 2>&1 | head -60
hr "[1c] subcommands mentioning session / auth / models / skill"
timeout 60 opencode --help 2>&1 | grep -iE 'session|auth|model|skill|serve|agent' | head -20

# ------------------------------------------------------------ [2] provider config
# Exactly the document renderOpencodeConfig() emits today (src/agent/opencode.ts).
# If opencode rejects it, this file is the thing to fix.
hr "[2] write opencode.json (renderOpencodeConfig shape) and see if the model resolves"
mkdir -p "$XDG_CONFIG_HOME/opencode"
cat > "$XDG_CONFIG_HOME/opencode/opencode.json" <<JSON
{
  "\$schema": "https://opencode.ai/config.json",
  "provider": {
    "$PROVIDER": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "$BASE_URL",
        "apiKey": "{env:DEEPSEEK_API_KEY}"
      },
      "models": { "$MODEL": {} }
    }
  }
}
JSON
echo "--- written config ---"; cat "$XDG_CONFIG_HOME/opencode/opencode.json"
echo "--- does opencode list our provider/model? (command may not exist) ---"
timeout 60 opencode models 2>&1 | grep -iE "$PROVIDER|$MODEL" | head -10
echo "models-exit=$?"

# ------------------------------------------------------- [3] first turn + envelope
# THE artifact: full stdout of one turn, unfiltered. parseOpencodePartTrace gets
# rewritten against this, so do NOT truncate it.
hr "[3] turn one — full --format json envelope (captured verbatim)"
timeout 180 opencode run "Reply with exactly one word: ALPHA" \
  --model "$PROVIDER/$MODEL" --format json >"$OUT/turn1.json" 2>"$OUT/turn1.err"
echo "t1-exit=$?"
echo "--- stderr (tail) ---"; tail -20 "$OUT/turn1.err"
echo "--- stdout bytes: $(wc -c <"$OUT/turn1.json") ---"
echo "--- stdout VERBATIM (this is the parser input) ---"
cat "$OUT/turn1.json"

# ------------------------------------------------------- [4] session continuation
# extractOpencodeSessionId() guesses three shapes; find out which (if any) is real.
hr "[4a] session-id shaped keys present in turn1 stdout"
grep -oE '"[a-zA-Z_]*[sS]ession[a-zA-Z_]*"[[:space:]]*:[[:space:]]*("[^"]*"|\{)' \
  "$OUT/turn1.json" | sort -u | head -20

SID="$(grep -oE '"session(_?[iI][dD]|ID)"[[:space:]]*:[[:space:]]*"[^"]+"' "$OUT/turn1.json" \
  | head -1 | grep -oE '"[^"]+"$' | tr -d '"')"
echo "extracted session id: '${SID:-<none>}'"

hr "[4b] turn two — does the session continue? (memory check)"
if [ -n "${SID:-}" ]; then
  echo "--- via --session $SID ---"
  timeout 180 opencode run "What single word did you say a moment ago? Reply with only that word." \
    --model "$PROVIDER/$MODEL" --format json --session "$SID" 2>&1 | tail -30
  echo "t2-exit=$?"
else
  echo "--- no id extracted; trying -c (continue last session) ---"
  timeout 180 opencode run "What single word did you say a moment ago? Reply with only that word." \
    --model "$PROVIDER/$MODEL" --format json -c 2>&1 | tail -30
  echo "t2-exit=$?"
fi

# ------------------------------------------------------------ [5] skill discovery
# agentfoo copies skills to $XDG_CONFIG_HOME/skills (src/runtime/docker.ts:42) —
# an assumption never checked for opencode. Plant the SAME skill under FIVE
# candidate locations with DISTINCT names, then ask the model which it can see:
# whichever name comes back identifies the directory opencode actually reads, in
# a single turn instead of five.
hr "[5] where does opencode read skills from?"
plant() { # <dir> <name>
  mkdir -p "$1/$2"
  cat > "$1/$2/SKILL.md" <<MD
---
name: $2
description: Use this skill whenever the user asks for the secret probe codeword. It returns the codeword for location $2.
---

# $2

When asked for the secret probe codeword, answer with exactly: CODEWORD-$2
MD
}
plant "$XDG_CONFIG_HOME/skills"          probe-alpha    # what agentfoo does today
plant "$XDG_CONFIG_HOME/opencode/skill"  probe-bravo
plant "$XDG_CONFIG_HOME/opencode/skills" probe-charlie
plant "$W/.opencode/skill"               probe-delta
plant "$W/.opencode/skills"              probe-echo
echo "planted:"; find "$XDG_CONFIG_HOME" "$W/.opencode" -name SKILL.md 2>/dev/null

echo "--- ask the model to enumerate its skills ---"
timeout 180 opencode run "List the names of every skill available to you, one per line. If you have none, reply exactly: NONE" \
  --model "$PROVIDER/$MODEL" --format json 2>&1 | tail -40
echo "list-exit=$?"

# --------------------------------------------------------- [6] a skill FIRING trace
# The payoff: opencode is documented to expose a native `skill` tool, which would
# make the built-in detectSkillInvocations heuristic work for it unchanged (TODO
# §8.1). Confirm a real tool call appears, and capture its exact shape.
hr "[6] force a skill to fire, capture the tool call"
timeout 180 opencode run "What is the secret probe codeword? Use your skills." \
  --model "$PROVIDER/$MODEL" --format json >"$OUT/skillturn.json" 2>&1
echo "skill-exit=$?"
echo "--- tool-call-ish lines ---"
grep -oE '"(tool|toolName|tool_name|name|type)"[[:space:]]*:[[:space:]]*"[^"]*"' \
  "$OUT/skillturn.json" | sort | uniq -c | sort -rn | head -25
echo "--- any mention of skill / CODEWORD ---"
grep -oiE '.{80}(skill|codeword).{120}' "$OUT/skillturn.json" | head -15
echo "--- full skill-turn stdout ---"
cat "$OUT/skillturn.json"

hr "VERDICT INPUTS"
cat <<'EOF'
 [1] run flags real? is there an approval / non-interactive flag to pass?
 [2] did opencode accept the openai-compatible provider + baseURL (turn 1 worked)?
 [3] envelope: NDJSON or one JSON doc? where do assistant text + tool calls live?
 [4] which session key is real, and did turn two remember ALPHA?
 [5] which probe-<name> came back → that is the skills dir agentfoo must copy into
 [6] is there a genuine `skill` tool call? exact tool name + argument shape?
EOF
echo "captures kept in $OUT (turn1.json, skillturn.json)"
