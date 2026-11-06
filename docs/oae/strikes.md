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
sign-in through the public URL, Agent `oae-test` (NVIDIA Nemotron via
`oce-nvidia-agent`) answered.

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
  install on Oracle with SSO: 0 warnings, then `oce-nvidia-agent` + `oae-user add/grant` + browser
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

## ⬜ Strike 4 — OAE images and the Claude harness for OpenClaw

- `oae-images.yml`: build and publish controller and runtime images from `oae` to
  `ghcr.io/oidebrett/open-agents-enterprise-*` (amd64 + arm64); manidae package
  switches to them.
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

## ⬜ Strike 5 — Hermes as an Agent kind (embedded)

- `CONFIGURATION_KINDS` gains `hermes`; Hermes configuration type and validators
  in new files; Kubernetes Compute dispatches to a new Hermes workload module;
  pinned Hermes runtime image.
- Gateway auth: Hermes behind the edge's trusted identity (sidecar or upstream
  trusted-header mode — to be designed; Hermes ≥0.18 refuses unauthenticated
  network binds).
- v1 limits: no OCE plugins for Hermes; workspace-file editor off.
- Hermes Desktop through the edge (port of `HERMES_REMOTE_DESKTOP.md`).
- Done when: a Hermes Agent is created in the console, answers on a channel and in
  its dashboard, and Hermes Desktop connects remotely.

## ⬜ Strike 6 — Hermes on the Codex and Claude harness Pods

- Upstream PR to Hermes: WebSocket transport for its Codex app-server client, so
  Hermes reuses OCE's Codex harness Pod unchanged.
- Then Hermes on the Claude harness Pod (needs a persistent-session ACP client).

## ⬜ Strike 7 — Productise

- manidae package out of preview; upgrade and sync runbook; divergence audit
  listing every upstream file OAE touches.
