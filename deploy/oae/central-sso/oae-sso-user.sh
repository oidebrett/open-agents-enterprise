#!/usr/bin/env bash
# Create (or look up) a person in an OAE realm on the central Keycloak and print the command that
# gives them an OAE account on the installation. Idempotent; never changes an existing password.
#
#   oae-sso-user.sh <realm> <email> [first-name] [last-name]
#
# A new person gets a one-time password that Keycloak makes them change at first sign-in; it is
# printed once, for you to pass on through your own secure channel. Their Keycloak user ID is the
# OIDC subject OAE attaches to their account.
set -euo pipefail

REALM=${1:?usage: oae-sso-user.sh <realm> <email> [first-name] [last-name]}
EMAIL=$(tr '[:upper:]' '[:lower:]' <<<"${2:?usage: oae-sso-user.sh <realm> <email> [first-name] [last-name]}")
FIRST=${3:-${EMAIL%%@*}}
LAST=${4:-.}
[[ $EMAIL =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || { echo "not an email address: $EMAIL" >&2; exit 2; }

# shellcheck disable=SC1090
. "${OAE_SSO_ENV:-$HOME/.config/oae-sso/keycloak.env}"
CONTAINER=${OAE_SSO_CONTAINER:-oae-sso-keycloak-1}
kc() { docker exec -i "$CONTAINER" /opt/keycloak/bin/kcadm.sh "$@"; }
kc config credentials --server http://localhost:8080 --realm master \
  --user "$OAE_SSO_ADMIN_USER" --password "$OAE_SSO_ADMIN_PASSWORD" >/dev/null
kc get "realms/$REALM" >/dev/null 2>&1 || { echo "no realm $REALM (create it with oae-realm.sh)" >&2; exit 1; }

user_id() { kc get users -r "$REALM" -q "email=$EMAIL" -q exact=true --fields id --format csv --noquotes | head -1; }
SUB=$(user_id)
if [ -z "$SUB" ]; then
  kc create users -r "$REALM" -s "username=$EMAIL" -s "email=$EMAIL" -s emailVerified=true \
    -s "firstName=$FIRST" -s "lastName=$LAST" -s enabled=true >/dev/null
  PW=$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-16)
  kc set-password -r "$REALM" --username "$EMAIL" --new-password "$PW" --temporary
  SUB=$(user_id)
  echo "Created $EMAIL in realm $REALM. One-time password (must be changed at first sign-in): $PW"
else
  echo "$EMAIL already exists in realm $REALM."
fi
echo "Keycloak user ID (OIDC subject): $SUB"
echo
echo "On the OAE server, as root:"
echo "  oae-user add $EMAIL $SUB"
echo "  oae-user grant $EMAIL <agent> [user|operator]"
