#!/bin/bash
# Claude Gateway: one-time laptop setup (macOS). Run from the folder with your hand-off files:
#   claude-gateway-ca.crt and <name>.conf (your WireGuard tunnel).
# Undo: see the end of this file.
set -e
GW=@@GATEWAY_HOST@@; KC=@@KEYCLOAK_HOST@@; ADDR=@@TUNNEL_IP@@
cd "$(dirname "$0")"

# 1. The gateway's names point at the tunnel address.
grep -q " $GW" /etc/hosts || echo "$ADDR $GW $KC" | sudo tee -a /etc/hosts >/dev/null

# 2. Trust the gateway's CA. It is name-constrained to the gateway's private domain, so it cannot
#    vouch for any other site. Claude Desktop reads only the System keychain.
sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain claude-gateway-ca.crt
mkdir -p ~/.claude-gateway && cp claude-gateway-ca.crt ~/.claude-gateway/ca.crt

# 3. Claude Code CLI (2.1.295 or later): sign in through the gateway.
mkdir -p ~/.claude
GW_URL="https://$GW:8443" python3 - <<'PY'
import json, os
p = os.path.expanduser("~/.claude/settings.json")
s = json.load(open(p)) if os.path.exists(p) else {}
s.update({"forceLoginMethod": "gateway", "forceLoginGatewayUrl": os.environ["GW_URL"]})
json.dump(s, open(p, "w"), indent=2)
PY
grep -q NODE_EXTRA_CA_CERTS ~/.zshrc 2>/dev/null || echo 'export NODE_EXTRA_CA_CERTS=$HOME/.claude-gateway/ca.crt' >> ~/.zshrc

cat <<EOF
Done. Next:
  1. WireGuard (Mac App Store) -> Import tunnel(s) from file -> pick your .conf -> Activate.
  2. Claude Code: open a new terminal, run claude, check the certificate fingerprint is
     @@FINGERPRINT@@
     then /login. /status shows "Cloud gateway".
  3. Claude Desktop: Help -> Troubleshooting -> Enable Developer Mode; then Developer ->
     Configure Third-Party Inference... -> Source -> Bootstrap config URL:
       https://$GW:8443/user/bootstrap
     Leave the OIDC fields empty. Save, then "Sign in with your organization".
EOF

# Undo: remove the hosts line; sudo security delete-certificate -c "Claude Gateway CA" \
#   /Library/Keychains/System.keychain; remove forceLoginMethod/forceLoginGatewayUrl from
#   ~/.claude/settings.json; clear Desktop's Source URL; delete the tunnel in WireGuard.
