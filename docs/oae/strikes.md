# OAE strikes

Each strike ends with something deployed and checked on the test box (the Oracle
BYOVPS) through the real install path, not a hand-built cluster. Cheap,
high-value strikes come first; the expensive fork-only work (Hermes as an Agent
kind) comes after we know what an upstream sync really costs.

Status: ⬜ not started · 🟨 in progress · ✅ done

## ✅ Strike 0 — Fork foundation

- Fork `openclaw/openclaw-enterprise` → `oidebrett/open-agents-enterprise`;
  `main` mirrors upstream, `oae` is the integration branch.
- Fork rules, sync procedure and Actions policy in [`OAE.md`](../../OAE.md).
- Done when: the fork exists, upstream workflows are dormant, this plan is on `oae`.

## ✅ Strike 1 — OAE as a manidae-cloud package (no product changes)

Goal: deploy OAE exactly as manidae-cloud deploys OCE today, from the fork.

- manidae-cloud: generalise `backend/app/core/deployment/oce.py` so the source
  repository, commit and image digests are parameters; add package
  `OpenAgentsEnterprise` (preview only), cloud and BYOVPS.
- `oae` sits on upstream's newest published-image commit (`54bfa7f`, see
  `OAE.md`), so upstream's controller and runtime images are correct for it. Until
  strike 4 the fork changes no image contents.
- Done when: the BYOVPS script installs OAE on Oracle unattended, the console signs
  in, and an Agent answers.

