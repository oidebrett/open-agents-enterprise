# The built-in VPN (IKEv2) server for Claude Gateway Agents (docs/oae/claude-gateway.md): strongSwan
# with EAP-MSCHAPv2, the method the macOS and Windows built-in VPN clients use. oae-claude-sync
# writes /etc/swanctl and the gateways' addresses; this image only starts the daemon.
FROM alpine@sha256:49340b346798875b5592e5d420241f2f9cfba5f47e62ebb1446a1b34734e898f
RUN apk add --no-cache strongswan=5.9.14-r1 iproute2=6.15.0-r0
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
