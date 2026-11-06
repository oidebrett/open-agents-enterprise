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

## ⬜ Strike 1 — OAE as a manidae-cloud package (no product changes)

Goal: deploy OAE exactly as manidae-cloud deploys OCE today, from the fork.

- manidae-cloud: generalise `backend/app/core/deployment/oce.py` so the source
  repository, commit and image digests are parameters; add package
  `OpenAgentsEnterprise` (preview only), cloud and BYOVPS.
- `oae` sits on upstream's newest published-image commit (`54bfa7f`, see
  `OAE.md`), so upstream's controller and runtime images are correct for it. Until
  strike 4 the fork changes no image contents.
- Done when: the BYOVPS script installs OAE on Oracle unattended, the console signs
  in, and an Agent answers.

## ⬜ Strike 2 — Email sign-in and per-Agent access (reuse OCE)

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

## ⬜ Strike 3 — Remote clients for OpenClaw Agents (mobile app)

- The edge also accepts per-person device tokens (issued in OAE, revocable) and
  maps them to the same identity; OpenClaw device pairing through
  `deviceAutoApprove` scopes. Revoking a person also revokes their pairings.
- Done when: the OpenClaw mobile app connects to an OAE Agent from outside, and
  stops working after revocation.

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
