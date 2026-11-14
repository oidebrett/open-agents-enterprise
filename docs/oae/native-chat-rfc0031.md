# RFC-0031 native browser chat for OAE — proof and coexistence finding

Strike 8. Can OAE adopt upstream's [RFC-0031](../../specs/rfcs/0031-oidc-agent-chat.md) native
agent-chat mechanism for the **browser** Agent-UI slice, retiring our edge's browser forward-auth for
that one case, while keeping the rest of the edge (device/mobile pairing, the Claude Gateway VPN, the
People panel, `/apps`)?

Short answer: **the native mechanism works at the runtime level and is already enabled on the testbed,
but on an OAE/SSO install it is externally shadowed by our edge and is a net downgrade for the browser
slice.** Keep the edge for browsers for now; the native path does not yet express what our edge grants.
Reasoning and evidence below.

This is a proof-of-concept (works + gaps + plan), not an edge retirement. It follows the
[OAE fork rules](../../OAE.md): everything here is new files under `docs/oae/` and `deploy/oae/`; no
upstream file is edited.

## Baseline on the test box (2026-11-14)

Oracle BYOVPS, base `a71a4289` after the first upstream sync (controller
`sha256:03ae9843…`, runtime `sha256:8440e412…`, both from source). The sync enabled upstream's
RFC-0031 native admin under OIDC:

| Controller env | Value |
|---|---|
| `OCC_AGENT_NATIVE_ADMIN_ENABLED` | `true` |
| `OCC_AGENT_NATIVE_ADMIN_DOMAIN` | `agents.oae.ag-6a4baf8a.nemoclaw.dpdns.org` |
| `OCC_AUTH_BASE_URL` | `https://oae.ag-6a4baf8a.nemoclaw.dpdns.org` |

One Agent, `agt_8d7c4c8c` ("MyClaw", OpenClaw runtime), revision `rev_9e88010c`. No person is currently
granted on it (edge ACL is `{}`).

## How RFC-0031's native path is built (code)

The native mechanism is entirely in the base; nothing in OAE is needed to turn it on:

1. **Shared cookie.** `deriveSharedCookieDomain` (`apps/controller/src/auth/configuration.ts:152`) takes
   the longest common DNS-label suffix of the Console origin and the Agent domain. On the testbed that is
   `oae.ag-6a4baf8a.nemoclaw.dpdns.org`, which covers both the console (`oae.ag-…`) and every Agent host
   (`agent-<hash>.agents.oae.ag-…`). The session cookie `__Secure-openclaw_occ_shared.session_token`
   therefore reaches Agent hosts.
2. **Access-mode selection.** `resolveNativeAdminAvailability` (`apps/controller/src/http/native-admin.ts:875`)
   asks IAM for the caller's grant on the exact Agent: `administer` → `mode:"admin"`, `operate` →
   `mode:"chat"`. The console then shows **Open Agent UI** (admin) or **Open chat**
   (`apps/controller/src/console/agents/native-admin.mts:287`).
3. **Endpoint.** admin → `compute.getGatewayEndpoint(revision)`; chat →
   `compute.getGatewayChatEndpoint(revision)` (`native-admin.ts:947`). The browser then loads the Agent
   host URL (`agent-<hash>.<native-admin-domain>`) carrying the shared cookie.
4. **Native route + scope ceiling.** The Kubernetes compute driver writes a Gateway-API `HTTPRoute`
   whose route filter **overwrites** the identity and scope headers
   (`apps/controller/src/drivers/compute/kubernetes/index.ts:14014`):
   - admin route → `x-occ-identity: occ-workspace-files`, `x-openclaw-scopes: operator.admin`;
   - `/native-chat/…` route → the same identity but `x-openclaw-scopes: operator.sessions.write`
     (`index.ts:14027`, `:14251`).
   The chat route is emitted only when `getGatewayChatEndpoint` is defined (`index.ts:4939`), which needs
   **both** (a) `usesWritableNativeAdminConfig(configuration)` (`index.ts:13878`) and (b)
   `trustedProxy.requiredHeaders` containing `x-openclaw-scopes`.

So the native path always presents the **shared machine identity** `occ-workspace-files` and caps the
browser at `operator.sessions.write` for `operate` holders — never per-person identity.

## What we found on the test box

### Q1 — Does native cookie chat work end to end for an SSO user? Not at the public host.

The public Agent host `agent-<hash>.agents.oae.ag-…` is a **collision**: upstream's native-admin domain
(`OCC_AGENT_NATIVE_ADMIN_DOMAIN`) is identical to the edge's agents domain. On the testbed the two
mechanisms route that host differently:

