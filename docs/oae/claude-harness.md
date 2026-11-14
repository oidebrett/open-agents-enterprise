# Claude Code as an OpenClaw Agent's harness (OAE)

**Console:** Create Agent → Provider **Anthropic** → Harness **Claude Code**. The Agent runs
OpenClaw's gateway as usual (web UI, phones, channels, `/apps`), and every agent turn goes
through Claude Code instead of OpenClaw's own loop. Verified on Oracle, 2026-11-07, with
`claude-haiku-5-5`: replies, Claude Code's shell, and OpenClaw's tools over MCP.

## How it works

- OpenClaw (2026.10.8 here) ships Claude Code as a **CLI backend**: keep the model as
  `anthropic/<model>` and set the model-scoped `agentRuntime: { id: "claude-cli" }`. OpenClaw
  starts `claude` per session, passes its own tools as an MCP server (`mcp__openclaw__*`), and
  turns off Claude Code's hooks, plugins, auto-memory and scheduling tools. No OpenClaw change was
  needed (the October analysis predates this backend).
- **OCE** (`packages/occ/src/configured-harness.ts`): `claude-cli` is accepted as a model
  runtime for the `anthropic` provider only, and resolves to the **OpenClaw** Harness, since the
  gateway is OpenClaw (OpenClaw: "`claude-cli` is not an embedded harness id"). Placement,
  routing and the edge are therefore OpenClaw's. Conformance test in
  `tests/conformance/configuration-occ.test.mjs`.
- **Console** (`agents/create.mts`): a **Claude Code** option, shown only for Anthropic, always
  Embedded, otherwise treated as OpenClaw. Browser suites assert it.
- **Runtime image** (`deploy/oae/runtime-claude/`): OCE's published runtime image plus a pinned
  `@anthropic-ai/claude-code` (2.1.312), auto-update and non-essential traffic off. Published as
  `docker.io/oideibrett/open-agents-enterprise-runtime-claude`; set as the installation's
  `runtime.image`. Every OpenClaw Agent uses it from its next deployment; it differs from the
  base only by Claude Code.

## The credential: API key or (personal) Claude subscription token

The Agent's credential reaches the gateway as `ANTHROPIC_API_KEY`, through OCE's `api_key`
binding to an Agent-only Secret. OpenClaw deliberately removes `ANTHROPIC_API_KEY` and
`CLAUDE_CODE_OAUTH_TOKEN` when it starts `claude` (Claude CLI keeps native-login semantics), and
passes an empty `--setting-sources`. So the image's `/usr/local/bin/claude` is a wrapper
(`deploy/oae/runtime-claude/claude-wrapper`) that reads the credential from the gateway's own
environment (PID 1, same user) and starts the real binary with:

- an **Anthropic API key** as `ANTHROPIC_API_KEY` (`claude auth status`: `api_key`), billed to API
  credits; or
- a **Claude subscription setup token** (`claude setup-token`, `sk-ant-oat…`) as
  `CLAUDE_CODE_OAUTH_TOKEN` (`oauth_token`), on that person's own Claude plan.

The gateway's own startup probe and utility calls accept either. A wrapper rather than an
`apiKeyHelper`: Claude Code ranks a configured `apiKeyHelper` above a subscription token.

### Personal Agents

A setup token is one person's Claude plan, so such an Agent is for that person only (Anthropic's
consumer terms; OAE also keeps per-person audit). There is no "Sign in with Claude" button:
third-party sign-in with claude.ai accounts is not offered to other products. The person runs
`claude setup-token` themselves and pastes the token as the Agent's API key.

- `oae-edge sync` reads only the prefix of each OpenClaw gateway's Anthropic credential and marks
  the Agent `personal` in the edge's `agents.json`.
- The edge refuses **everyone** on a personal Agent that more than one person is granted, until an
  administrator removes the others (verified: one person 200; two people 403/403; back to one 200).
- The People panel (`GET /oae/api/agent`) shows a note and refuses a second person; Create Agent's
  Claude Code help says a setup token makes the Agent personal.
- Tokens last about a year. Agent use spends the person's plan limits quickly.

## Security notes

- **Tools**: OpenClaw turns Claude Code's own tools off. Claude Code sees only `ToolSearch` and
  OpenClaw's tools over MCP (`mcp__openclaw__exec`, `…__edit`, `…__browser`, …), so every action
  goes through OpenClaw's tools and their policy. Asked to use its built-in `Bash`, it has none
  (verified 2026-11-07).
- **Embedded**: the `claude` process runs inside the gateway Pod, next to the gateway's state and
  the Agent's API key, as any Embedded OpenClaw Agent's loop does. A Dedicated Claude Code Pod,
  like Codex's, would separate them (about 40 OCE files plus a protocol bridge; not built).

## Telling Claude Code from OpenClaw's own loop

Ask: "List the exact names of every tool you can call, comma-separated, nothing else." Claude
Code answers `ToolSearch, mcp__openclaw__…`; OpenClaw's own loop answers plain names (`exec`,
`edit`, …). The names come from the tool definitions the model receives. Definitive: the gateway
log's `cli turn: provider=claude-cli` for each turn.

- The API key stays per Agent (its own OCE Secret, operate-bound to the Agent's service
  principal). Use a workspace key with a spend limit.

## Operating

- New runtime image or Claude Code version: rebuild `deploy/oae/runtime-claude`, set
  `runtime.image` in `/opt/oce/prod/occ/profile-input.json`, render, `helm upgrade`, **and**
  update the `occ-installation-startup` Secret from the rendered `installation.yaml`, then restart
  the API and worker. The Helm upgrade alone leaves Agents on the old image.
- Testing: use `claude-haiku-5-5` (cheapest).