Result (2026-11-06): manidae-cloud branch `oae/strike-1-package` (`14a5b168`):
`EnterpriseSource` per package in `oce.py`, package `OpenAgentsEnterprise` on the
same code path as OCE (tests `backend/tests/test_oae_package.py`). On Oracle the
install block ran unattended in ~3 minutes from `oae@bb04e33`; console at
`https://oae.ag-6a4baf8a.nemoclaw.dpdns.org/console/` (Let's Encrypt), password
sign-in through the public URL, Agent `oae-test` (a hosted OpenAI-compatible model, created
from the CLI) answered.

Finding — co-hosted host Traefik: the install's console route targets
`http://127.0.0.1:18480`, which assumes a host-network Traefik (manidae's own boxes).
Oracle's Traefik shares Pangolin's Gerbil network namespace on the `agentgateway`
bridge, so it got 502. Fixed on the box only: `oae-console-forward.service`
(socat `172.20.0.1:18480` → `127.0.0.1:18480`) and the route URL repointed. The
per-Agent routes written by `oce-agent-routes` have the same assumption. Before a
BYOVPS customer with an existing Pangolin stack can use the package, the install
must detect the Traefik container's network and route through its gateway (to do,
with strike 2's edge, which needs the same plumbing).

## ✅ Strike 2 — Email sign-in and per-Agent access (reuse OCE)

Goal: people sign in with their email identity and reach only their Agents.

- OCE sign-in: generic OIDC provider (`docs/reference/authentication.md`, RFC 0001)
  against our identity provider; administrator links each person's `(iss, sub)`.
- Per-Agent grants (RFC 0010) as the source of truth; keep the gateway's
  `trustedProxy.allowUsers` / `identityScopes` in step with them.
- Agent UI for non-admins: native admin UI is refused under OIDC, so use the
  documented external-ingress pattern instead: an edge (host Traefik/Envoy) with
  forward-auth that admits the OCE session, checks the Agent grant through OCC and
  sets `x-occ-identity`. Edge strips client-supplied identity headers; gateway
  `trustedProxies` = the edge only.
- Done when: a non-admin email user signs in, sees only their granted Agents and
  chats in an Agent's own UI; an ungranted user is refused.

Progress (2026-11-06):

- ✅ **Central Keycloak** ([`deploy/oae/central-sso/`](../../deploy/oae/central-sso/README.md)):
  Keycloak 26.7.5 (OCE's CI version, `start` mode) + PostgreSQL, published as
  `https://keycloak.mcpgateway.online` through Pangolin/newt. One realm and confidential client per
  installation (`oae-realm.sh`), configured as `oidc-keycloak.md` requires. Chosen over a Keycloak
  per VPS: same code path as a customer's own IdP, lighter VPSs, one place for demo users.
- ✅ **Oracle OAE on OIDC**: realm `oae-oracle`; profile re-rendered with `controlPlane.oidc` +
  `recoveryUserId` (native admin turned off, as OCE requires); `occ-oidc-login` Secret; `helm
  upgrade`. Browser test: console → Keycloak → callback → signed in as `oae-demo@…`, who sees no
  Namespaces (no grants yet). Password sign-in for the recovery admin still works.
- ✅ Grants: OCE Namespace Roles + AccessBindings (`docs/guides/topics/iam.md`), not native-admin
  sharing. Browser check as the SSO user: lists only the granted Agent; the other Agent, IAM
  roles → 403; Secrets list filtered to none; revoke takes effect immediately.
- ✅ Helpers: [`deploy/oae/bin/oae-user`](../../deploy/oae/bin/oae-user) on the OAE box
  (`add` account + SSO identity, `grant user|operator`, `revoke`, `show`, `list`; writes run under
  the recovery administrator's session for audit) and
  [`central-sso/oae-sso-user.sh`](../../deploy/oae/central-sso/oae-sso-user.sh) on the Keycloak
  side (person + one-time password, prints the `oae-user` commands). Both idempotent.
  Known gaps: grants must be re-run after each deploy (new revision); `operator` still needs
  `operate` on the Agent's Secrets from an administrator; OCE has no account list, so `oae-user`
  keeps `/opt/oce/prod/oae-users.json`.
- ✅ Installer (manidae-cloud branch `oae/strike-2-installer`, `f3693d84` + `05d5f8e6`): SSO via
  `EnterpriseOidc` (hidden `oae_oidc_*` package fields; Keycloak endpoints derived; customer IdPs
  take explicit URLs), activated in OCE's order (Secret → recovery admin ID from a real session →
  re-render → helm upgrade); native-admin helpers stand down under SSO; `oae-user` installed from
  the checkout; button "Continue with SSO"; co-hosted Traefik detected (by image, following a
  shared network namespace) and forwarded; BYOVPS reuses an existing :443 proxy. Fresh unattended
  install on Oracle with SSO: 0 warnings, then an Agent from the CLI + `oae-user add/grant` + browser
  SSO sign-in showed exactly the granted Agent. The run exposed a detection bug (`grep -q` under
  pipefail), fixed and re-verified on the box. Not yet automated: creating the Keycloak realm/client
  from the manidae backend at deploy time (done by hand with `oae-realm.sh`).
- ✅ Edge for Agent UIs: OCE's human ingress (upstream #3049 cherry-picked; our controller image on
  Docker Hub) + `oae-edge` (sign-in/authz service, per-Agent routes, exact-peer NetworkPolicy,
  gateway identities). Verified in a browser on Oracle: SSO → Agent UI connected as the person →
  chat answered; revoke → No access. Details: [`edge-design.md`](edge-design.md). Installed by
  manidae (fresh unattended install verified on Oracle).

## ✅ Strike 3 — Remote clients for OpenClaw Agents (mobile app)

- App device tokens through the edge: `oae-user device add EMAIL [AGENT] [LABEL]` prints a
  revocable token once (only its SHA-256 is stored), the Agent's
  `wss://agent-<hash>.agents.<host>/d/oaed_<token>` URL and a pairing QR / setup code
  (`openclaw qr --url`; the setup code keeps the path and is labelled trusted-proxy / full access).
  OpenClaw's Android and iOS apps dial the URL path as the gateway context path; the edge checks
  the token from `X-Forwarded-Uri` (allowed → the person's identity and scopes; unknown → 401;
  ungranted → 403) and strips `/d/<token>` before the gateway.
- Verified on Oracle: an OpenClaw WebSocket client (`openclaw gateway health --url wss://…/d/…`)
  connected through the edge as the person; a wrong token → 401; `device revoke` → 401 within
  ~30 s. Token activation takes up to ~2 min (Secret propagation to the edge Pod).
- ✅ Real phone (2026-11-06): Pixel 9a, OpenClaw Android 2026.10.90, scanned the QR on a fresh
  manidae install. Both app connections (operator/chat and node) authenticated as
  `oae-oracle:<sub>` via the edge (`auth=trusted-proxy`); chat works.
- Node access is an administrator's decision: the app's node pairing (the Agent using the phone:
  notifications, contacts search, calendar read, motion, push-to-talk) needs `operator.pairing`,
  which person grants never include. `oae-user device nodes AGENT` lists requests;
  `device approve-node AGENT REQUEST` shows the commands and permissions and asks;
  `device remove-node` undoes it.
- Setup codes use `openclaw qr --limited` ("Access: limited"): pairings never carry
  `operator.admin`.
- App-token paths are kept out of host Traefik access logs: a per-Agent `PathPrefix(/d/)` router with
  `observability.accessLogs: false` (Traefik ≥ 3.1; verified: token requests not logged, browser
  requests still logged for CrowdSec).

## 🟨 Strike 4 — OAE images and the Claude harness for OpenClaw

**Claude Code harness — done 2026-11-07** (branch `feat/oae-claude-harness`): OpenClaw's built-in
`claude-cli` backend instead of an acpx PR; Console Provider Anthropic → Harness Claude Code;
runtime image = OCE runtime + pinned Claude Code with an admin-managed `apiKeyHelper`. Embedded
only; Dedicated Claude Code Pod not built. See `docs/oae/claude-harness.md`. Images from `oae`
via CI (`oae-images.yml`) still open.

- **OAE images — in progress** (branch `strike/4-oae-images`): [`docs/oae/images.md`](images.md).
  Controller and runtime are built **from source** at the `oae` commit, so `oae` no longer needs an
  upstream *published*-image commit (removes the gate in `OAE.md` "Syncing from upstream"). The
  runtime is `deploy/runtime/Dockerfile` (OpenClaw from the pinned source) with Claude Code + Teams
  layered via `runtime-claude`'s existing `ARG OCE_RUNTIME_IMAGE` — pointed at our from-source base
  instead of a published image. One shared build path (`deploy/oae/images/build-images.sh`) used by
  `.github/workflows/oae-images.yml` (OAE-owned, `workflow_dispatch`, publishes multi-arch to
  `docker.io/oideibrett/open-agents-enterprise-*`, tag `sha-<commit>` — Docker Hub, to match the
  manidae-cloud pins and the edge image).
  - ✅ All three images built from source and verified on the Oracle testbed (2026-11-13, native
    arm64), with a capped `docker-container` builder (`max-parallelism=1`, 3 CPU, 14 GiB) and no
    impact on the co-resident AgentGateway: controller (Node 24.22.1, 64 migrations); `runtime-base`
    (OpenClaw 2026.10.8 from source, codex 0.163.0-alpha.2, provenance matches the pin); `runtime`
    (Claude Code 2.1.312 + OpenClaw + Teams). The trial fixed two bugs in `build-images.sh` (serialize
    heavy stages to avoid OOM; layer builds use their own dir as context).
  - ⬜ First real **publish**: run `oae-images.yml` with `push` (multi-arch to Docker Hub). Belongs in CI /
    a dedicated build box, not the live testbed.
  - ⬜ manidae package switches to the OAE images; verify on Oracle via `oae-upgrade`, then pin the
    digests in manidae (release gate).
- Upstream track: RFC for a `claude` harness (model on RFC 0003/0005); OpenClaw PR
  adding `claude` to `ACPX_NATIVE_AGENT_IDS` and a remote (WebSocket) transport to
  `acpx`.
- OAE: harness `claude`/`dedicated`; a harness Pod running Claude Code +
  `@agentclientprotocol/claude-agent-acp` behind an authenticated WebSocket ACP
  server (same capability-token scheme as `codex app-server --listen`); Anthropic
  API key via the existing `api_key` / `credential_source` bindings; egress to
  `api.anthropic.com`. Open design point: OpenClaw tools across Pods (acpx passes
  them as local stdio MCP servers today).
- Done when: an OpenClaw Agent's turns run in Claude Code in its own Pod, with
  approvals coming back to the gateway.

## 🟨 Strike 5 — Hermes as an Agent kind

Phased (user decision 2026-11-06): **5a** proves the Hermes workload next to OCE with a thin
harness; **5b** makes `hermes` a native OCE Agent kind (the goal: Hermes inside OCE, with per-Agent
grants, revisions, audit and the console).

### 🟨 5a — Hermes next to OCE (branch `strike/5a-hermes`)

Superseded by 5b; its `oae-hermes` tool was removed in 5c (manidae never installed it).

- `deploy/oae/hermes/oae-hermes create|list|delete`: official `nousresearch/hermes-agent:v0.23.0`
  (by digest), one container per agent in namespace `oae-hermes` (`gateway run` with
  `HERMES_DASHBOARD=1`, dashboard on 9119; two containers left the dashboard blind to the
  gateway), seeded `config.yaml` (model provider, `trusted_proxies`, `public_url`), model key and
  dashboard session token in a Secret, NetworkPolicy admitting only k3s Traefik.
- Access is OCE IAM: a Namespace Role per Hermes agent (`OAE Hermes user|operator: NAME`, via
  `oae-user grant|revoke`); 5b replaces it with per-Agent bindings.
- Edge: `hermes-<hash>.agents.<host>`; for granted people `oae-edge-authz` injects
  `Authorization: Bearer <session token>` (Hermes's own deployment-token gate: web UI and API).
- ✅ Browser end to end on Oracle as the SSO demo user: dashboard authenticated "via session-token",
  chat over WebSocket answered (a hosted OpenAI-compatible model).
- ⬜ Hermes Desktop through `oae-user device add EMAIL HERMES` (needs the user's Desktop app).

### ✅ 5b — Hermes as a native OCE Agent runtime (branch `strike/5b-hermes-kind`)

Design change from the plan: Hermes is an Agent **runtime** (`agentRuntime.id: "hermes"`, embedded),
not a configuration kind. Migration 0006 pins `CHECK(kind='agent')` and OCE's migration history is
strictly linear (receipts must equal the canonical history), so a fork migration would block every
later upstream sync. A runtime needs no schema change.

- Upstream files touched (3, small): `packages/occ/src/configured-harness.ts` (allowlist
  `hermes`), `apps/controller/src/composition/production-harness.ts` (descriptor `hermes@1.0.0`,
  embedded), `apps/controller/src/composition/installation-config.ts` (wraps the Kubernetes driver).
- New `apps/controller/src/drivers/compute/kubernetes/hermes.ts`: `withHermesRuntime(driver)`
  sends `hermes` revisions to `HermesWorkloads`; everything else reaches the stock driver unchanged.
  Per Agent, in its tenant namespace: Secret `hermes-<h>-env` (model key copied, uid-checked, from
  the revision's Harness authentication Secret; stable dashboard session token), ConfigMap
  `-seed`, PVC `-data`, Deployment, Service :9119, NetworkPolicy (ingress only from k3s Traefik;
  egress DNS + public 443). Model: Anthropic, OpenAI (`api.openai.com`, as Hermes's
  `openai-api`), or since 5c any OpenAI-compatible endpoint (Hermes's `custom`).
- Fits OCE's guard rails as they are:
  - The worker Role may create/replace Secrets but not patch them, so the Secret is not
    server-side applied.
  - Tenant namespaces enforce Pod Security `restricted`. Hermes runs as uid 10000 with no
    privilege escalation, all capabilities dropped and RuntimeDefault seccomp. s6-overlay gets an
    in-memory `/run` (`S6_YES_I_WANT_A_WORLD_WRITABLE_RUN_BECAUSE_KUBERNETES=1`).
  - Hermes wants a home it owns with mode 0700, and local-path ignores `fsGroup`. The init
    container makes `home/` on the volume and mounts it at `/opt/data` via subPath. The image has
    no PyYAML, so the seed merge uses Hermes's ruamel.
- Edge: a Service labelled `oae.dev/runtime=hermes` gets Hermes middlewares and its token from
  `<svc>-env`. Access is the Agent's own OCE grants (`oae-user grant EMAIL AGENT`, same as
  OpenClaw). `oae-user device add` prints the Hermes Desktop URL.
- Checks:
  - Typecheck passes.
  - The six suspect conformance files pass.
  - ✅ On Oracle (controller `sha256:b6738bd2…`, Agent `hermes-native`), revisions deploy
    `succeeded` and in-pod `hermes chat` answers.
  - ✅ Browser as the SSO demo user: Keycloak → edge → dashboard "via session-token" → chat
    answered (a hosted OpenAI-compatible model).
- ✅ Console: the create form offers **Hermes** (always Embedded, API key for OpenAI or Anthropic).
  Codex and OpenClaw paths are unchanged. Console browser tests: `console-agents` 31/31 and
  `console-create-agent-provisioning-400` 53/53, the same as baseline. Other OpenAI-compatible
  endpoints were CLI-only until 5c.
- ✅ Full conformance on the final runtime commit: 3147 tests, 37 failures, all in the unmodified
  baseline's set (SSH/`gh` environment); none only with 5b.
- On Oracle: controller `sha256:5851316c…` (commit `a3d33210`).
- ✅ Merged into `oae` (`baf79dd3`). Fix `037693e3`: `oae-user grant` exited silently on a box
  without the 5a registry.
- ✅ manidae branch `oae/strike-5-hermes` pins `037693e3`, controller `sha256:5851316c…` and
  edge `sha256:b9d1bb87…`.
- ✅ Fresh unattended install on Oracle from those pins (2026-11-07): 0 warnings, and
  AgentGateway was untouched. OpenClaw `oae-test` and native Hermes `hermes-test` both answered,
  and the SSO demo user, granted on both, chatted with Hermes in the browser and connected to
  OpenClaw.
- ⬜ Hermes Desktop (user).
- Known:
  - `dashboard.public_url` is only set when the controller has `OAE_INSTALLATION_ID` and
    `OAE_EDGE_AGENTS_DOMAIN`. Hermes otherwise trusts Traefik's X-Forwarded headers, which works.
  - `s6-applyuidgid: unable to set supplementary group list` at start is harmless (nothing to
    drop).

## 🟨 5c — OpenAI-compatible model provider (branch `feat/openai-compatible-provider`)

Upstream candidate: generic, names no model vendor, adds no server contract.

- Console Provider gains **OpenAI-compatible**: Base URL (HTTPS, ending `/v1`) + model ID
  (entered; there is no list) + API key Secret. It writes OpenClaw's existing `openai` provider
  with that `baseUrl` and `api: "openai-completions"`, which Embedded OpenClaw already runs.
  Embedded only and no Codex, like Anthropic (Dedicated OpenClaw keeps `api.openai.com` for API
  keys). It is chosen, never inferred: a Preset or JSON edit with its own OpenAI `baseUrl` stays
  OpenAI, so upstream's custom-transport paths are unchanged.
- Hermes: any endpoint other than `api.openai.com` is Hermes's `custom` provider: `base_url` in
  `config.yaml`, key in `OPENAI_API_KEY` with `OPENAI_BASE_URL` naming the same URL, which is the
  only way Hermes sends that key to another host. The vendor-specific Hermes mapping is gone.
- The vendor-specific 5a `oae-hermes` tool is removed; OAE names no model vendor.

## 🟨 Hardening — access without a shell (branch `feat/oae-hardening`)

Same capabilities as before, in OCE's security pattern (details:
[`edge-design.md` § Access without a shell](edge-design.md#access-without-a-shell-hardening-branch-feat-oae-hardening)):

- Console **People** panel (Agent → Access): give/remove access by email, made with the
  administrator's own OCE session (audited as them), replacing `oae-user` on the server.
- **`/apps`** on the edge: each person connects their own OpenClaw mobile app (QR / setup code) or
  Hermes Desktop; tokens bound to one Agent; replaces `oae-user device add` and `kubectl exec`.
- Node approvals in the Agent's own Devices page (`operator.pairing` for operators).
- The edge keeps its records in two Secrets only it may write; Agents no longer receive the edge
  session cookie; Keycloak lookups through a read-only directory client.
- `oae-user` is break-glass only.

## ⬜ Strike 6 — Hermes on the Codex and Claude harness Pods

- Upstream PR to Hermes: WebSocket transport for its Codex app-server client, so
  Hermes reuses OCE's Codex harness Pod unchanged.
- Then Hermes on the Claude harness Pod (needs a persistent-session ACP client).

## ⬜ Strike 7 — Productise

- manidae package out of preview; upgrade and sync runbook; divergence audit
  listing every upstream file OAE touches.

## ✅ Strike 8 — RFC-0031 native browser chat: proof and coexistence (investigation)

Prompted by the first upstream sync (`a71a4289`), which enabled upstream's
[RFC-0031](../../specs/rfcs/0031-oidc-agent-chat.md) native agent-chat under OIDC. Question: adopt the
native cookie path for the **browser** Agent-UI slice (retiring our edge's browser forward-auth there),
keeping the rest of the edge (device/mobile pairing, Claude Gateway VPN, People panel, `/apps`)? Proof of
concept only (works + gaps + plan). Full finding: [`native-chat-rfc0031.md`](native-chat-rfc0031.md).

Finding (branch `strike/8-native-chat`, add-only: `docs/oae/native-chat-rfc0031.md` +
`deploy/oae/edge/oae-native-chat-check`; no upstream file edited). Verified on Oracle
(controller `sha256:03ae9843…`, runtime `sha256:8440e412…`):

- **Q1 — native cookie chat end to end? No at the public host.** The native-admin domain
  (`OCC_AGENT_NATIVE_ADMIN_DOMAIN=agents.oae.ag-…`) is **identical** to the edge's agents domain, so the
  public Agent host collides. The native Envoy `HTTPRoute` binds the **internal** `occ-gateway-…svc`
  host; the **public** host is served only by the edge's k3s Traefik Ingress (curl → 401 from
  `oae-edge-authz`). So a browser following the native "Open chat" URL still hits the edge. On the live
  (ungranted) Agent the native-chat route isn't even generated — `deviceAutoApprove` is absent, so
  `usesWritableNativeAdminConfig=false` and `getGatewayChatEndpoint=undefined` (admin route only). A
  **granted** OAE Agent *does* qualify (`oae-edge` sets `deviceAutoApprove.enabled=true`), so the
  native-chat route co-generates in-cluster — just shadowed by the edge Ingress.
- **Q2 — runtime has qualified chat enforcement? Yes.** Pinned OpenClaw `2026.10.10`; `operator-scopes.md`
  ships in-image; `operator.sessions.write` is a distinct enforced level vs `operator.admin`;
  `trustedProxy.requiredHeaders` includes `x-openclaw-scopes`, enforced at the listener. (A direct
  per-method WS intersection probe was left to upstream's RFC-0031 qualification of the same runtime.)
- **Q3 — edge grant vs the chat ceiling.** Edge maps `user→operator.read,write` and
  `operator→+operator.approvals,pairing`. The native chat ceiling `operator.sessions.write` **excludes
  approvals and pairing** and is narrower than `operator.write`; the only native rung above it is
  `operator.admin` (full admin). No native equivalent to OAE's "operator" grant.
- **Q4 — coexistence.** Device/VPN/People/apps are disjoint from the native path and unaffected; the one
  interaction is overlapping writes to `gateway.controlUi`/`trustedProxy`/`identityScopes` by the
  controller (native) and `oae-edge sync` — agree today, watch on future syncs.

**Recommendation: keep the browser slice on the edge.** Native adoption would require re-architecting the
Agent-host ingress to Envoy, drop per-person gateway identity for the shared `occ-workspace-files`, and
lose operator approvals/pairing. Net downgrade. Revisit if upstream adds per-person native identity on the
chat route and a native scope between `operator.sessions.write` and `operator.admin`. Native-admin is left
**on** so the recovery administrator keeps the native break-glass UI.

- ✅ **Confusing second button addressed** (`apps/controller/src/console/agents/oae-native-admin-gate.mts`
  plus a one-line hook in `detail.mts`): on an OIDC install the native **Open Agent UI** / **Open chat**
  button shows only to `administer` holders (recovery-admin break-glass); `operate` users see just OAE's
  edge **Open Agent**. Non-OIDC installs keep upstream's behaviour. Client-side visibility only;
  native-admin stays enabled on the server. Typecheck + eslint clean.
- `oae-native-chat-check [agent-id]` reports the two gates and whether the `/native-chat` route is live,
  read-only, for any Agent on an OAE/SSO install.
- Not done (out of PoC scope): live browser SSO chat as `oae-demo` (needs the user's credentials; no user
  is currently granted on the testbed), and the direct per-method WS scope-intersection probe.
