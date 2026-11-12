#!/usr/bin/env bash
# Build OAE's own controller and runtime images from the `oae` checkout, so OAE no
# longer depends on upstream having *published* images for a commit (OAE.md "Syncing
# from upstream"; docs/oae/images.md; strike 4).
#
# Three images, all from this checkout:
#   runtime-base  deploy/runtime/Dockerfile          OCE Agent runtime, OpenClaw built from the
#                                                     pinned source (deploy/runtime/openclaw-source.json)
#   runtime       deploy/oae/runtime-claude/Dockerfile  = runtime-base + pinned Claude Code + MS Teams
#   controller    Dockerfile (target: runtime)        OCE controller / console / occ CLI
# (runtime-hermes extends the Nous Hermes image, not the OCE runtime, so it is not gated and is
#  built only with --hermes.)
#
# The runtime layer re-uses runtime-claude's existing ARG OCE_RUNTIME_IMAGE: we point it at the
# runtime-base we just built instead of upstream's published runtime. No Dockerfile changes needed.
#
# Defaults build locally for the host arch and DO NOT push. CI (.github/workflows/oae-images.yml)
# calls this with --push --platform linux/amd64,linux/arm64.
#
# Usage:
#   deploy/oae/images/build-images.sh [options]
#     --registry REF   image name prefix (default: ghcr.io/oidebrett/open-agents-enterprise)
#     --platform LIST  buildx platforms (default: host arch; CI passes linux/amd64,linux/arm64)
#     --push           push the final images (and the runtime-base) to the registry by digest
#     --only LIST      build only these (comma list of: controller,runtime,hermes); default
#                      controller,runtime. "runtime" implies its runtime-base.
#     --hermes         shorthand to add hermes to the build set
#     --tag TAG        extra mutable tag alongside sha-<commit> (e.g. latest)
#     -h|--help
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
cd "$repo"

registry="ghcr.io/oidebrett/open-agents-enterprise"
platform=""
push=0
hermes=0
extra_tag=""
only=""

while [ $# -gt 0 ]; do
  case "$1" in
    --registry) registry="$2"; shift 2 ;;
    --platform) platform="$2"; shift 2 ;;
    --push) push=1; shift ;;
    --only) only=",$2,"; shift 2 ;;
    --hermes) hermes=1; shift ;;
    --tag) extra_tag="$2"; shift 2 ;;
    -h|--help) awk 'NR>1 && /^[^#]/{exit} NR>1{sub(/^# ?/,"");print}' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

# want NAME -> is NAME in the build set? With --only, exactly that list (validated here). Without,
# the default set is controller,runtime plus hermes when --hermes is given. $only is comma-wrapped
# (",controller,runtime,") so a substring test for ",NAME," is exact.
if [ -n "$only" ]; then
  for tok in $(printf '%s' "$only" | tr ',' ' '); do
    case "$tok" in
      controller|runtime|runtime-base|hermes) ;;
      *) echo "unknown --only image: $tok (choose from controller,runtime,runtime-base,hermes)" >&2; exit 2 ;;
    esac
  done
fi
# want NAME: controller|runtime|runtime-base|hermes. "runtime-base" selects only the from-source
# base (no Claude layer) — used to validate the heavy build in isolation. "runtime" implies the base.
want() {
  if [ -n "$only" ]; then case "$only" in *",$1,"*) return 0 ;; *) return 1 ;; esac; fi
  case "$1" in
    controller|runtime) return 0 ;;
    hermes) [ "$hermes" = 1 ] ;;
    *) return 1 ;;
  esac
}
# build the from-source base when either the full runtime or the base alone is wanted
want_base() { want runtime || want runtime-base; }

command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }
docker buildx version >/dev/null || { echo "docker buildx is required" >&2; exit 1; }

# The build must run on a clean, committed tree: the image revision labels and the sha-<commit> tag
# name the commit, and a dirty tree would mislabel the image.
if [ -n "$(git status --porcelain)" ]; then
  echo "refusing to build from a dirty tree; commit or stash first" >&2
  exit 1
