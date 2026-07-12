# Reference test image for running agentfoo skill tests against hermes-agent.
#
# This is a LEAN, headless build — just enough hermes to serve
# `hermes chat -q ... -Q` and `hermes sessions export`, which is all agentfoo's
# runtime execs. It deliberately skips the browser/Playwright and bundled-skill
# machinery (those exist for the TUI and web tools — none of which a headless
# skill test touches).
#
# Installed the OFFICIAL way: hermes' own scripts/install.sh, the same entry
# point Nous documents (`curl -fsSL .../install.sh | bash`). Running as root on
# Linux, the installer lays code down at /usr/local/lib/hermes-agent and links
# the command at /usr/local/bin/hermes (FHS layout, already on PATH). It
# bootstraps its own uv + managed Python, so we don't pre-provision a venv.
#
# The agent is PINNED and self-contained: the installer clones hermes at a fixed
# tag inside the build, so the image needs no source checkout and no build
# context. Bump HERMES_REF to move versions — because agentfoo tags the image by
# this Dockerfile's content hash, changing the ref changes the hash and triggers
# a rebuild (an unchanged ref reuses the cached image).
#
# Skills are NOT baked in (--no-skills) — agentfoo copies them into the running
# container at test time. So this image is a stable "agent base": build it once,
# reuse it across every skill under test (that's why it lives in dockers/).
#
#   agents: { hermes: { dockerfile: '<repo>/dockers/hermes.Dockerfile', passEnv: ['DEEPSEEK_API_KEY'] } }

FROM python:3.11-slim-bookworm

# Pinned hermes-agent version. This is passed to the installer's `--branch`,
# which does `git clone --depth 1 --branch <ref>` — so a CalVer tag works as-is.
# Confirm/adjust against https://github.com/nousresearch/hermes-agent/tags
ARG HERMES_REF=v2026.7.7.2

# Prereqs the installer expects on the host: git (clones hermes), curl +
# ca-certificates (bootstraps uv over TLS, fetches tarballs), xz-utils (uv
# unpacks its managed Python), ripgrep (hermes' file-search tool backend — the
# installer would otherwise apt-install it itself; we provide it up front so the
# install runs offline-of-apt and deterministic).
RUN apt-get update && apt-get install -y --no-install-recommends \
        git curl ca-certificates xz-utils ripgrep \
    && rm -rf /var/lib/apt/lists/*

# agentfoo writes the isolated hermes home (config.yaml, sessions) under here and
# passes HERMES_HOME explicitly on every exec; set it at build time too so any
# installer-seeded state lands in the same place.
ENV HERMES_HOME=/tmp/hermes

# Official installer, headless flags:
#   --skip-setup      no interactive config wizard
#   --skip-browser    no Playwright/Chromium (headless tests never drive a browser)
#   --no-skills       blank slate; agentfoo copies skills in at test time
#   --non-interactive never block on a prompt
#   --branch          pin to HERMES_REF (tag)
# Root install symlinks `hermes` into /usr/local/bin (already on PATH). No
# `--commit` — pin by tag; switch to --commit <sha> if you need exact bytes.
RUN curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh \
        | bash -s -- --skip-setup --skip-browser --no-skills --non-interactive --branch "${HERMES_REF}" \
    && hermes version
