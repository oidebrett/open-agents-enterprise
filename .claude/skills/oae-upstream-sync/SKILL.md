---
name: oae-upstream-sync
description: Check how far Open Agents Enterprise (the `oae` branch) is behind upstream OpenClaw Enterprise, report what a merge involves (conflicts, fork commits upstream now has, relevant fixes and RFCs), and when asked, carry out the merge on a sync branch. Run it periodically (every week or two) or when upstream publishes new images.
---

# OAE upstream sync

The fork rules are in `OAE.md` (add, don't edit; upstream first; `sync/upstream-*` branches). This
skill applies them. Two modes: **report** (default, read-only) and **merge** (only when the user
asks for it after reading a report).

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

Turn it into a short note for the user, in plain language:

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

Commit the merge listing each resolution, push `sync/upstream-<sha>`, build images from it, deploy
to the test box (the Oracle OAE; confirm its address with the user first) and check: console
sign-in, create and deploy an OpenClaw, a Hermes and a Claude Gateway Agent, `/apps`, a phone or
Hermes Desktop connection, one Claude Code session through a gateway. Only then
`git checkout oae && git merge --ff-only sync/upstream-<sha>`, push, and drop fork commits and
docs the merge made redundant in follow-up commits. Update `OAE.md`'s "Base today" line.

## Don'ts

- Don't enable the fork's GitHub Actions (`OAE.md`).
- Don't rewrite or force-push `oae` or `main`.
- Don't pull in an upstream commit without published runtime images unless OAE builds the
  runtime image from that commit.
- Don't bump manidae-cloud's OAE pin until the sync branch is deployed and checked.
