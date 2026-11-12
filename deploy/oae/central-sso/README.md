# Keycloak for OAE: install it and connect an OAE deployment

OAE's single sign-on is OCE's own OIDC sign-in pointed at a **Keycloak realm**. One Keycloak can
serve many OAE deployments: each gets its own realm with three clients. Keycloak can in turn hand
sign-in to your company's identity provider (Microsoft Entra ID, Google, Okta), so OAE never needs
to know about it.

What you end up with, per OAE deployment:

| In Keycloak                                                 | Used by OAE for                                                 |
| ----------------------------------------------------------- | --------------------------------------------------------------- |
| A **realm** (for example `acme`)                            | Its issuer URL: `https://<keycloak host>/realms/acme`           |
| Client **`oae-console`** (confidential)                     | People signing in to the OAE console                            |
| Client **`oae-edge`** (confidential)                        | People opening their Agents, `/apps`, phones and Hermes Desktop |
| Client **`oae-edge-directory`** (optional, service account) | The console's People card finding people by email (read-only)   |
| Client **`oae-claude-clients`** (optional, service account) | Claude Gateway Agents: one sign-in client per gateway           |
| Client scope **`groups`**                                   | Group names in Claude Gateway tokens (model policy per group)   |
| **Users** (or a brokered Entra ID)                          | The people who sign in                                          |

## 1. Install Keycloak

Keycloak needs a machine with Docker and a **public HTTPS name** (for example
`keycloak.example.com`) that both people's browsers and the OAE servers can reach.

Publish it **without a login page in front of it** (no proxy authentication such as Pangolin's
resource login): the OAE servers call `/realms/*` and the Claude Gateway sync calls
`/admin/realms/*` themselves, and a redirect to another login breaks sign-in and Claude Gateways
(tested 2026-11-12). Keycloak's own admin login protects its admin console; if you want more,
restrict only `/admin/master` and the admin console path, never `/realms/*`.

1. Copy this directory (`compose.yaml`) to the machine.
2. Create the secrets file (never in git):

   ```bash
   umask 077; mkdir -p ~/.config/oae-sso
   cat > ~/.config/oae-sso/keycloak.env <<EOF
   OAE_SSO_PUBLIC_URL=https://keycloak.example.com
   OAE_SSO_ADMIN_USER=admin
   OAE_SSO_ADMIN_PASSWORD=$(openssl rand -hex 18)
   OAE_SSO_DB_PASSWORD=$(openssl rand -hex 24)
   EOF
   ```