fi

commit="$(git rev-parse HEAD)"
short="$(git rev-parse --short HEAD)"
source_date_epoch="$(git show --no-patch --format=%ct "$commit")"

# Pins shared with upstream's own build (container-check.yml), read from the same sources so an
# upstream sync that bumps them is picked up automatically. A build box without Node can supply
# them directly: NODE_BASE_IMAGE, and (for the runtime) OPENCLAW_COMMIT / OPENCLAW_SOURCE_SHA256 /
# OPENCLAW_BUILD_TIMESTAMP.
have_node=0; command -v node >/dev/null && have_node=1
node_base_image="${NODE_BASE_IMAGE:-}"
if [ -z "$node_base_image" ]; then
  [ "$have_node" = 1 ] || { echo "no Node and no NODE_BASE_IMAGE env" >&2; exit 1; }
  node_base_image="$(node -p 'require("./scripts/ci/test-suites/images-packaging.json").prepare.defaultEnv.NODE_BASE_IMAGE')"
fi
[[ "$node_base_image" =~ ^[^[:space:]]+@sha256:[a-fA-F0-9]{64}$ ]] \
  || { echo "NODE_BASE_IMAGE is not pinned by digest: $node_base_image" >&2; exit 1; }

# OpenClaw source pin: only needed for the runtime build. Env first, else Node.
openclaw_args=()
if want_base; then
  if [ -n "${OPENCLAW_COMMIT:-}" ]; then
    openclaw_args=("OPENCLAW_COMMIT=$OPENCLAW_COMMIT" \
      "OPENCLAW_SOURCE_SHA256=${OPENCLAW_SOURCE_SHA256:?set OPENCLAW_SOURCE_SHA256 with OPENCLAW_COMMIT}" \
      "OPENCLAW_BUILD_TIMESTAMP=${OPENCLAW_BUILD_TIMESTAMP:?set OPENCLAW_BUILD_TIMESTAMP with OPENCLAW_COMMIT}")
  else
    [ "$have_node" = 1 ] || { echo "runtime build needs Node or OPENCLAW_COMMIT/SOURCE_SHA256/BUILD_TIMESTAMP env" >&2; exit 1; }
    while IFS= read -r line; do openclaw_args+=("$line"); done < <(node scripts/lib/openclaw-source.mjs build-args)
  fi
fi

echo "OAE images from $short ($commit)"
echo "  registry:        $registry"
echo "  platforms:       ${platform:-<host arch>}"
echo "  node base:       $node_base_image"
echo "  openclaw source: ${openclaw_args[0]:+${openclaw_args[0]#OPENCLAW_COMMIT=}}${openclaw_args[0]:-<not building runtime>}"
echo "  push:            $([ "$push" = 1 ] && echo yes || echo 'no (local only)')"
echo

platform_args=()
[ -n "$platform" ] && platform_args=(--platform "$platform")

# Pushes go to the registry by digest. A single-arch local build loads into the engine so it can be
# run. A multi-arch build cannot --load, so without --push it is built and discarded — a dry run
# that validates the Dockerfiles across both arches without publishing anything.
#
# The OAE runtime layer (step 3) needs runtime-base to exist as an image: available when we push it
# (by digest) or when a single-arch build --loads it, but NOT in a multi-arch discard dry run. Skip
# that one layer there; the self-contained images (controller, runtime-base, hermes) still build.
base_available=1
if [ "$push" = 1 ]; then
  output_args=(--push)
elif [[ "$platform" == *,* ]]; then
  output_args=() # multi-arch dry run: build, keep nothing
  base_available=0
  echo "multi-arch without --push: dry run (images built and discarded; runtime layer skipped)"
else
  output_args=(--load)
fi

common_labels=(
  --label "org.opencontainers.image.source=https://github.com/oidebrett/open-agents-enterprise"
  --label "org.opencontainers.image.revision=$commit"
)

