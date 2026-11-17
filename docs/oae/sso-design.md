# OAE single sign-on: Keycloak, bundled by default (design)

How OAE does single sign-on, and the decision behind it: **Keycloak is the only issuer OAE talks
to, it ships inside the appliance by default, and it federates out to the customer's own identity
provider (Microsoft Entra ID, Google, Okta, …).** This note records why, what the deployment
provisions automatically, the external-Keycloak escape hatch, and the network-exposure model
including the optional CIDR allowlist.

Implemented (strike: see [`strikes.md`](strikes.md)). The managed mode's on-box installer is
[`deploy/oae/central-sso/oae-keycloak-bundle`](../../deploy/oae/central-sso/oae-keycloak-bundle)
(the realm/clients provisioning of [`oae-realm.sh`](../../deploy/oae/central-sso/oae-realm.sh), with
the client secrets handed in by the platform); manidae-cloud drives it, generates the secrets and the
separate Keycloak admin password, and applies the CIDR allowlist at Traefik
(`backend/app/core/deployment/oce.py`). Today's other shipping behaviour (external Keycloak,
provisioned by hand) is in [`deploy/oae/central-sso/README.md`](../../deploy/oae/central-sso/README.md);
this note keeps that as the "external" option and adds the bundled one as the default.

## Why Keycloak at all — SSO is four jobs, not one

"Sign-in" in OAE is really four surfaces, and only the first two are generic OIDC:

| Part                              | What it does                                              | How it authenticates                                                                                                                                                                         |
| --------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Console sign-in**               | Admins and people sign in to the OAE console              | OCE's generic single-issuer OIDC ([`auth/oidc.ts`](../../apps/controller/src/auth/oidc.ts)); Google is also a native provider ([`auth/google.ts`](../../apps/controller/src/auth/google.ts)) |
| **Edge**                          | People open their Agents, `/apps`, phones, Hermes Desktop | Its own OIDC client at the **same issuer** ([`edge-design.md`](edge-design.md))                                                                                                              |
| **Directory lookup**              | The console's People panel finds people by email          | Keycloak `realm-management view-users` (service account)                                                                                                                                     |
| **Claude Gateway client minting** | One OIDC client **per gateway**, created on demand        | `oae-claude-sync` calls Keycloak admin `/clients` ([`claude-gateway.md`](claude-gateway.md))                                                                                                 |

A raw IdP gives you the first two but not the last two the same way. Keycloak supplies, for **any**
upstream IdP:

1. **One stable `sub`** shared across the console, the edge and every gateway. Going straight to a
   raw IdP breaks this — Entra, for instance, issues a _pairwise_ `sub` per app registration, so the
   console's subject and the edge's subject for the same person would differ, and edge access
   wouldn't match console grants. Keycloak presents its own stable subject to all of them.
2. **A uniform directory read API**, so the People panel works against one interface regardless of
   where users actually live.
3. **A dynamic OIDC-client factory** for Claude Gateways. Entra can approximate this only through
   per-gateway Graph app registrations; Google has no equivalent at all.

So Keycloak is not a login page we carry for convenience — it is the identity broker, directory and
client factory the full feature set needs. Brokering also keeps OAE on OCE's seam (one generic OIDC
issuer): OCE never learns that Entra or Google is behind it, so this adds capability without forking
upstream's auth. See [OAE.md](../../OAE.md) "Fork rules".

## Decision

- **Keycloak is the only SSO integration point.** OAE always points at a Keycloak realm; everything
  else (Entra, Google, Okta, SAML) is federated behind it.
- **Bundled by default** for the single-tenant appliance (one VPS per customer): Keycloak ships in
  the deployment and is provisioned automatically.
- **External Keycloak stays an option** for customers who run their own, or reuse one Keycloak
  across several VPS deployments. Nothing is removed; the bundled mode is added alongside.
- **Direct-to-IdP (no Keycloak) is out of scope** as a product mode. It is noted at the end only as
  a constrained fallback.

## Bundled "managed Keycloak" (the appliance default)

Because manidae-cloud provisions the VPS, it knows the public hostname at deploy time, which is what
makes the automation reliable.

**What ships:** Keycloak and its own PostgreSQL, inside the OAE package, behind the deployment's
existing Traefik as `keycloak.<host>` beside the console, edge and Agent hosts. This is a "medium"
manidae package (a service with startup provisioning), the same shape as the OCE and Hermes
packages; see the `manidae-add-package` guidance.

**What the deploy provisions automatically** (the logic of
[`oae-realm.sh`](../../deploy/oae/central-sso/oae-realm.sh), moved into install/startup):

- the realm;
- all five clients — `oae-console`, `oae-edge`, `oae-edge-directory`, `oae-claude-clients`, and the
  `groups` client scope;
- every redirect URI, derived from the chosen Server Name (console callback, edge
  `auth.agents.<host>/callback`, and the broker endpoint `…/realms/<realm>/broker/<alias>/endpoint`
  ready for when an IdP is added);
- client IDs and secrets, generated internally and wired straight into OAE's configuration.

**The user pastes nothing** — no realm URL, no client IDs, no secrets, no scripts, no manual
redirect URIs. The deploy form's SSO section collapses to "managed" with no required fields.

**Idempotent on redeploy.** Re-running keeps client IDs and secrets and _adds_ any new host's
callbacks, exactly as the current script does (`OAE_SSO_REPLACE_REDIRECTS=1` to prune). This matters
for the host-changed-on-reprovision case and for clean-deploy-vs-upgrade differences — a clean
deploy must provision the realm from scratch, an upgrade must not clobber it.