3. Start Keycloak 26.7.5 (digest-pinned, OCE's CI version) and PostgreSQL 17:

   ```bash
   docker compose --env-file ~/.config/oae-sso/keycloak.env up -d
   curl -s http://127.0.0.1:9081/health/ready     # {"status":"UP"} after ~20 s
   ```

   Keycloak listens on `127.0.0.1:9080` (HTTP) only.

4. **Publish it over HTTPS**: point your reverse proxy (Caddy, Traefik, nginx, a Pangolin
   resource, …) at `http://127.0.0.1:9080` for the public name, with a valid certificate. Do **not**
   put another login in front of it: OAE's servers call its token and key endpoints directly.
5. Sign in to `https://keycloak.example.com/admin/` as `admin` with the password from the file
   (`grep OAE_SSO_ADMIN_PASSWORD ~/.config/oae-sso/keycloak.env`). Keep this password long and
   private; consider restricting `/admin` to trusted addresses at the proxy.

Our own demo Keycloak runs this way on a laptop, published as `https://keycloak.mcpgateway.online`
through a Pangolin tunnel (newt LaunchAgent `online.mcpgateway.newt`). Sign-in then depends on the
laptop being on; use a small always-on server for anything real.

## 2. Create the realm and clients

You need the OAE console address first. With manidae-cloud it is
`https://<server name>.<managed domain>`; choose the **Server Name** in the deploy form now and use
the same name below.

### Option A: the script (on the Keycloak machine)

```bash
./oae-realm.sh acme https://acme-agents.example.com
```

It creates realm `acme` and the three clients with exactly the settings OCE requires, and writes
each one's issuer, client ID and secret to `~/.config/oae-sso/acme-client.json`,
`acme-edge-client.json`, `acme-directory-client.json` and `acme-claude-client.json` (mode 600). Read them with
`jq . ~/.config/oae-sso/acme-*.json`. It is safe to run again.

### Option B: by hand in the Keycloak admin console

1. **Realm**: top-left realm menu → _Create realm_ → name `acme` → _Create_.
2. **Console client**: _Clients → Create client_:
   - Client ID `oae-console` → _Next_.
   - _Client authentication_ **On**; _Authentication flow_: only **Standard flow** → _Next_.
   - _Valid redirect URIs_: `https://acme-agents.example.com/api/auth/providers/oidc/callback`;
     _Web origins_: `https://acme-agents.example.com` → _Save_.
   - _Advanced_ tab → _Proof Key for Code Exchange Code Challenge Method_: **S256**;
     _ID token signature algorithm_: **RS256** → _Save_.
   - _Credentials_ tab → copy the **Client secret**.
3. **Edge client**: the same as step 2 with Client ID `oae-edge`, redirect URI
   `https://auth.agents.acme-agents.example.com/callback` and web origin
   `https://auth.agents.acme-agents.example.com`.
4. **Directory client** (optional, for the People card's email lookup):
   - _Create client_ → Client ID `oae-edge-directory` → _Client authentication_ **On**;
     _Authentication flow_: only **Service accounts roles** (no standard flow) → _Save_.
   - _Service accounts roles_ tab → _Assign role_ → filter by clients →
     `realm-management` **view-users** → _Assign_. Nothing else: it can only read users.
   - _Credentials_ tab → copy the **Client secret**.
5. **Claude Gateway client manager** (optional, for Claude Gateway Agents):
   - _Client scopes → Create client scope_: name `groups`, type **None**, _Include in token scope_
     **On** → _Save_; _Mappers → By configuration → Group Membership_: name and token claim
     `groups`, _Full group path_ **Off** → _Save_.
   - _Clients → Create client_ → Client ID `oae-claude-clients` → _Client authentication_ **On**;
     _Authentication flow_: only **Service accounts roles** → _Save_.
   - _Service accounts roles_ tab → _Assign role_ → filter by clients → `realm-management`
     **manage-clients**, **view-clients**, **view-users**, **query-users** → _Assign_.
   - _Credentials_ tab → copy the **Client secret**.

## 3. Fill in the deploy form

In manidae-cloud's _Open Agents Enterprise_ form, set **Single Sign-On** to **Keycloak**:

| Form field                   | Value                                                                                   |
| ---------------------------- | --------------------------------------------------------------------------------------- |
| Keycloak Realm URL           | `https://keycloak.example.com/realms/acme` (the `issuer` in the script's files)         |
| Sign-In Button Name          | What people see: "Continue with …" (for example your company name)                      |
| Console Client ID / Secret   | `oae-console` and its secret (`acme-client.json`)                                       |
| Edge Client ID / Secret      | `oae-edge` and its secret (`acme-edge-client.json`)                                     |
| Directory Client ID / Secret | `oae-edge-directory` and its secret (`acme-directory-client.json`), or leave both empty |
| Claude Gateway Client ID / Secret | `oae-claude-clients` and its secret (`acme-claude-client.json`), or leave both empty (no Claude Gateway Agents) |

The form checks these before it creates the server, and stores the secrets write-only. The
**Server Name** must be the one you used for the redirect URIs.

## 4. Add people

- **Keycloak users**: _Users → Add user_ → username and **email**, _Email verified_ **On** →
  _Create_; _Credentials_ → _Set password_ (temporary, so they choose their own). Or
  `./oae-sso-user.sh acme alice@example.com Alice Smith` on the Keycloak machine.
- **Or your company login**: broker Microsoft Entra ID (below) instead of creating users.
- **Access to Agents** is given in OAE, not Keycloak: the OAE console → the Agent → _Access_ →
  _People_ (see `docs/oae/admin-guide.md`). Signing in alone grants nothing.

## 5. Use your company login (Microsoft Entra ID)

1. In the Entra admin center: _App registrations → New registration_ (single tenant), redirect URI
   (Web) `https://keycloak.example.com/realms/acme/broker/entra/endpoint`; then _Certificates &
   secrets → New client secret_ and note the application (client) ID, the directory (tenant) ID and
   the secret value.
2. In Keycloak, realm `acme`: _Identity providers → Microsoft_ (or _OpenID Connect v1.0_ with
   discovery `https://login.microsoftonline.com/<tenant id>/v2.0/.well-known/openid-configuration`),
   alias **`entra`**, with that client ID and secret → _Add_.
3. Optional: send everyone straight to Microsoft (_Authentication → browser flow → Identity
   Provider Redirector_ → default provider `entra`), and map Entra's email claim to the user's email.

People then sign in with Microsoft and come back as Keycloak users. **Keycloak creates a brokered
user at their first sign-in**: until then the People card cannot find them by email, so ask people
to sign in once before you grant access, or synchronise users into Keycloak (user federation).
Google, Okta or any OIDC/SAML provider is added the same way.

## Security notes

- The secrets file and the script's client files are mode 600; keep them off shared disks.
- Each OAE deployment has its own realm and clients: revoking one never affects another.
- The directory client can only read users; a write is refused (403).
- The OAE console's recovery administrator keeps password sign-in, so a Keycloak outage never locks
  you out of OAE administration.
