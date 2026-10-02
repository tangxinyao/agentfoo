# Reference test image for running agentfoo skill tests against the Pi coding
# agent (https://github.com/mariozechner/pi), driven headlessly through the acpx
# ACP client: `acpx pi "<prompt>" --format json`.
#
# Pi is an ACP agent; acpx is the headless client agentfoo execs. This image
# bundles both. Skills are NOT baked in — agentfoo copies them into the running
# container at test time. Build once, reuse across every skill under test.
#
#   agents: { pi: { dockerfile: '<repo>/dockers/pi.Dockerfile', passEnv: ['MOONSHOT_API_KEY'] } }
#
# VERIFY-CLI: confirm the pinned versions against the upstream docs before live
# runs. See src/agent/acpx.ts for the matching CLI-surface assumptions.

# Node base: acpx requires Node 22.13+ (https://acpx.sh/install.html); Pi needs
# Node 18+ — so node:22-slim satisfies both.
FROM node:22-slim

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

# Pi coding agent, installed the official way (npm global).
# https://github.com/mariozechner/pi. acpx can auto-fetch npm adapters on first
# use, but we pre-install so the image runs offline-of-npm and deterministic.
#
# Package is @mariozechner/pi-coding-agent (verified 2026-07-25: v0.73.1,
# "Coding agent CLI with read, bash, edit, write tools and session management",
# bin `pi`). NOT @mariozechner/pi — that is pi-pods, an unrelated vLLM-on-GPU
# deployment tool (TODO §V.6).
ARG PI_VERSION=latest
RUN npm install -g @mariozechner/pi-coding-agent@${PI_VERSION} \
    && pi --version
