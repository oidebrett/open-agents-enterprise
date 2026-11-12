---
name: oae-upstream-sync
description: Periodically compare Open Agents Enterprise (the `oae` branch) with upstream OpenClaw Enterprise, sort upstream changes into take / replaces-ours / keep-ours-aligned, report what a merge involves, and when asked carry out the merge on a sync branch and verify it on the Oracle testbed (oae-upgrade) before it reaches `oae` and manidae-cloud. Run every week or two, or when upstream publishes new images.
---

# OAE upstream sync

**The goal.** OAE stays as close to OCE as it can while being a superset of it. The shared platform
(control plane, console, IAM, Kubernetes driver, OpenClaw, channels, upgrades) follows upstream;
OAE adds what OCE's OpenClaw-and-OpenAI focus will likely never carry: Hermes, the Claude Code
harness, Claude Gateway, people's access through the edge and `/apps`, the OpenAI-compatible
provider, Teams on Embedded Agents, backups and manidae packaging. Every sync asks three questions
of each upstream change: **take it**, **does it replace something of ours**, and **how do we keep
ours aligned**.

The fork rules are in `OAE.md` (add, don't edit; upstream first; `sync/upstream-*` branches). This
skill applies them. Modes: **report** (default, read-only), then **merge** and **verify on the
testbed** (only when the user asks, after reading a report). The testbed is in
`docs/oae/testbed.md`.

## 1. Report (always first)

```bash
.claude/skills/oae-upstream-sync/upstream-report.sh            # target: newest published-image commit, else upstream/main
.claude/skills/oae-upstream-sync/upstream-report.sh <commit>   # a specific upstream commit
```

It fetches `upstream` and `origin`, then prints (read-only; a throwaway worktree is removed):

- where `oae`, the merge base and `upstream/main` are, and the newest upstream commit with
  **published** controller and runtime images (`ghcr.io/openclaw/openclaw-enterprise-*:sha-*`);
- fork commits upstream now has (same PR number; "identical patch" when the patch IDs match);
- a trial merge: each conflicting file, its hunks, and the fork commits that touched it;
- upstream commits worth reading (security, OIDC/sessions, Kubernetes, Helm, migrations,
  channels, harnesses) and RFCs added or changed.

Turn it into a short note for the user, in plain language, with one table that sorts what matters:

| Class                | Meaning                                                                                                                                  | Action                                                                                                                                                                                    |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Take**             | Upstream fixes and features in the shared platform (security, sign-in, Kubernetes, Helm, migrations, console, OpenClaw)                  | Merge as is                                                                                                                                                                               |
| **Replaces ours**    | Upstream now does something OAE built (e.g. its OIDC Agent chat vs our edge; reusable model providers vs our OpenAI-compatible provider) | Read the RFC and code; if it covers our use, plan to move onto it and retire ours in a follow-up, keeping our extras as a thin layer on top                                               |
| **Keep ours, align** | OAE-only capabilities upstream will not carry (Hermes, Claude Gateway, `/apps`, backups)                                                 | Keep them in OAE-owned files; when upstream changes a seam they use (harness resolver, Compute Driver, trusted-proxy auth), move our hook onto the new seam instead of patching around it |

Then:

1. **Can we move?** `oae` must sit on an upstream commit whose runtime image exists, unless OAE
   builds that runtime image itself (`deploy/oae/runtime-claude` extends upstream's runtime; see
   `OAE.md` "Syncing from upstream"). If the newest published commit is already in `oae`, say so:
   moving further means building the runtime from source too.
2. **What we can drop.** Every fork commit upstream now has. When its patch is identical, the
   conflicts in files only it touched resolve to upstream's version.
3. **What upstream now does that the fork built itself.** Compare the RFC list and fixes with the
   OAE capability table in `OAE.md` (Hermes, Claude harness, Claude Gateway, the edge and `/apps`,
   Teams, OpenAI-compatible provider). Name candidates; don't remove fork code on a guess. Read
   the RFC and the implementing code first.
4. **What we need.** Security and data-loss fixes first, then fixes in areas OAE uses.
5. **Real conflicts.** Files a non-upstream fork commit touched: what each side changed.

## 2. Merge (only when asked)

Never merge into `oae` directly and never during a test window (a deployed or about-to-be-tested
build pins an `oae` commit; check with the user).

```bash
git fetch upstream origin
git checkout main && git merge --ff-only upstream/main && git push origin main
git checkout oae && git pull --ff-only
git checkout -b "sync/upstream-$(git rev-parse --short <target>)"
git merge --no-ff <target>
```

Resolve each conflict by its kind:

| Kind                                                                                                      | Resolution                                                                                                                                                                |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File touched only by fork commits upstream now has (identical patch)                                      | `git checkout --theirs <file>`                                                                                                                                            |
| Upstream file with an OAE dispatch hook (`create.mts`, `configured-harness.ts`, `kubernetes/index.ts`, …) | Take upstream's file, then re-apply the hook from the fork commit (`git show <fork commit> -- <file>`). Keep the hook minimal; move logic into OAE-owned files if it grew |
| OAE-owned file (`docs/oae/`, `deploy/oae/`, `*-hermes.ts`, `claude-gateway.ts`, …)                        | Keep ours; adapt to upstream API changes the compiler reports                                                                                                             |
| Upstream test asserting behaviour OAE changed                                                             | Keep upstream's test and add the OAE case in an OAE test file, never weaken upstream's                                                                                    |
| Migration numbers                                                                                         | An OAE migration must never take upstream's next number (`OAE.md` rule 5)                                                                                                 |

Then verify, in a container from a clean `git archive` (the host may lack the toolchain):

```bash
CI=1 pnpm install --frozen-lockfile
node_modules/.bin/tsc --build tsconfig.json tests/tsconfig.json --pretty false
node --test --test-reporter=tap 'tests/conformance/*.test.{mjs,ts}'
```

Run the same conformance suite on the target upstream commit as well and compare the failing
test names: only failures new on the sync branch count (some tests need SSH, TLS or sockets a
container lacks and fail on both).

Commit the merge listing each resolution, push `sync/upstream-<sha>`, and build its controller and
edge images (multi-arch, pushed by digest; `OAE.md`).

## 3. Verify on the testbed (only when asked)

The Oracle OAE (`docs/oae/testbed.md`). Confirm its address with the user before connecting, and
never touch the AgentGateway beside it.

```bash
# on the box: deploy-by-git, as oae-upgrade does (it fetches the commit itself)
sudo oae-upgrade status
sudo oae-upgrade apply --ref <sync branch sha> --controller <image@sha256:…> --edge <image@sha256:…>
```

Run the testbed's verification checklist (`docs/oae/testbed.md`) and report each item. On any
failure: `sudo oae-upgrade rollback`, fix on the sync branch, repeat. A sync that adds database
migrations cannot be rolled back by images: export the database first (the testbed doc says how).

Only when the checklist passes: `git checkout oae && git merge --ff-only sync/upstream-<sha>`,
push, then in follow-up commits drop fork code the merge made redundant (the "replaces ours"
items, once verified) and update `OAE.md`'s "Base today" line. Then, separately and with the user,
pin the new commit and images in manidae-cloud (`oce.py`) and deploy preprod. Leave the testbed on
the merged version.

## Don'ts

- Don't enable the fork's GitHub Actions (`OAE.md`).
- Don't rewrite or force-push `oae` or `main`.
- Don't pull in an upstream commit without published runtime images unless OAE builds the
  runtime image from that commit.
- Don't bump manidae-cloud's OAE pin until the sync branch passed the testbed checklist.
- Don't reinstall the testbed to test a candidate: `oae-upgrade` keeps its state; reinstall only
  when it is beyond repair (`docs/oae/testbed.md`).
- Don't install `oae-backup` on the testbed: its default folder is the AgentGateway's backups.
