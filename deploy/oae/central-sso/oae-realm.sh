#!/usr/bin/env bash
# Create (or check) a Keycloak realm and the confidential OIDC clients of one OAE installation
# (oae-console: OAE sign-in; oae-edge: the human ingress), configured as
# docs/guides/deploy/oidc-keycloak.md requires, and the edge's directory client (oae-edge-directory:
# client credentials only, realm-management view-users, for the console's People panel to find a
# person by email), and the Claude Gateway client manager (oae-claude-clients: client credentials
# only, may manage clients and read users; oae-claude-sync makes one sign-in client per Claude
# Gateway Agent with it) with the `groups` scope those clients offer. Idempotent.
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

# ensure_client CLIENT_ID REDIRECT_URI OUT_FILE: one confidential client, configured as
# oidc-keycloak.md requires, its credentials written to OUT_FILE (mode 600).
ensure_client() {
  local client=$1 redirect=$2 out=$3 cid secret
  cid=$(kc get clients -r "$REALM" -q "clientId=$client" --fields id --format csv --noquotes | head -1)
  if [ -z "$cid" ]; then
    kc create clients -r "$REALM" -s "clientId=$client" -s protocol=openid-connect -s enabled=true \
      -s publicClient=false -s clientAuthenticatorType=client-secret -s standardFlowEnabled=true >/dev/null
    cid=$(kc get clients -r "$REALM" -q "clientId=$client" --fields id --format csv --noquotes | head -1)
    echo "client $client created"
  fi
  # Applied on every run: Keycloak 26.7 ignores some of these on create (backchannel logout stays on).
  kc update "clients/$cid" -r "$REALM" \
    -s "redirectUris=[\"$redirect\"]" -s 'webOrigins=[]' \
    -s frontchannelLogout=false -s directAccessGrantsEnabled=false -s implicitFlowEnabled=false \
    -s serviceAccountsEnabled=false \
    -s 'attributes."pkce.code.challenge.method"=S256' \
    -s 'attributes."backchannel.logout.session.required"=false' \
    -s 'attributes."backchannel.logout.url"=' \
    -s 'attributes."standard.token.exchange.enabled"=false' \
    -s 'attributes."oauth2.device.authorization.grant.enabled"=false' \
    -s 'attributes."oidc.ciba.grant.enabled"=false' \
    -s 'attributes."id.token.signed.response.alg"=RS256'
  secret=$(kc get "clients/$cid/client-secret" -r "$REALM" | sed -nE 's/.*"value" *: *"([^"]+)".*/\1/p')
  [ -n "$secret" ] || { echo "could not read the $client secret" >&2; exit 1; }
  printf '{"realm":"%s","clientId":"%s","clientSecret":"%s","issuer":"%s"}\n' \
    "$REALM" "$client" "$secret" "$ISSUER" > "$out"
  echo "client:  $client (secret in $out)"
}

# ensure_directory_client OUT_FILE: a confidential client that signs nobody in and can only read
# the realm's users (the People panel's email lookup), its credentials written to OUT_FILE.
ensure_directory_client() {
  local client=oae-edge-directory out=$1 cid secret
  cid=$(kc get clients -r "$REALM" -q "clientId=$client" --fields id --format csv --noquotes | head -1)
  if [ -z "$cid" ]; then
    kc create clients -r "$REALM" -s "clientId=$client" -s protocol=openid-connect -s enabled=true \
      -s publicClient=false -s clientAuthenticatorType=client-secret >/dev/null
    cid=$(kc get clients -r "$REALM" -q "clientId=$client" --fields id --format csv --noquotes | head -1)
    echo "client $client created"
  fi
  kc update "clients/$cid" -r "$REALM" \
    -s standardFlowEnabled=false -s implicitFlowEnabled=false -s directAccessGrantsEnabled=false \
    -s serviceAccountsEnabled=true -s 'redirectUris=[]' -s 'webOrigins=[]' \
    -s 'attributes."standard.token.exchange.enabled"=false' \
    -s 'attributes."oauth2.device.authorization.grant.enabled"=false' \
    -s 'attributes."oidc.ciba.grant.enabled"=false'
  kc add-roles -r "$REALM" --uusername "service-account-$client" --cclientid realm-management --rolename view-users
  secret=$(kc get "clients/$cid/client-secret" -r "$REALM" | sed -nE 's/.*"value" *: *"([^"]+)".*/\1/p')
  [ -n "$secret" ] || { echo "could not read the $client secret" >&2; exit 1; }
  printf '{"realm":"%s","clientId":"%s","clientSecret":"%s","issuer":"%s"}\n' \
    "$REALM" "$client" "$secret" "$ISSUER" > "$out"
  echo "client:  $client (directory lookups; secret in $out)"
}

