# Claude Gateway for Open Agents Enterprise

Optional OAE component: staff use **Claude Code** and **Claude Desktop** through Anthropic's own
`claude gateway`, signed in with the company's Keycloak, with personal data masked before
anything reaches Anthropic. The gateway's address is private: laptops reach it over WireGuard.

Claude is a trademark of Anthropic, PBC. OAE runs Anthropic's `claude gateway` unmodified: the
installer downloads the pinned Claude Code release from Anthropic and checks it against the release
manifest. OAE does not redistribute the binary.

```
laptop ──WireGuard (UDP 51830)──> Traefik (tunnel only) ──TLS passthrough──> gateway ──> PII masker ──> Anthropic
                                        └────────────────────────────────────> Keycloak (sign-in, groups)
```

| Service      | Role                                                        | Reachable from                    |
| ------------ | ----------------------------------------------------------- | --------------------------------- |
| `gateway`    | `claude gateway`: sign-in, model policy, audit              | the tunnel; no route out at all   |
| `postgres`   | gateway sessions and Keycloak's database                    | the stack only                    |
| `keycloak`   | sign-in (production mode, own TLS); or use an existing realm | the tunnel                        |
| `pii-masker` | masks personal data, holds the only Anthropic key           | the gateway; out to Anthropic     |
| `wireguard`  | laptop access, peers in 10.77.0.0/24                         | UDP 51830 (the only public port)  |
| `traefik`    | SNI routing on the tunnel address; no dashboard, no socket  | the tunnel only                   |

Versions are pinned in [`versions.env`](versions.env) (images by digest).

## Install

On the OAE server, as root, from a checkout of this repository:

```bash
CGW_EMAIL_DOMAINS=example.com \
CGW_ANTHROPIC_KEY_FILE=/root/anthropic-key \
deploy/oae/claude-gateway/claude-gateway install
```

- The Anthropic key file holds the key (or `ANTHROPIC_API_KEY=...`). It is copied to a root-only
  file the masker reads; delete your copy afterwards. Without the variable the installer prompts
  for it (not echoed).
- Open **UDP 51830** inbound in the cloud firewall (Hetzner Cloud Firewall, Oracle security list).
- Everything lives in `/opt/claude-gateway`; secrets are generated once into its root-only `.env`
  and kept on upgrade. Re-running `install` upgrades in place.

| Setting                 | Default                               | Meaning                                                         |
| ----------------------- | ------------------------------------- | --------------------------------------------------------------- |
| `CGW_EMAIL_DOMAINS`     | (required)                            | email domains allowed to sign in                                |
| `CGW_MODELS`            | `claude-sonnet-5-5,claude-haiku-5-5` | models everyone may use (first install; then `policies.yaml`)   |
| `CGW_IDP`               | `bundled`                             | `external`: use an existing Keycloak realm (see below)          |
| `CGW_NETWORK`           | `wireguard`                           | `pangolin` (Newt site) or `none`                                |
| `CGW_PUBLIC_HOST`       | the server's public IPv4              | WireGuard endpoint written into peer files                      |
| `CGW_DOMAIN`            | `oae.internal`                        | private names: `claude-gw.<domain>`, `keycloak.<domain>`        |
| `CGW_SESSION_TTL_HOURS` | `1`                                   | session lifetime = the longest a disabled person keeps access   |
| `CGW_LOAD_TEST`         | `0`                                   | `1`: canned replies, nothing sent to Anthropic (for trials)     |

### Using OAE's own Keycloak (`CGW_IDP=external`)

In the realm OAE already uses, create a confidential client `claude-gateway` (standard flow only,
redirect URI `https://claude-gw.oae.internal:8443/oauth/callback`) and a `groups` client scope with
a Group Membership mapper (claim `groups`, **Full group path off**), added to the client as an
optional scope. Then install with `CGW_IDP=external CGW_OIDC_ISSUER=https://<keycloak>/realms/<realm>
CGW_OIDC_CLIENT_ID=claude-gateway CGW_OIDC_CLIENT_SECRET_FILE=<file>`. The gateway then also joins
the egress network to reach that Keycloak (the metadata block still applies).

## Day to day

| Task                         | Command                                                                       |
| ---------------------------- | ----------------------------------------------------------------------------- |
| Add a person (bundled)       | `claude-gateway user add alice@example.com [group]` (temporary password file) |
| Issue a laptop               | `claude-gateway peer add alicemac` (letters and digits only)                  |
| Revoke a laptop              | `claude-gateway peer remove alicemac` (immediate)                             |
| Models per group             | edit `/opt/claude-gateway/config/policies.yaml`, then `claude-gateway restart` |
| PII rules                    | edit `/opt/claude-gateway/pii/pii-rules.json`, then `claude-gateway restart`  |
| Who did what                 | `claude-gateway logs 60` (sign-ins, policy matched, model, status)            |
| Health, fingerprint, tunnels | `claude-gateway status`                                                       |

