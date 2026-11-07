# OAE edge: people in an Agent's own UI (design)

Strike 2's last piece. People granted an Agent in OAE open that Agent's OpenClaw Control UI at
`https://agent-<hash>.agents.<host>/` with their SSO identity and their granted scope, and nobody
else can. This is the operator-managed **human ingress** OCE specifies in
[`gateway-authentication.md` § Human ingress](../reference/drivers/kubernetes-compute/gateway-authentication.md#human-ingress)
(from upstream #3049). OAE provides the ingress; OCE's code is unchanged except #3049 itself.

## Why not native admin

OCE's native admin UI is refused with OIDC sign-in (host-only `__Host-` session cookie), needs
Agent `administer`, and presents everyone as the machine identity `occ-workspace-files`. Human
ingress keeps per-person identity, works with OIDC, and grants less than administrator.

## Requirements (from OCE) and how OAE meets them

| OCE requirement | OAE |
|---|---|
| The ingress authenticates people | `oae-edge-authz` (OIDC client of the installation's Keycloak realm, client `oae-edge`), signed cookie on `.agents.<host>` |
| Authorizes access to the exact Gateway | `oae-edge-authz` checks the person against the Agent's grants (OCE AccessBindings → principal → SSO subject via `oae-user`'s registry) |
| Stable, namespaced identity; never `occ-workspace-files` | `x-occ-identity: <realm>:<subject>` (issuer-qualified Keycloak subject) |
| `x-openclaw-scopes` on every request and WS upgrade, replacing client values | Set by the edge from the grant: `user` → `operator.read operator.write`; `operator` → also `operator.approvals`; no grant → never forwarded (403) |
| Overwrite client-supplied identity and authority headers | Traefik strips `x-occ-identity`, `x-openclaw-scopes`, `x-auth-request-*` before auth; forwardAuth `authResponseHeaders` sets them |
| Separate identity-preserving route (the OCC route forces the machine identity) | In-cluster Traefik Ingress per Agent host → the Agent's gateway Service (not via Envoy) |
| Exact-peer NetworkPolicy to the gateway port | `oae-edge` NetworkPolicy in the tenant namespace: only k3s Traefik's Pods → gateway Pods' port |
| Proxy source in `network.gatewayTrustedProxyCidrs` | Traefik Pods are in the Pod CIDR `10.42.0.0/16`, already trusted |
| Human UI origin in `gateway.controlUi.allowedOrigins`; humans in `trustedProxy.allowUsers` (+ `identityScopes`) | `oae-edge-sync` merges both into the Agent's Configuration and redeploys when a new person is first granted |

## Flow

```
browser ── https://agent-<hash>.agents.<host> ──▶ host Traefik (TLS, Let's Encrypt)
  ──▶ k3d ingress ──▶ k3s Traefik Ingress (host agent-<hash>…)
        middlewares: strip identity headers → forwardAuth oae-edge-authz
                     (no session: redirect to sign-in; granted: identity + scopes; else 403)
  ──▶ gateway Service (tenant namespace), trusted-proxy auth on x-occ-identity / x-openclaw-scopes
```

## Revocation

The edge is authoritative and immediate: `oae-user revoke` removes the binding, the next request
(and WebSocket reconnect) is refused at the edge. Only the edge can reach the gateway port
(NetworkPolicy), so a stale `allowUsers` entry is unreachable; `oae-edge-sync` removes it at the
Agent's next deploy. OCE's own caveat stands: withdrawal does not cancel work already accepted.

## Pieces

| Piece | Kind | Where |
|---|---|---|
| `oae-edge-authz` | small HTTP service (forwardAuth target), reads an ACL ConfigMap | `deploy/oae/edge/` |
| `oae-edge-sync` | timer on the host: ACL ConfigMap, per-Agent Ingress + NetworkPolicy, Configuration merge, host Traefik routes | `deploy/oae/edge/` |
| Keycloak client `oae-edge` | per realm, redirect `https://auth.agents.<host>/oauth2/callback` | `central-sso/oae-realm.sh` |

## Access without a shell (hardening, branch `feat/oae-hardening`)

OCE's model is that people change things through its API with their own identity, and that
nobody needs a shell in an Agent or on the server for day-to-day work. OAE's first edge needed
root on the server for three things; each now follows that model.

| Was | Now | Identity OCE sees |
|---|---|---|
| `oae-user add/grant/revoke` as root, writing under the **recovery administrator's** session | Console: Agent → Access → **People**. The browser makes every OCE call (account, SSO identity, Roles, AccessBindings) with the administrator's **own** session | The administrator who clicked |
| `oae-user device add` (root) and `kubectl exec … openclaw qr` | `https://auth.agents.<host>/apps`: the signed-in **person** connects their own OpenClaw mobile app or Hermes Desktop | The person (edge log) |
| `oae-user device approve-node` via `kubectl exec` into the gateway Pod | Operators approve in the Agent's own **Devices** page (`operator.pairing` in the operator grant; never `operator.admin`) | The operator (gateway) |
| Root-owned `oae-users.json` / `oae-devices.json` | The edge's own Secrets `oae-edge-people` / `oae-edge-devices`; its ServiceAccount may `get`/`update` only those two | — |

The edge's console API (`/oae/api/`, routed on the console host so the administrator's session
cookie comes with it):

- Every call first asks OCE whether the caller is a human Installation administrator
  (`GET /api/auth/session`, then `GET /api/auth/accounts/<self>`, which OCE answers only for one).
  Writes also need `Origin` = the console and a JSON body.
- `GET /oae/api/directory?email=` looks the person up in Keycloak with a separate client
  (`oae-edge-directory`) that can only read users (`realm-management` `view-users`; a write is 403).
- `POST /oae/api/people {userId}` records which SSO subject an OCE Principal is, read from OCE's own
  account record (with the administrator's session) and the directory, never from the request.

App tokens (`/apps`): created by the person for one Agent they are granted, bound to that Agent's
host, shown once (only the SHA-256 is kept), refused when the grant goes (every request is checked
against the ACL), and listed and disconnected by the person. The OpenClaw setup code carries only
the gateway URL (`wss://agent-…/d/<token>`); the official apps accept that (no bootstrap token): the
edge authenticates the app as the person and new operator devices pair automatically, while node
access waits for an operator's approval in the Agent's Devices page.

Agents no longer see the person's edge session cookie: after the check, Traefik drops `Cookie`
before the gateway (as OCE's own Gateway routes do), so one Agent cannot replay it against the
person's other Agents.

What still runs as root is platform automation, not a person: `oae-edge install`, and the
`oae-edge sync` timer, which reads IAM with the installation's service key (OCE lets only an
Installation administrator list AccessBindings; a read-only IAM grant would let this narrow) and
reads each Hermes Agent's dashboard token Secret. `oae-user` remains as break-glass for the
platform operator when SSO is down, and says so.

## Status (2026-11-06)

- ✅ Upstream #3049 cherry-picked onto `oae` (branch `strike/2-human-ingress`, clean); upstream's
  Kubernetes Compute conformance suite passes (391 tests, 0 failures). The runtime image needs no
  change: its OpenClaw (`554f0b8`) already supports `requiredHeaders` and `x-openclaw-scopes`.
- ✅ OAE controller image built from that branch and running on Oracle (local test registry, by
  digest — the chart only accepts digest-pinned images). An Agent Configuration naming a person
  is admitted; the gateway renders the person in `allowUsers`/`identityScopes`, the machine
  identity unchanged, and Compute adds `x-openclaw-scopes` to `requiredHeaders` by itself.
- ✅ Images on Docker Hub (public, amd64 + arm64): `oideibrett/open-agents-enterprise-controller`
  (`sha256:bf2dca0b…`, OCE `54bfa7f` + #3049) and `oideibrett/open-agents-enterprise-edge`
  (`sha256:98dc7001…`). Oracle runs both.
- ✅ Edge live on Oracle (`oae-edge install`, `oae-edge-sync.timer` every minute). Sign-in is our own
  small OIDC client (`oae-edge-authz`, openid-client) instead of OAuth2 Proxy: Traefik's error-page
  redirect loses the original host, and OAuth2 Proxy's callback sits on one host, so the
  multi-host return path broke; the forwardAuth service answers with the redirect itself.
- ✅ Browser end to end as the SSO demo user: Agent URL → Keycloak (`oae-edge` client) → back on the
  Agent host → OpenClaw Control UI "Connected" as `oae-oracle:<sub>` (not the machine identity) →
  a chat turn answered. New browsers pair automatically (`deviceAutoApprove` read/write, as OCE's
  native-admin recipe; capped by `x-openclaw-scopes`). Spoofed `x-occ-identity` /
  `x-openclaw-scopes` headers without a session → 401. Revoke → "No access" (403) on the next
  load, identity removed from the gateway at the next sync. New revisions are re-bound by the sync.
- ✅ manidae installer (branch `oae/strike-2-installer`, `b31f217d`): OAE pins fork `ff69c09` with our
  controller and edge images; with SSO + the `oae-edge` client the install runs `oae-edge install`
  and enables the timer. Fresh unattended install on Oracle: 0 warnings; agent created, person
  added and granted, the timer alone made the gateway admit them in ~75 s; browser connected as
  the person and a chat turn answered.
- Grant latency: up to ~2–3 min (timer 60 s, ConfigMap propagation to the pod ~60 s, redeploy ~60 s).

## Open points

- Grant changes that add or remove a person redeploy the Agent (OCE revisions are immutable;
  `oae-edge sync` re-binds the new revision itself).
- Per-Agent Let's Encrypt certificates (HTTP-01) as `oce-agent-routes` did; a wildcard needs DNS-01.
- A direct load of a deep link such as `/chat/main` can show OpenClaw's public "Conversation
  unavailable" page; opening the Agent's root URL works. To investigate.