| Mechanism | Object | Host it binds | Reachable from a browser? |
|---|---|---|---|
| Native (RFC-0031) | Envoy `HTTPRoute gateway-<h>` | `occ-gateway-<h>.envoy-gateway-system.svc` (in-cluster) | **No** |
| OAE edge (strike 2) | k3s `Ingress oae-edge-<h>` | `agent-<hash>.agents.oae.ag-…` (public) | **Yes** |

The native `HTTPRoute` is bound to the **internal** Envoy service name, not the public Agent host, because
OAE never stood up an external native ingress for Agent hosts — the edge is that ingress. A `curl` of the
public host returns `401` from `oae-edge-authz` (the edge forward-auth), not the native listener. So a
browser that follows the native-admin "Open chat" URL still lands on the **edge**, which authenticates the
person and injects per-person identity — it never exercises the native `/native-chat` route or the shared
cookie's native identity.

Worse, on the live (ungranted) Agent the native chat route is **not generated at all**: its Envoy
`HTTPRoute` has only the admin rule (`operator.admin`). The agent's gateway config has
`deviceAutoApprove` absent, so `usesWritableNativeAdminConfig` is `false` and `getGatewayChatEndpoint`
returns `undefined`. (`requiredHeaders` already contains `x-openclaw-scopes`, so gate (b) is met — only
gate (a) fails.)

**However, a *granted* OAE Agent does qualify.** When a person is granted, `oae-edge` rewrites the Agent
config with `deviceAutoApprove = {enabled:true, scopes:[operator.read, operator.write]}` and merges the
human-UI origin into `controlUi.allowedOrigins` (`deploy/oae/edge/oae-edge:297`). That flips
`usesWritableNativeAdminConfig` to `true`, so the native `/native-chat` route (`operator.sessions.write`)
**co-generates** on the Envoy HTTPRoute for exactly the Agents the edge manages — it is just never
reached, because the edge Ingress owns the public hostname. The native mechanism is therefore present and
correct in-cluster; it is shadowed, not broken.

### Q2 — Does our from-source runtime have the qualified chat enforcement? Yes.

The gateway Pod runs `docker.io/oideibrett/open-agents-enterprise-runtime@sha256:8440e412…`, which bundles
**OpenClaw 2026.10.10**. Its `docs/gateway/operator-scopes.md` is present in the image and defines the
scope-aware model RFC-0031 requires:

- `operator.sessions.write` — "Read visible sessions, organize owned sessions, and start or continue the
  authenticated person's own work." Includes `operator.sessions.read`.
- `operator.admin` — "Satisfies every `operator.*` scope. Required for config mutation, updates, native
  hooks, reserved namespaces, and high-risk approvals."

The Agent's gateway config carries `trustedProxy.requiredHeaders: [x-openclaw-scopes]`, so the native
listener **requires** the scope header on every HTTP request and WS upgrade (it is not advisory). This is
the "scope-aware UI and server enforcement" RFC-0031 depends on, in the exact pinned-runtime lineage
upstream qualified (RFC-0031 baseline pinned OpenClaw `513c12703ad9`; ours is newer from the same source).

Not run here: a direct per-method WS intersection probe (open an operator socket at
`operator.sessions.write` and confirm a session op succeeds while an admin RPC is refused). It would mean
standing up an operator WS client against the live gateway; RFC-0031's delivery record already qualifies
HTTP, WebSocket and device scope ceilings on this runtime family, and `operator-scopes.md` ships in the
image. The `oae-native-chat-check` diagnostic (below) verifies the two header/route gates without that.

### Q3 — What does our edge grant need beyond the `operator.sessions.write` chat ceiling?

The edge maps grants to scopes (`deploy/oae/edge/authz/server.mjs:63`):

| OAE grant | Scopes the edge injects |
|---|---|
| `user` | `operator.read, operator.write` |
| `operator` | `operator.read, operator.write, operator.approvals, operator.pairing` |

Compared with the native chat ceiling `operator.sessions.write`:

- **`operator.write` is broader** than `operator.sessions.write` (Gateway-wide tool invocation, talk/voice
  settings, node command relay). Plain chat fits inside `operator.sessions.write`, but today even our
  `user` grant is wider than the native chat ceiling.
