# Open Agents Enterprise (OAE)

OAE is an independent fork of [OpenClaw Enterprise (OCE)](https://github.com/openclaw/openclaw-enterprise)
(MIT). It is not affiliated with or endorsed by the OpenClaw project. OCE's
[platform design](docs/design.md) remains the architecture; this file records only
what OAE adds and how the fork is kept close to upstream.

## What OAE adds

| Capability | OCE today | OAE adds |
|---|---|---|
| Front door (gateway) | OpenClaw only | Hermes as a second Agent kind |
| Harness behind the gateway | Embedded OpenClaw, dedicated Codex | Dedicated Claude Code; Hermes on the Codex and Claude harness pods |
| People's access to Agents | Password/GitHub/Google/OIDC sign-in; native admin UI for `administer` holders, not under OIDC | Email (OIDC) access to granted Agents' own UIs through an edge that uses OCE's trusted-proxy gateway auth |
| Remote clients | None (gateways are private) | OpenClaw mobile app and Hermes Desktop through the same edge, with per-device tokens |
| Installation | Helm chart and installation profiles | The same, packaged by manidae-cloud for cloud VPS and BYOVPS |

Delivery is split into strikes: [docs/oae/strikes.md](docs/oae/strikes.md).

## Fork rules

The upstream moves at about 140 commits a day. Every line OAE changes in an
upstream file is a recurring merge conflict, so:

1. **Add, don't edit.** New behaviour lives in new files (`*-hermes.ts`,
   `claude-*`, `docs/oae/`, `deploy/runtime-hermes/`, …). Upstream files get only
   the smallest dispatch hook that routes to them.
2. **Use OCE's seams.** Agent kinds go through `CONFIGURATION_KINDS`; harnesses
   through the harness resolver and `AgentRevision.harness`; human access through
   trusted-proxy gateway auth (`x-occ-identity`) and the external-ingress pattern in
   `docs/reference/drivers/kubernetes-compute/gateway-authentication.md`.
3. **Upstream first** for anything generic: the Claude harness (OpenClaw `acpx` and
   OCE), Hermes WebSocket transports (NousResearch/hermes-agent). The fork carries
   it only until it lands.
4. **Fork-only** for Hermes as an Agent kind, the access edge and packaging.
5. **Migrations:** upstream numbers them sequentially (`migrations/00NN_*.sql`,
   drizzle). An OAE migration must never take the next upstream number; see
   strike notes before adding one.
6. **Never** call the fork "OpenClaw Enterprise", and keep upstream's licence and
   attribution.

## Branches and remotes

| Branch | Purpose |
|---|---|
| `main` | Mirror of `upstream/main`. Never commit here. |
| `oae` | Integration branch: upstream plus OAE. Deployed builds come from here. |
| `strike/<n>-<topic>` | Work for one strike; merged to `oae` with `--no-ff`. |
| `sync/upstream-YYYY-MM-DD` | One upstream merge, tested before it lands on `oae`. |

Remotes: `origin` = `github.com/oidebrett/open-agents-enterprise`,
`upstream` = `github.com/openclaw/openclaw-enterprise`.

## Syncing from upstream

`oae` follows upstream's **published-image commits**, not `upstream/main`.
Upstream publishes controller and runtime images only for some commits
(`ghcr.io/openclaw/openclaw-enterprise-{controller,runtime}:sha-<commit>`); those
are its de facto releases. Until OAE builds its own images (strike 4) the chart,
profile renderer and `occ` CLI must come from the same commit as the images, so
`oae` can only sit on such a commit. Base today: `54bfa7f` (images 2026-10-30).

List the published commits (anonymous registry API):

```bash
t=$(curl -s "https://ghcr.io/token?scope=repository:openclaw/openclaw-enterprise-runtime:pull" | jq -r .token)
curl -s -H "Authorization: Bearer $t" \
  https://ghcr.io/v2/openclaw/openclaw-enterprise-runtime/tags/list | jq -r '.tags[]' | grep '^sha-'
```

Merge a newer one:

```bash
git fetch upstream
git checkout main && git merge --ff-only upstream/main && git push origin main
git checkout oae && git checkout -b "sync/upstream-<short sha>"
git merge --no-ff <published sha>     # resolve: keep upstream, re-apply OAE hooks
pnpm install && pnpm lint && pnpm typecheck && pnpm test   # full list: docs/testing/local.md
```

Merge each new published commit soon after it appears; small merges are cheaper.

## GitHub Actions

Upstream's workflows are dormant on the fork (GitHub does not run a fork's
workflows until they are enabled in the Actions tab). **Do not enable them**:
several fire on push, on a schedule or on issues (`clawsweeper-dispatch`), and the
publish workflows target upstream's registry. OAE adds its own `oae-*.yml`
workflows when it needs its own images (strike 4).
