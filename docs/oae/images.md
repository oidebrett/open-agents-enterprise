# OAE images (strike 4)

OAE builds its **own** controller and runtime images from the `oae` branch, so `oae` can sit on
any commit — not only on the commits upstream has published images for. This removes the constraint
in [`OAE.md`](../../OAE.md) "Syncing from upstream" ("`oae` can only sit on such a commit"): the
chart/profile renderer/`occ` CLI (controller) and the Agent runtime now come from *our* build of
the same `oae` commit, so an upstream sync can move to `upstream/main` directly.

## What is built, and from where

Everything is built from this checkout — nothing extends a *published* OCE image:

| Image | Dockerfile | Contents |
| --- | --- | --- |
| `…-controller` | [`Dockerfile`](../../Dockerfile) (target `runtime`) | OCE controller, console, `occ` CLI |
| `…-runtime-base` | [`deploy/runtime/Dockerfile`](../../deploy/runtime/Dockerfile) | OCE Agent runtime; OpenClaw built from the pinned source ([`openclaw-source.json`](../../deploy/runtime/openclaw-source.json)) |
| `…-runtime` | [`deploy/oae/runtime-claude/Dockerfile`](../oae/../../deploy/oae/runtime-claude/Dockerfile) | `runtime-base` + pinned Claude Code + MS Teams |
| `…-runtime-hermes` (opt.) | [`deploy/oae/runtime-hermes/Dockerfile`](../../deploy/oae/runtime-hermes/Dockerfile) | Nous Hermes image + MS Teams (not gated — extends the Nous image, not the OCE runtime) |

The key move: `runtime-claude/Dockerfile` already takes `ARG OCE_RUNTIME_IMAGE`. The build points it
at **our from-source `runtime-base`** instead of upstream's published runtime — no Dockerfile change,
the published-image dependency is simply no longer used.

Registry prefix: `docker.io/oideibrett/open-agents-enterprise-*`, tag `sha-<oae-commit>` (Docker Hub,
to match the manidae-cloud OAE pins and the edge image).

The build reuses upstream's own pins so a sync that bumps them is picked up automatically:
`NODE_BASE_IMAGE` from `scripts/ci/test-suites/images-packaging.json`, and the OpenClaw source
args from `scripts/lib/openclaw-source.mjs build-args`. `SOURCE_DATE_EPOCH` and the revision labels
come from the built commit.

## Building

One script, shared by CI and by-hand runs:

```bash
# local, host arch, no push (single arch --loads the chain end to end)
deploy/oae/images/build-images.sh

# publish multi-arch to Docker Hub
deploy/oae/images/build-images.sh --platform linux/amd64,linux/arm64 --push --tag latest
```

It refuses a dirty tree (the `sha-<commit>` tag and image labels must name a real commit). A
multi-arch build without `--push` is a dry run (built and discarded); the dependent `runtime` layer
is only built when `runtime-base` is materialised (a push, or a single-arch `--load`).

### CI

[`.github/workflows/oae-images.yml`](../../.github/workflows/oae-images.yml) — **OAE-owned**, not one
of upstream's dormant workflows (OAE.md "GitHub Actions"). `workflow_dispatch` only; it never fires
on push. Inputs: `ref` (default `oae`), `push` (off = dry run), `mutable_tag`, `hermes`. Publishing
pushes to Docker Hub, so it needs repo secrets `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN`.

## Resource notes

The `runtime-base` build compiles OpenClaw from source (pnpm install, `build:docker`, `ui:build`,
plus bridge tests) and needs a real builder: ≥ 4 CPU and ≥ 12 GiB RAM (upstream's own threshold).
On a shared host, run it in a `docker-container` buildx builder with a CPU/memory cap and limited
parallelism so it cannot crowd co-resident services:

```bash
printf '[worker.oci]\n  max-parallelism = 1\n' > /tmp/bk.toml
docker buildx create --name oae-capped --driver docker-container \
  --driver-opt cpuset-cpus=0-2 --driver-opt memory=14g --buildkitd-config /tmp/bk.toml --bootstrap
BUILDX_BUILDER=oae-capped deploy/oae/images/build-images.sh --only runtime-base
```

Upstream's CI uses `max-parallelism = 2` on large dedicated runners. On a small shared box (e.g. the
Oracle testbed: 4 vCPU / 23 GiB running the AgentGateway), two heavy Node stages at once exhaust a
14 GiB cap, so use `max-parallelism = 1` — the heavy stages then run one at a time within the cap.

Proven on the Oracle testbed (2026-11-13, native arm64): controller, `runtime-base` (OpenClaw
built from source) and the full `runtime` (Claude Code 2.1.312 + OpenClaw 2026.10.8 + Teams) all
built from the `oae` commit with the capped builder and no impact on the co-resident AgentGateway.
A build box without Node supplies the pins via env (`NODE_BASE_IMAGE`, `OPENCLAW_COMMIT`,
`OPENCLAW_SOURCE_SHA256`, `OPENCLAW_BUILD_TIMESTAMP`).

## After publishing

1. Verify on the Oracle testbed (`docs/oae/testbed.md`) via `oae-upgrade`, pinned to the new images
   by digest.
2. Only then pin the new commit and image digests in manidae-cloud (`oce.py`) and deploy preprod —
   the same release gate as an upstream sync (`oae-upstream-sync` skill, step 3).