- **`operator.approvals`** (approve the Agent's tool-call approvals) is **not** in `operator.sessions.write`
  — RFC-0031 explicitly says the chat ceiling "does not grant … approvals". Our `operator` holders approve
  tool calls in the Agent UI today; the native chat route cannot carry that.
- **`operator.pairing`** (device/node approvals in the Agent's Devices page) is likewise excluded.

The native model has only two browser rungs — `operator.sessions.write` (chat) and `operator.admin` (full
admin). There is **no native rung between them**, so our "operator" grant (chat **plus** approvals/pairing,
but **not** admin) has no native equivalent. Giving those operators the native `administer` route to regain
approvals would hand them the full administrative profile — exactly what OAE's edge was built to avoid.

### Q4 — How does the edge's device/VPN/People/apps layer coexist with the native cookie path?

Cleanly, because those features never touched the native path to begin with:

- **Device/mobile pairing** (`/d/<token>`, strike 3 / hardening `/apps`) is a disjoint URL prefix on the
  edge Ingress; the gateway accepts the app token (or a `--limited` bootstrap token) ahead of trusted-proxy
  identity. Native admin has no role here.
- **People panel** (hardening) uses the administrator's own OCE session over the console host to write
  grants; it is console-side, orthogonal to how an Agent host is routed.
- **Claude Gateway VPN** and **Hermes** runtimes are separate Agent kinds the native OpenClaw admin UI does
  not cover at all.

What *does* interact is the Agent **gateway config** and the Agent **hostname**. Native-admin being ON
means the controller now also writes the native machine identity + admin route into every Agent, and the
edge's grant merge now additionally trips the native-chat route into existence. Both are harmless while the
edge owns the public hostname — but it means two authorities (the controller's native config and
`oae-edge sync`) write overlapping keys (`controlUi`, `trustedProxy`, `identityScopes`) into the same
config. That overlap is the thing to watch on future syncs (see Risks).

## Recommendation

**Do not retire the edge's browser forward-auth yet. Keep the browser slice on the edge.** Adopting the
native path for browsers would, on an OAE/SSO install:

1. require routing the Agent host to the Envoy gateway's external listener and removing the edge Ingress
   for that host (a real ingress re-architecture, not a toggle), and
2. replace per-person gateway identity (`oae-oracle:<sub>`) with the shared `occ-workspace-files` machine
   identity — RFC-0031 states plainly it "does not promise private conversations between people sharing an
   Agent"; OAE's edge gives per-person identity and audit today, and
3. drop `operator.approvals`/`operator.pairing` for our "operator" grant, with no native rung between
   `operator.sessions.write` and full `operator.admin` to restore them.

That is a net downgrade in identity, audit and operator capability for the browser slice. The edge already
delivers everything RFC-0031 does for browsers, plus per-person identity, plus the approvals/pairing rung,
over the same trusted-proxy gateway contract.

**What we gain by *not* adopting, and still align with upstream:** the native mechanism is enabled and
correct in-cluster, so the recovery administrator (who holds `administer`) can still use upstream's **Open
Agent UI** natively for break-glass, unchanged. We lose nothing by leaving it on.

**Revisit the decision if upstream RFC-0031 evolves to**:
- carry a **per-person** native identity on the chat route (not the shared `occ-workspace-files`), and
- add a native scope **between** `operator.sessions.write` and `operator.admin` that includes approvals.

At that point the native path would match the edge's browser behaviour, and retiring the edge's browser
forward-auth (keeping device/VPN/People/apps) would be a straight simplification. Until then the edge is
the better boundary.

### If we did adopt it later — the shape

For the record, the smallest viable adoption (not done here):
- Give the native-admin domain its **own** hostname distinct from the edge's agents domain (e.g. keep
  `OCC_AGENT_NATIVE_ADMIN_DOMAIN` but stop the edge Ingress from claiming those hosts), so the native Envoy
  external listener serves the native host and the edge serves the edge host.
- Map OAE `user`/`operator` grants to `operate` (native chat) and keep `administer` for the recovery admin
  only.
- Accept the shared-identity and approvals gaps above, or front the native route with a **thin** edge shim
  that keeps per-person identity — which is most of the edge we were trying to retire, so it defeats the
  purpose.

## Exercising the native chat path

`deploy/oae/edge/oae-native-chat-check` is a read-only diagnostic for an OAE/SSO install. For a given
Agent it reports, against the live gateway config and Envoy HTTPRoute, whether the two
`getGatewayChatEndpoint` gates hold and whether the `/native-chat` (`operator.sessions.write`) route has
been generated — i.e. whether the native chat path is live for that Agent. See its `--help`.

## Risks / things to watch on future syncs

- **Config write overlap.** With native-admin ON, both the controller (native baseline) and `oae-edge sync`
  write `gateway.controlUi` / `gateway.auth.trustedProxy` / `identityScopes`. They currently agree, but an
  upstream change to the native config shape could collide with the edge merge. The `oae-upstream-sync`
  skill should diff these keys.
- **Hostname collision is load-bearing.** The edge works only because its k3s Traefik Ingress wins the
  public Agent host over the (internal-only) native HTTPRoute. If a future sync gives the native route an
  external listener on the same host, the two would contend. Keep `OCC_AGENT_NATIVE_ADMIN_DOMAIN` and the
  edge agents domain in a known relationship (today: identical, edge wins externally).
- **Native-admin could be turned off** to remove the overlap entirely (it was off pre-sync). It is left ON
  so the recovery administrator keeps the native break-glass UI; revisit if the overlap ever bites.
