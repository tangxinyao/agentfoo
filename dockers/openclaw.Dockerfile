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
# Unlike hermes and pi, `openclaw acp` is only a *bridge*: it forwards over a
# WebSocket to a long-running OpenClaw **Gateway** daemon on 127.0.0.1:18789,
# which this image does NOT start — src/agent/openclaw.ts launches it during
# agent init and waits for the port. A bare `docker run` of this image therefore
# gets you the binaries, not a ready agent. Budget ~600MB RSS for that daemon:
# on a small host it is the first thing the OOM killer takes, and the failure
# surfaces mid-run as `Gateway disconnected: 1006`.
#
# Versions below are verified against real runs (openclaw 2026.7.1-2 + acpx
# 0.12.1); see src/agent/openclaw.ts for the matching config/CLI surface.

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
#
# Pinned, and pinning is load-bearing rather than hygiene: the image tag is
# sha256(Dockerfile bytes), so a floating `latest` leaves the file — and the tag
# — unchanged as upstream moves, and the stale cached image gets reused forever
# with no signal (TODO §4). That exact bug bit hermes: 0.12.1 is the first
# release where `--agent <cmd> sessions new` works (§VI.2), and the cached image
# silently held 0.12.0. 0.12.1 is also the version §VI.4 probed green.
ARG ACPX_VERSION=0.12.1
RUN npm install -g acpx@${ACPX_VERSION} \
    && acpx --version

# OpenClaw, installed the official way (npm global). https://docs.openclaw.ai/install
# (the docs also offer a curl installer that bootstraps its own Node; we use the
# npm package on a pinned Node base so the image tags deterministically by hash).
# Pinned for the same reason as ACPX_VERSION above; 2026.7.1-2 is npm `latest`
# as of 2026-07-26 (published 2026-07-18).
ARG OPENCLAW_VERSION=2026.7.1-2
RUN npm install -g openclaw@${OPENCLAW_VERSION} \
    && openclaw --version

# openclaw reads its config (openclaw.json) and discovers "managed" skills under
# this dir (default ~/.openclaw). agentfoo overrides it per exec to the isolated
# agent home; the default here keeps a bare `docker run` of this image consistent
# with what the suite does.
ENV OPENCLAW_STATE_DIR=/tmp/agenthome
