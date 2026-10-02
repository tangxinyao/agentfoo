# Reference test image for running agentfoo skill tests against hermes-agent.
#
# Installed the OFFICIAL way: hermes' own scripts/install.sh, the same entry
# point Nous documents (`curl -fsSL .../install.sh | bash`).
#
# WHAT THE INSTALLER BOOTSTRAPS ITSELF (read from install.sh, 2026-07-25) — so we
# deliberately do NOT pre-provision any of it:
#   - uv, from https://astral.sh/uv/install.sh.
#   - Python: `check_python` runs `uv python find 3.11`, else
#     `uv python install 3.11`. uv owns the interpreter end to end. Under the root
#     FHS layout it lands in /usr/local/share/uv/python (world-readable).
#   - Node: `install_node` downloads Node 22 LTS and symlinks node/npm/npx from
#     $HERMES_HOME/node/bin into /usr/local/bin (install.sh:926-928).
#
# WHAT IT DOES *NOT* PROVIDE: **acpx**. There is no acpx anywhere in install.sh.
# agentfoo drives hermes through `acpx --agent 'hermes acp'` (TODO §VI.4), so
# acpx must be installed explicitly here — see the acpx layer below.
#
# Running as root on Linux the installer picks its FHS layout: code at
# /usr/local/lib/hermes-agent, command at /usr/local/bin/hermes (already on
# PATH).
#
# Skills are NOT baked in (--no-skills) — agentfoo copies them into the running
# container at test time. So this image is a stable "agent base": build it once,
# reuse it across every skill under test (that's why it lives in dockers/).
#
#   agents: { hermes: { dockerfile: '<repo>/dockers/hermes.Dockerfile', passEnv: ['DEEPSEEK_API_KEY'] } }

# Plain Ubuntu LTS — no language runtime in the base, because the installer
# provides its own (see above). Two reasons this specific tag:
#   - `detect_os` sets DISTRO from /etc/os-release ID → `ubuntu`, which is one of
#     install.sh's first-class apt branches (the tested path).
#   - 24.04 is exactly the newest release Playwright's platform resolver
#     recognizes (install.sh:2024). We pass --skip-browser so that code never
#     runs today, but staying at 24.04 means dropping that flag later can't
#     trigger the #35166 uninterruptible-hang path.
# Not pinning a language runtime also removes a trap the previous
# `python:3.11-slim` base had: it silently coupled this image to install.sh's
# PYTHON_VERSION, and would have become dead weight the moment hermes bumped it.
FROM ubuntu:24.04

# Pinned hermes-agent version. This is passed to the installer's `--branch`,
# which does `git clone --depth 1 --branch <ref>` — so a CalVer tag works as-is.
# Confirm/adjust against https://github.com/nousresearch/hermes-agent/tags
ARG HERMES_REF=v2026.7.7.2

# acpx is the ACP client agentfoo actually execs; hermes only supplies the
# `hermes acp` agent behind it. PINNED because the two are coupled: 0.12.1 is the
# first release where `--agent <cmd> sessions new` works (0.12.0 died with
# "Internal error"), which the cwd-scoped session model depends on (TODO §VI.2).
ARG ACPX_VERSION=0.12.1

# Only what install.sh cannot bootstrap for itself:
#   bash            - the script is #!/bin/bash and uses arrays + `&>`; the
#                     `| bash -s --` pipe below needs a real bash, not sh.
#                     (Present in the Ubuntu base; named here as an explicit
#                     contract rather than an assumption.)
#   curl, ca-certs  - fetches the uv installer, the Node index and tarball.
#   git             - clone_repo. (Root+apt would auto-provision it, but relying
#                     on that puts an apt-get inside the install step.)
#   xz-utils        - Node ships .tar.xz; without it the installer falls back to
#                     the slower .tar.gz path.
#   ripgrep         - hermes' file-search backend. Optional to the installer
#                     (it apt-installs it when missing), but providing it up
#                     front keeps the install step free of apt.
# Deliberately omitted: ffmpeg (TTS voice messages only — no skill test speaks).
# Python is NOT installed: uv manages it (see header).
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        bash git curl ca-certificates xz-utils ripgrep \
    && rm -rf /var/lib/apt/lists/*

# The installer puts its managed Node at $HERMES_HOME/node and symlinks
# /usr/local/bin/node -> $HERMES_HOME/node/bin/node. HERMES_HOME must therefore
# be a STABLE path, NOT the per-test home: agentfoo passes a fresh HERMES_HOME on
# every exec (`/tmp/agenthome`, src/runtime/docker.ts), and anchoring the Node
# install (a program) inside what is per-test mutable data — under /tmp, the most
# likely thing to be shadowed by a mount or tmpfs — would leave those symlinks
# dangling. Keep the toolchain here; the per-test HERMES_HOME is supplied at RUN
# time and only holds config + sessions.
ENV HERMES_HOME=/opt/hermes-home

# Official installer, headless flags:
#   --skip-setup      no interactive config wizard
#   --skip-browser    no Playwright/Chromium download. NOTE: this does NOT skip
#                     the repo's `npm install` (install.sh:2146) — there is no
#                     flag for that, so the Node dep install still runs.
#   --no-skills       blank slate; agentfoo copies skills in at test time
#   --non-interactive never block on a prompt
#   --branch          pin to HERMES_REF (tag)
# The installer script is fetched from that SAME tag, not from main. The main
# branch has since diverged (868 lines there vs 3133 here) and dropped
# --no-skills outright, which aborts the whole install and surfaces only as
# "curl: (23) Failure writing output to destination". Every install.sh:<line>
# reference above points at the tagged script this file was written against.
RUN curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/refs/tags/${HERMES_REF}/scripts/install.sh \
        | bash -s -- --skip-setup --skip-browser --no-skills --non-interactive --branch "${HERMES_REF}" \
    && hermes version

# acpx — NOT provided by install.sh, and the binary agentfoo actually execs.
# Must come AFTER the hermes install, which is what puts npm on PATH (the
# installer's managed Node).
#
# Self-check is `acpx --version` only. Deliberately NOT `hermes acp ...`: that
# subcommand starts a stdio ACP server and would block for stdin forever,
# hanging the build. Whether hermes+acpx actually handshake is a runtime
# question, covered by scripts/probe-hermes-acpx-cwd.sh.
RUN npm install -g "acpx@${ACPX_VERSION}" \
    && acpx --version
