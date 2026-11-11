# Claude Gateway image: Debian slim + the Claude Code binary that `claude-gateway install`
# downloaded and checksum-verified into ./bin (never committed, never published).
ARG DEBIAN_IMAGE
FROM ${DEBIAN_IMAGE}
RUN apt-get update -q && apt-get install -y -q --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd -M -u 10001 gateway
COPY bin/claude /usr/local/bin/claude
USER 10001
ENTRYPOINT ["claude", "gateway", "--config", "/etc/claude/gateway.yaml"]
