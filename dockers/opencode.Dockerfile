# Reference test image for running agentfoo skill tests against sst's opencode.
#
# Headless build: just enough opencode to serve `opencode run "<prompt>"
# --format json`, which is all agentfoo's runtime execs for this agent.
#
# Skills are NOT baked in — agentfoo copies them into the running container at
# test time. Build once, reuse across every skill under test.
#
#   agents: { opencode: { dockerfile: '<repo>/dockers/opencode.Dockerfile', passEnv: ['GLM_API_KEY'] } }
#
# VERIFY-CLI: confirm the install command and pinned version against the official
# opencode install docs (https://opencode.ai/docs) — the npm package name and
# installer entry point should be checked against a real environment.

FROM node:22-slim

# Prereqs: git (repo ops inside the workspace), curl + ca-certificates (installer
# / provider TLS), ripgrep (opencode's file-search backend).
RUN apt-get update && apt-get install -y --no-install-recommends \
        git curl ca-certificates ripgrep \
    && rm -rf /var/lib/apt/lists/*

# opencode reads its config from $XDG_CONFIG_HOME/opencode; agentfoo sets
# XDG_CONFIG_HOME per exec to an isolated home, so set a sane default here too.
ENV XDG_CONFIG_HOME=/tmp/agenthome

# Pinned opencode version. VERIFY-CLI: adjust the package/tag to match the
# current opencode release channel.
ARG OPENCODE_VERSION=latest
RUN npm install -g opencode-ai@${OPENCODE_VERSION} \
    && opencode --version
