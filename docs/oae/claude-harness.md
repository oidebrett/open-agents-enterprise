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

## The API key

The Agent's Anthropic key reaches the gateway as `ANTHROPIC_API_KEY`, exactly as for Anthropic on
OpenClaw (OCE's `api_key` binding to an Agent-only Secret). OpenClaw deliberately removes that
variable when it starts `claude` and passes an empty `--setting-sources` (user settings ignored),
so Claude CLI never silently bills an API key. Admin-managed Claude settings always apply, so the
image ships `/etc/claude-code/managed-settings.json` with
`apiKeyHelper: /usr/local/bin/oae-claude-api-key`, which prints the key from the gateway's own
environment (PID 1, same user). `claude auth status` then reports `api_key_helper`, and usage is
billed to the API key, never a Claude subscription (subscription logins in a shared hosted
service are against Anthropic's consumer terms).

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