`user add` and `peer add` write hand-off files under `/opt/claude-gateway/handoff/` (root-only):
the person's temporary password, and for a laptop its tunnel file, the CA certificate and
`setup-mac.sh`. Send them privately, then delete them; the tunnel file holds a private key.

**Offboarding**: disable the person in Keycloak **and** remove their peer. The gateway has no early
session revocation: a session stays valid for up to `CGW_SESSION_TTL_HOURS`, but removing the peer
cuts the network path at once.

### Model policies

`policies.yaml` is a list; the first entry whose `match` fits a person's Keycloak groups wins, so
keep the catch-all `match: {}` last:

```yaml
- match: { groups: [engineering] }
  cli:
    availableModels: [claude-opus-5-5, claude-sonnet-5-5]
    enforceAvailableModels: true
  desktop: {}
- match: {}
  cli:
    availableModels: [claude-haiku-5-5]
    enforceAvailableModels: true
  desktop: {}
```

`desktop: {}` lets that policy use Claude Desktop (without it Desktop gets 404). The gateway
enforces the list (HTTP 400 for other models). Desktop caches the list: after a change, users quit
Desktop (Cmd+Q) and reopen. The gateway governs models and identity, not what Claude does on the
laptop: Desktop's Code tab in Auto mode runs commands locally.

### PII rules

`pii-rules.json` switches built-in detectors on or off (email, phone, IBAN, payment card, US SSN,
UK NINO, Irish PPSN, passport, date of birth), adds custom regex rules with optional keywords, and
lists exceptions. Matches are replaced with placeholders before Anthropic and restored in replies,
including tool-call arguments. The masker logs who sent which types of data, never the values.

## Laptops

Each person receives their hand-off folder and runs `setup-mac.sh` once (it asks for the Mac
password). It adds a hosts line for the gateway's private names, trusts the CA (name-constrained to
`*.oae.internal`, so it cannot vouch for any other site), and points Claude Code at the gateway.

1. **WireGuard** (Mac App Store): Import tunnel(s) from file, pick the `.conf`, Activate. macOS
   runs one WireGuard tunnel at a time: deactivate any other.
2. **Claude Code** (2.1.295 or later): `claude`, confirm the certificate fingerprint shown by
   `claude-gateway status`, then sign in with Keycloak. `/status` shows "Cloud gateway".
3. **Claude Desktop**: Help → Troubleshooting → Enable Developer Mode; Developer → Configure
   Third-Party Inference… → **Source** → Bootstrap config URL
   `https://claude-gw.oae.internal:8443/user/bootstrap`, OIDC fields empty, Save; then **Sign in
   with your organization**. If the gateway's hostname ever changes, every Desktop must be updated
   (or pushed by MDM).

Claude Code pins the gateway's certificate on first use: a new certificate prompts every user
again, so rotate it rarely and announce the new fingerprint. Windows and Linux laptops are not
tested yet.

## Security notes

- Only UDP 51830 is public. Traefik lives in WireGuard's network namespace; the gateway, Keycloak and
  Postgres sit on an internal Docker network with no route off the host.
- The cloud metadata address (169.254.169.254) is blocked for the egress network by
  `claude-gateway-egress.service`, re-applied whenever Docker starts.
- The Anthropic key is only in `anthropic.env` (root-only) and the masker; the gateway holds a key
  the masker accepts. Set a spend limit on the Anthropic workspace too.
- The CA key lives in `/opt/claude-gateway/certs/ca` (root-only). Back it up offline.

## Pangolin instead of WireGuard

For sites that already run Pangolin (1.13 or later): `CGW_NETWORK=pangolin` with a root-only
`/opt/claude-gateway/newt.env` (`PANGOLIN_ENDPOINT`, `NEWT_ID`, `NEWT_SECRET`) from a Newt site. Add
private resources (mode Host) for `claude-gw.oae.internal` and `keycloak.oae.internal`. Newt must
match the Pangolin server's era (1.8.1 for Pangolin 1.14.1). Not yet re-tested in this package.

## Uninstall

`claude-gateway uninstall` stops the stack and removes the metadata unit; `--purge` also deletes
`/opt/claude-gateway` (CA, sessions, Keycloak data). Close UDP 51830 in the cloud firewall.