## External Keycloak (the option)

Unchanged from today: the deploy form's SSO section offers "external", taking the realm URL and the
client IDs/secrets as in [`central-sso/README.md`](../../deploy/oae/central-sso/README.md). The
underlying renderer is already generic — manidae's `EnterpriseOidc` only _auto-derives_ endpoints
for a Keycloak `/realms/…` issuer and accepts explicit endpoints otherwise
([`oce.py`](../../../manidae-cloud/backend/app/core/deployment/oce.py)) — so this path needs no new
code. Use it to run your own Keycloak or share one realm-per-deployment across many VPSs.

## Federating to the customer's IdP — the one manual step

Bundling automates the **OAE side** only. Pointing Keycloak at the customer's Entra ID or Google is
irreducibly manual, because it needs an app registration in **their** tenant:

1. The customer registers an app in their IdP with redirect URI
   `https://keycloak.<host>/realms/<realm>/broker/<alias>/endpoint` (already pre-created) and returns
   a client ID and secret.
2. An admin adds the Identity Provider in the bundled Keycloak's admin console (alias e.g. `entra`
   or `google`), pastes the ID and secret, and optionally sets it as the default browser flow so
   everyone goes straight to the company login.

Full steps for Entra ID and Google are in
[`central-sso/README.md` § 5](../../deploy/oae/central-sso/README.md). Because bundling pre-creates
the realm, clients and broker redirect URI, this shrinks to "register one app, paste two values."
One inherent limit: a brokered user does not exist in Keycloak until their first sign-in, so the
People panel cannot find them by email until then — ask people to sign in once before granting
access, or set up user federation.

## Credential separation

The bundled Keycloak's master-admin password is **auto-generated, separate from OAE's admin
password, and stored write-only** — never the same credential. Reusing OAE's admin password would
couple two trust domains: a compromise of one would hand over the IdP for everyone. OAE already
keeps a recovery administrator on password sign-in, so a Keycloak outage never locks anyone out of
OAE administration, and the two admin identities stay independent.

## Network exposure and the optional CIDR allowlist

Both OAE and the bundled Keycloak face the public internet. They are **not** interchangeable
surfaces, because of who must reach each one:

- **Keycloak `/realms/*` (sign-in) must stay public.** Real users sign in from arbitrary addresses,
  and the Entra/Google broker callback returns **through the user's browser**, not server-to-server.
  Do **not** put a second login (proxy auth) in front of it: OAE's servers call `/realms/*` and
  `oae-claude-sync` calls `/admin/realms/*` directly (tested 2026-11-12).
- **Keycloak `/admin` and `/admin/master`: locked down always.** Restrict to operator addresses or,
  better, do not expose them publicly at all — reach them over an SSH tunnel or VPN. Keycloak's own
  admin login, brute-force detection and HTTPS are the always-on baseline.
- **Server-to-server callers bypass public ingress.** The controller, edge and `oae-claude-sync`
  reach Keycloak on the box / in-cluster, so the controls below (which apply to public ingress) never
  cut them off.

### The CIDR allowlist — optional, **off by default**

An optional allowlist restricts the public footprint (OAE console, edge/Agent hosts, `/apps`, and
Keycloak sign-in) to one or more operator-supplied **CIDR ranges**. The default is **allow-all**
(`0.0.0.0/0` and `::/0`) — i.e. off — so out of the box the appliance behaves exactly as above
(public sign-in, locked admin). The control is always present; the default value just doesn't
restrict anything.

- Proposed deploy setting: `oae_allowed_cidrs` — a list of CIDRs (IPv4/IPv6), defaulting to
  `0.0.0.0/0`, `::/0`. Applied at Traefik as an ingress-level allow rule on the public hosts.
  Narrowing it from allow-all is what "turns the allowlist on".
- When narrowed, the operator must include **every** legitimate client range: the customer's corporate
  egress, any VPN exit, and remote staff — because this also gates the **sign-in** path. A user
  outside the ranges is blocked before Keycloak, which is the intended effect for a known-network
  customer and the reason it ships off by default (a half-filled list locks real users out).
- It does **not** replace the baseline: `/admin` stays restricted regardless, and the federated IdP
  (Entra/Google, with their MFA and conditional access) remains the actual authentication control.
  The allowlist is network hardening on top, best suited to single-tenant appliances whose users sit
  on known networks.

## Backups

The bundled Keycloak holds identity state — local users, brokered-user mappings and client secrets —
so it joins the [`backup.md`](backup.md) scope. Mind the testbed caveat that `oae-backup`'s default
folder is the AgentGateway's backups ([OAE.md](../../OAE.md), [`testbed.md`](testbed.md)); the
bundled Keycloak's backup must not collide with it.

## Out of scope: direct-to-IdP (no Keycloak)

Recorded so the trade-off is on file, not as a planned mode:

- **Console + edge sign-in** can run against a raw IdP today — the console OIDC handler is generic,
  and Google is a native provider. It would need a manidae "direct OIDC" form mode and a fix to key
  edge identity on a tenant-stable claim (Entra `oid`, not the pairwise `sub`).
- **Directory lookup** would need a per-provider adapter (Microsoft Graph, Google Workspace Admin
  SDK) with no current abstraction.
- **Claude Gateway** cannot work on Google directly (no per-client minting API) and needs heavyweight
  Graph app-registration automation on Entra.

So a direct-IdP deployment is viable only as **sign-in-only** (no Claude Gateway, People panel
degraded to post-login). It is a constrained escape hatch, never the appliance's path.
