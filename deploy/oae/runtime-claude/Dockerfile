# OAE runtime image: OCE's published Agent runtime plus a pinned Claude Code, for OpenClaw's
# `claude-cli` agent runtime (model-scoped agentRuntime.id "claude-cli"; docs/oae/claude-harness.md).
# Nothing else changes: same OpenClaw build, user, entrypoint and layout as the base.
ARG OCE_RUNTIME_IMAGE=ghcr.io/openclaw/openclaw-enterprise-runtime@sha256:6d0af87f6b2b803975cba47305bf69cd59aef69427290f0490da31f488855cb9
FROM ${OCE_RUNTIME_IMAGE}

# Pinned; released 2026-10-27. Bump deliberately, never "latest".
ARG CLAUDE_CODE_VERSION=2.1.312

USER root
RUN npm install --global --no-fund --no-audit "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    && npm cache clean --force \
    && claude --version
# The Agent's credential for Claude Code: OpenClaw removes it from the environment when it starts
# `claude`, so `claude` is a wrapper that passes it on (an API key, or a Claude subscription setup
# token for a personal Agent). docs/oae/claude-harness.md
COPY claude-wrapper /tmp/oae-claude/
RUN rm -f /usr/local/bin/claude && install -m 0755 /tmp/oae-claude/claude-wrapper /usr/local/bin/claude \
    && rm -rf /tmp/oae-claude \
    && claude --version
USER node

# No self-update in an immutable image; no telemetry, error reporting or other non-essential
# traffic (the Agent's egress allows the Anthropic API only).
ENV DISABLE_AUTOUPDATER=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    DISABLE_TELEMETRY=1 \
    DISABLE_ERROR_REPORTING=1
