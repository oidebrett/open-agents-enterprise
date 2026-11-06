# Central SSO (Keycloak) for OAE

One Keycloak serves sign-in for every OAE installation; each installation gets its own realm and
confidential client. This follows OCE's guidance that the organisation runs Keycloak separately
and OCE only configures a client ([`oidc-keycloak.md`](../../../docs/guides/deploy/oidc-keycloak.md)),
and it is the same code path as an enterprise customer's own provider (Entra ID, Okta, Auth0):
OAE only needs an issuer, four endpoint URLs and a client ID and secret.

| Piece | Where |
|---|---|
| Keycloak 26.7.5 (`start`, digest-pinned to OCE's CI version) + PostgreSQL 17 | `compose.yaml`, published on `127.0.0.1:9080` (HTTP) and `:9081` (health) |
| Secrets | `~/.config/oae-sso/keycloak.env` (mode 600; never in git) |
| Public name | `https://keycloak.mcpgateway.online`, a Pangolin resource on `mcpgateway.online` that targets `localhost:9080` on the site **Macbook** (newt) |
| Per-installation realm + client | `oae-realm.sh <realm> <oae-base-url>` |

## Run it

```bash
umask 077; mkdir -p ~/.config/oae-sso
cat > ~/.config/oae-sso/keycloak.env <<EOF
OAE_SSO_PUBLIC_URL=https://keycloak.mcpgateway.online
OAE_SSO_ADMIN_USER=admin
OAE_SSO_ADMIN_PASSWORD=$(openssl rand -hex 18)
OAE_SSO_DB_PASSWORD=$(openssl rand -hex 24)
EOF
docker compose --env-file ~/.config/oae-sso/keycloak.env up -d
curl -s http://127.0.0.1:9081/health/ready        # {"status":"UP"} after ~20 s
```

The tunnel: newt runs as the macOS LaunchAgent `online.mcpgateway.newt`
(`~/Library/LaunchAgents/online.mcpgateway.newt.plist`), which executes
`~/Projects/newt/run_newt.sh` (site credentials live only in that script). Logs:
`~/Library/Logs/newt-mcpgateway.log`. Stop or start it with
`launchctl bootout gui/$(id -u)/online.mcpgateway.newt` /
`launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/online.mcpgateway.newt.plist`.

Sign-in to every OAE installation that uses this Keycloak depends on this laptop being on, Docker
running and the tunnel up. Password sign-in for each installation's recovery administrator keeps
working when it is not. For anything beyond demos, move the same compose file to a small
dedicated server behind its own TLS proxy.

## Add an OAE installation

```bash
./oae-realm.sh oae-oracle https://oae.example.com
```

Then, on the OAE box, put the client ID and secret in the `occ-oidc-login` Secret, add
`controlPlane.oidc` (issuer, `authorizationUrl`, `tokenUrl`, `jwksUrl`) and
`controlPlane.recoveryUserId` to the installation profile, re-render and `helm upgrade`
([OIDC sign-in](../../../docs/guides/deploy/oidc-sign-in.md)). Enabling OIDC turns native admin off
and is one-way for the installation. People sign in with SSO only after an administrator creates
their OAE account and attaches their Keycloak user ID (the token's `sub`).

## Security notes

- The Keycloak admin console (`/admin`) is reachable on the public name. Use a long admin
  password; restricting `/admin` to trusted addresses in Pangolin is a follow-up.
- Keep the Pangolin resource without Pangolin SSO in front: OAE's API calls the token and JWKS
  endpoints directly and cannot pass an interactive login.
