#!/usr/bin/env bash
# Create (or check) a Keycloak realm and the confidential OIDC client one OAE installation signs
# in with, configured as docs/guides/deploy/oidc-keycloak.md requires. Idempotent.
#
#   oae-realm.sh <realm> <oae-base-url>      e.g. oae-realm.sh oae-oracle https://oae.example.com
#
# Reads the Keycloak admin login from ~/.config/oae-sso/keycloak.env (see README.md) and writes
# the client's issuer, ID and secret to ~/.config/oae-sso/<realm>-client.json (mode 600).
set -euo pipefail

REALM=${1:?usage: oae-realm.sh <realm> <oae-base-url>}
OAE=${2:?usage: oae-realm.sh <realm> <oae-base-url>}
OAE=${OAE%/}
[[ $REALM =~ ^[a-z0-9][a-z0-9-]{1,40}$ ]] || { echo "realm: lowercase letters, digits, hyphens" >&2; exit 2; }
[[ $OAE =~ ^https://[a-z0-9.-]+$ ]] || { echo "oae-base-url: https://<host> with no path" >&2; exit 2; }

ENV_FILE=${OAE_SSO_ENV:-$HOME/.config/oae-sso/keycloak.env}
# shellcheck disable=SC1090
. "$ENV_FILE"
CONTAINER=${OAE_SSO_CONTAINER:-oae-sso-keycloak-1}
kc() { docker exec -i "$CONTAINER" /opt/keycloak/bin/kcadm.sh "$@"; }

kc config credentials --server http://localhost:8080 --realm master \
  --user "$OAE_SSO_ADMIN_USER" --password "$OAE_SSO_ADMIN_PASSWORD" >/dev/null

if ! kc get "realms/$REALM" >/dev/null 2>&1; then
  kc create realms -s "realm=$REALM" -s enabled=true -s "displayName=Open Agents Enterprise ($REALM)" >/dev/null
  echo "realm $REALM created"
fi

client_id() { kc get clients -r "$REALM" -q clientId=oae-console --fields id --format csv --noquotes | head -1; }
CID=$(client_id)
if [ -z "$CID" ]; then
  kc create clients -r "$REALM" -f - >/dev/null <<JSON
{
  "clientId": "oae-console",
  "name": "Open Agents Enterprise console",
  "protocol": "openid-connect",
  "enabled": true,
  "publicClient": false,
  "clientAuthenticatorType": "client-secret",
  "standardFlowEnabled": true,
  "directAccessGrantsEnabled": false,
  "implicitFlowEnabled": false,
  "serviceAccountsEnabled": false,
  "frontchannelLogout": false,
  "redirectUris": ["$OAE/api/auth/providers/oidc/callback"],
  "webOrigins": []
}
JSON
  CID=$(client_id)
  echo "client oae-console created"
fi

# Applied on every run: Keycloak 26.7 ignores some of these on create (backchannel logout stays on).
kc update "clients/$CID" -r "$REALM" \
  -s "redirectUris=[\"$OAE/api/auth/providers/oidc/callback\"]" -s 'webOrigins=[]' \
  -s frontchannelLogout=false -s directAccessGrantsEnabled=false -s implicitFlowEnabled=false \
  -s serviceAccountsEnabled=false \
  -s 'attributes."pkce.code.challenge.method"=S256' \
  -s 'attributes."backchannel.logout.session.required"=false' \
  -s 'attributes."backchannel.logout.url"=' \
  -s 'attributes."standard.token.exchange.enabled"=false' \
  -s 'attributes."oauth2.device.authorization.grant.enabled"=false' \
  -s 'attributes."oidc.ciba.grant.enabled"=false' \
  -s 'attributes."id.token.signed.response.alg"=RS256'

SECRET=$(kc get "clients/$CID/client-secret" -r "$REALM" | sed -nE 's/.*"value" *: *"([^"]+)".*/\1/p')
[ -n "$SECRET" ] || { echo "could not read the client secret" >&2; exit 1; }
ISSUER="$OAE_SSO_PUBLIC_URL/realms/$REALM"
umask 077
mkdir -p "$HOME/.config/oae-sso"
printf '{"realm":"%s","clientId":"oae-console","clientSecret":"%s","issuer":"%s"}\n' \
  "$REALM" "$SECRET" "$ISSUER" > "$HOME/.config/oae-sso/$REALM-client.json"
echo "issuer:  $ISSUER"
echo "client:  oae-console (secret in ~/.config/oae-sso/$REALM-client.json)"
