# Reference test image for running agentfoo skill tests against opencode
# (https://github.com/anomalyco/opencode).
#
# Headless build: just enough opencode to serve `opencode run "<prompt>"
# --format json`, which is all agentfoo's runtime execs for this agent.
#
# Skills are NOT baked in — agentfoo copies them into the running container at
# test time. Build once, reuse across every skill under test.
#
#   agents: { opencode: { dockerfile: '<repo>/dockers/opencode.Dockerfile', passEnv: ['DEEPSEEK_API_KEY'] } }
#
# VERIFIED 2026-07-26 against the real 1.18.5 linux-x64 binary + the official
# installer (raw.githubusercontent.com/anomalyco/opencode/dev/install), by
# downloading and running it on the host — see TODO §3.

# No language runtime: opencode ships as a single precompiled executable, and
# `ldd` on the 1.18.5 binary lists only libc / libm / libpthread / libdl (max
# symbol version GLIBC_2.17, far below 24.04's 2.39). The previous node:22-slim
# base was dead weight — the npm package `opencode-ai` is itself only a shim
# whose postinstall downloads this same binary, so node was needed at *install*
# time and never at runtime. ubuntu:24.04 also matches hermes.Dockerfile.
FROM ubuntu:24.04

# Prereqs. ripgrep is NOT optional here: opencode's file-search resolves `rg` as
# (1) one on PATH, (2) a cached copy in its own bin dir, else (3) *downloads*
# ripgrep 15.1.0 from github.com/BurntSushi/ripgrep at first search. An apt rg on
# PATH short-circuits that, keeping test turns off the network. curl + tar are
# needed by the install step below, git for repo ops inside the workspace.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl tar git ripgrep \
    && rm -rf /var/lib/apt/lists/*

# opencode reads its config from $XDG_CONFIG_HOME/opencode; agentfoo sets
# XDG_CONFIG_HOME per exec to an isolated home, so set a sane default here too.
ENV XDG_CONFIG_HOME=/tmp/agenthome

# Standalone release binary, pinned. Pinning is load-bearing, not hygiene: the
# image tag is sha256(Dockerfile bytes), so a floating `latest` would leave the
# file — and therefore the tag — unchanged as upstream moves, and the stale
# cached image would be reused forever with no signal (TODO §4).
ARG OPENCODE_VERSION=1.18.5

# Asset selection mirrors the official installer's own logic: `-musl` is for
# Alpine (not us, glibc base), and `-baseline` is the no-AVX2 build. The AVX2
# probe reads the *build* host's /proc/cpuinfo, which is the same machine that
# runs the container in agentfoo's model; it costs one grep and rules out a
# SIGILL on pre-2013 x86. arm64 has no baseline variant.
RUN set -eux; \
    case "$(uname -m)" in \
      x86_64) target=linux-x64; grep -qw avx2 /proc/cpuinfo || target=linux-x64-baseline ;; \
      aarch64|arm64) target=linux-arm64 ;; \
      *) echo "unsupported arch: $(uname -m)" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/opencode.tar.gz \
      "https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/opencode-${target}.tar.gz"; \
    tar -xzf /tmp/opencode.tar.gz -C /usr/local/bin opencode; \
    rm /tmp/opencode.tar.gz; \
    chmod 755 /usr/local/bin/opencode; \
    opencode --version
