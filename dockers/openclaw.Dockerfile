# Reference test image for running agentfoo skill tests against OpenClaw
# (https://docs.openclaw.ai), driven headlessly through the acpx ACP client:
# `acpx openclaw "<prompt>" --format json`.
#
# OpenClaw is an ACP agent; acpx is the headless client agentfoo execs. This
# image bundles both. Skills are NOT baked in — agentfoo copies them into the
# running container at test time. Build once, reuse across every skill under test.
#
#   agents: { openclaw: { dockerfile: '<repo>/dockers/openclaw.Dockerfile', passEnv: ['MOONSHOT_API_KEY'] } }
#
# VERIFY-CLI: confirm the pinned versions against the upstream docs before live
# runs. See src/agent/acpx.ts for the matching CLI-surface assumptions.

# Node base: OpenClaw requires Node 22.22.3+, 24.15+, or 25.9+ (Node 23 is
# unsupported), with Node 24 the recommended runtime
# (https://docs.openclaw.ai/install/node). acpx requires Node 22.13+ — node:24
# satisfies both.
FROM node:24-slim

# Prereqs: git (repo ops in the workspace), curl + ca-certificates (provider
# TLS), ripgrep (file-search backend).
RUN apt-get update && apt-get install -y --no-install-recommends \
        git curl ca-certificates ripgrep \
    && rm -rf /var/lib/apt/lists/*

# acpx home (config / saved sessions). agentfoo overrides ACPX_HOME per exec.
ENV ACPX_HOME=/tmp/agenthome

# The headless ACP client, installed the official way (npm global).
# https://acpx.sh/install.html
ARG ACPX_VERSION=latest
RUN npm install -g acpx@${ACPX_VERSION} \
    && acpx --version

# OpenClaw, installed the official way (npm global). https://docs.openclaw.ai/install
# (the docs also offer a curl installer that bootstraps its own Node; we use the
# npm package on a pinned Node base so the image tags deterministically by hash).
ARG OPENCLAW_VERSION=latest
RUN npm install -g openclaw@${OPENCLAW_VERSION} \
    && openclaw --version