tags_for() { # name -> echo -t flags (sha-<commit>, plus optional mutable tag)
  local name="$1"
  echo "-t ${registry}-${name}:sha-${short}"
  [ -n "$extra_tag" ] && echo "-t ${registry}-${name}:${extra_tag}"
}

# 1. Controller (from source; independent of the runtime).
if want controller; then
  echo "==> controller"
  # shellcheck disable=SC2046
  docker buildx build \
    "${platform_args[@]}" \
    -f Dockerfile --target runtime \
    --build-arg "NODE_BASE_IMAGE=$node_base_image" \
    --build-arg "OCC_BUILD_REVISION=$commit" \
    --build-arg "SOURCE_DATE_EPOCH=$source_date_epoch" \
    "${common_labels[@]}" \
    $(tags_for controller) \
    "${output_args[@]}" \
    .
fi

# 2 + 3. Runtime: build runtime-base (OCE runtime, OpenClaw from pinned source) first, then layer
#    the OAE runtime on top of it. On --push the base is published by its own name so the layer can
#    reference it by digest; locally it is --loaded and referenced by tag.
base_ref="${registry}-runtime-base:sha-${short}"
if want_base; then
  echo "==> runtime-base"
  # shellcheck disable=SC2046
  docker buildx build \
    "${platform_args[@]}" \
    -f deploy/runtime/Dockerfile \
    --build-arg "NODE_BASE_IMAGE=$node_base_image" \
    --build-arg "${openclaw_args[0]}" \
    --build-arg "${openclaw_args[1]}" \
    --build-arg "${openclaw_args[2]}" \
    --build-arg "OCC_BUILD_REVISION=$commit" \
    --build-arg "SOURCE_DATE_EPOCH=$source_date_epoch" \
    "${common_labels[@]}" \
    -t "$base_ref" \
    "${output_args[@]}" \
    .
fi

# OAE runtime = runtime-base + Claude Code + MS Teams (runtime-claude/Dockerfile's existing
# ARG OCE_RUNTIME_IMAGE, here pointed at our from-source base rather than a published image).
# Built only for the full "runtime" target (not bare "runtime-base"), and only when the base is
# materialised (a push, or a single-arch --load; not a multi-arch discard dry run).
if want runtime; then
  if [ "$base_available" = 1 ]; then
    echo "==> runtime (claude harness)"
    # Context is the layer dir: its Dockerfile COPYs claude-wrapper from beside itself, not from
    # the repo root (unlike the controller and runtime-base builds).
    # shellcheck disable=SC2046
    docker buildx build \
      "${platform_args[@]}" \
      -f deploy/oae/runtime-claude/Dockerfile \
      --build-arg "OCE_RUNTIME_IMAGE=$base_ref" \
      "${common_labels[@]}" \
      $(tags_for runtime) \
      "${output_args[@]}" \
      deploy/oae/runtime-claude
  else
    echo "==> runtime (claude harness): SKIPPED (multi-arch dry run; needs --push or single --platform)"
  fi
fi

# 4. OAE Hermes (optional; not gated — extends the Nous image).
if want hermes; then
  echo "==> runtime-hermes"
  # shellcheck disable=SC2046
  docker buildx build \
    "${platform_args[@]}" \
    -f deploy/oae/runtime-hermes/Dockerfile \
    "${common_labels[@]}" \
    $(tags_for runtime-hermes) \
    "${output_args[@]}" \
    deploy/oae/runtime-hermes
fi

echo
built=""
want controller && built="$built ${registry}-controller:sha-${short}"
want_base && built="$built ${registry}-runtime-base:sha-${short}"
want runtime && built="$built ${registry}-runtime:sha-${short}"
want hermes && built="$built ${registry}-runtime-hermes:sha-${short}"
echo "done:$built"
[ "$push" = 0 ] && echo "(local only; re-run with --push to publish)"