# ensure_groups_scope: an optional `groups` client scope (group names, no paths), which the Claude
# Gateway's model policies match.
ensure_groups_scope() {
  local sid
  sid=$(kc get client-scopes -r "$REALM" --fields id,name --format csv --noquotes | awk -F, '$2=="groups"{print $1}')
  [ -n "$sid" ] && return 0
  kc create client-scopes -r "$REALM" -s name=groups -s protocol=openid-connect \
    -s 'attributes."include.in.token.scope"=true' >/dev/null
  sid=$(kc get client-scopes -r "$REALM" --fields id,name --format csv --noquotes | awk -F, '$2=="groups"{print $1}')
  kc create "client-scopes/$sid/protocol-mappers/models" -r "$REALM" -s name=groups \
    -s protocol=openid-connect -s protocolMapper=oidc-group-membership-mapper \
    -s 'config."claim.name"=groups' -s 'config."full.path"=false' -s 'config."id.token.claim"=true' \
    -s 'config."access.token.claim"=true' -s 'config."userinfo.token.claim"=true' >/dev/null
  echo "client scope groups created"
}

# ensure_claude_client_manager OUT_FILE: a confidential client that signs nobody in; it may create
# and delete clients (one per Claude Gateway Agent) and read users (their email domains).
ensure_claude_client_manager() {
  local client=oae-claude-clients out=$1 cid secret
  cid=$(kc get clients -r "$REALM" -q "clientId=$client" --fields id --format csv --noquotes | head -1)
  if [ -z "$cid" ]; then
    kc create clients -r "$REALM" -s "clientId=$client" -s protocol=openid-connect -s enabled=true \
      -s publicClient=false -s clientAuthenticatorType=client-secret >/dev/null
    cid=$(kc get clients -r "$REALM" -q "clientId=$client" --fields id --format csv --noquotes | head -1)
    echo "client $client created"
  fi
  kc update "clients/$cid" -r "$REALM" \
    -s standardFlowEnabled=false -s implicitFlowEnabled=false -s directAccessGrantsEnabled=false \
    -s serviceAccountsEnabled=true -s 'redirectUris=[]' -s 'webOrigins=[]' \
    -s 'attributes."standard.token.exchange.enabled"=false' \
    -s 'attributes."oauth2.device.authorization.grant.enabled"=false' \
    -s 'attributes."oidc.ciba.grant.enabled"=false'
  kc add-roles -r "$REALM" --uusername "service-account-$client" --cclientid realm-management \
    --rolename manage-clients --rolename view-clients --rolename view-users --rolename query-users
  secret=$(kc get "clients/$cid/client-secret" -r "$REALM" | sed -nE 's/.*"value" *: *"([^"]+)".*/\1/p')
  [ -n "$secret" ] || { echo "could not read the $client secret" >&2; exit 1; }
  printf '{"realm":"%s","clientId":"%s","clientSecret":"%s","issuer":"%s"}\n' \
    "$REALM" "$client" "$secret" "$ISSUER" > "$out"
  echo "client:  $client (Claude Gateway sign-in clients; secret in $out)"
}

ISSUER="$OAE_SSO_PUBLIC_URL/realms/$REALM"
umask 077
mkdir -p "$HOME/.config/oae-sso"
# OAE's own sign-in (OCE OIDC) and the human ingress (oae-edge, docs/oae/edge-design.md).
ensure_client oae-console "$OAE/api/auth/providers/oidc/callback" "$HOME/.config/oae-sso/$REALM-client.json"
ensure_client oae-edge "https://auth.agents.${OAE#https://}/callback" "$HOME/.config/oae-sso/$REALM-edge-client.json"
ensure_directory_client "$HOME/.config/oae-sso/$REALM-directory-client.json"
# Claude Gateway Agents (docs/oae/claude-gateway.md).
ensure_groups_scope
ensure_claude_client_manager "$HOME/.config/oae-sso/$REALM-claude-client.json"
echo "issuer:  $ISSUER"
