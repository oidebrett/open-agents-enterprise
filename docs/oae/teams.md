# Microsoft Teams for OAE Agents

**Status (2026-11-07):** OpenClaw Agents answer Microsoft Teams / Bot Framework messages. Verified
end to end with an Azure Bot's **Test in Web Chat** (real Bot Framework service, Microsoft-signed
tokens, replies through the Bot Connector) on an Embedded OpenClaw Agent with Claude Haiku 5.5.
The Teams client itself needs a Microsoft 365 licence with Teams (not tested yet).

## What OAE adds to OCE

| | Stock OCE | OAE |
|---|---|---|
| Teams plugin | Configuration shape accepted; the runtime image ships only Slack | `@openclaw/msteams@2026.10.8` bundled beside Slack (`deploy/oae/runtime-claude`, npm integrity checked) |
| Embedded Agents | Every channel refused ("channels require a dedicated Agent workload") | `msteams` allowed (`EMBEDDED_DIRECT_CHANNELS`): no channel proxy, no proxy NetworkPolicy; Slack keeps OCE's rule |
| Ingress | "Teams requires operator-provided ingress" | `oae-edge sync` routes exactly `https://<agent host>/api/messages` to the gateway, without the edge's sign-in |

Why Embedded needs no proxy: OCE sends channel traffic through `runtime.channels` (an allowlisting
CONNECT proxy, Slack hosts only) by setting `HTTPS_PROXY` on a Dedicated gateway. An Embedded
gateway also makes the model calls and runs tools, so that would break them; it already has direct
public egress for its model, which reaches Microsoft's hosts (verified). The Teams app password
arrives as an Agent-only Secret binding next to the model key it already holds. Teams on a
Dedicated Agent still needs OCE's channel runtime plus Microsoft hosts in the proxy (not done).

## Security of the public path

- Only `Path(/api/messages)` on a Teams-enabled Agent's host skips SSO; the rest of the host stays
  behind the edge. The route is removed when the Configuration disables Teams.
- The plugin validates Bot Framework's signed JWT on every request (an unsigned POST gets 401 from
  the plugin). Identity headers are stripped and cookies dropped on this route as on the others.
- A single-tenant bot only accepts conversations from its own Entra tenant.

## Set up (testbed, as built)

1. **Azure:** Create a resource → Azure Bot; Pricing F0 (free); Type Single Tenant; Create new
   Microsoft App ID. Settings → Configuration gives the App ID and App Tenant ID; Manage Password →
   Certificates & secrets → New client secret (copy the Value).
2. **Agent Configuration** (OCE JSON):
   ```json
   "channels": { "msteams": { "enabled": true, "appId": "<App ID>", "tenantId": "<Tenant ID>",
     "appPassword": { "source": "env", "provider": "default", "id": "MSTEAMS_APP_PASSWORD" },
     "dmPolicy": "open", "allowFrom": ["*"] } }
   ```
   with `secretBindings.MSTEAMS_APP_PASSWORD` → a Namespace Secret holding the client secret, and
   the Agent's service principal granted `operate` on it.
3. **Messaging endpoint** in the Azure Bot: `https://agent-<hash>.agents.<host>/api/messages`.
4. **Test in Web Chat**; for the Teams client, add the Microsoft Teams channel to the bot and
   install the app (needs a tenant with Teams licences and custom apps allowed).

Testbed helper on Oracle: `/root/teams-agent.sh NAME APP_ID TENANT_ID`.

## Console

Agent → Configuration → **Channels** shows a **Microsoft Teams** card beside Slack, on Embedded and
Dedicated Agents: enable, App ID, Tenant ID, the `MSTEAMS_APP_PASSWORD` Secret (choose or create;
the Agent is granted `operate` on save), direct-message policy, and the exact messaging endpoint
(`GET /oae/api/agent` returns the Agent's host). The Credentials tab no longer blocks Teams.

## Dedicated Agents

The Installation's channel runtime is on (`channels.managedSlackProxy: true` in the profile input),
and the managed channel proxy (`apps/controller/src/slack-proxy.mjs`) also allows Microsoft's
Bot Framework, Entra sign-in and Graph hosts (verified: those 200, other hosts 403). A Dedicated
gateway reaches Microsoft through it (`HTTPS_PROXY`), as Slack does. Not yet proven end to end:
needs a Dedicated (Codex) Agent, i.e. an OpenAI key.

## Hermes

`deploy/oae/runtime-hermes` adds the Microsoft Teams SDK (Hermes's `teams` extra) to the official
image. The Hermes driver turns `channels.msteams` into `TEAMS_CLIENT_ID/TENANT_ID/PORT` and
`TEAMS_ALLOW_ALL_USERS` or `TEAMS_ALLOWED_USERS`, with the app password from the same Secret
binding; port 3978 is opened only when Teams is on, and the edge routes `/api/messages` there
(identity-only strip: Bot Framework's token is in `Authorization`).

Verified 2026-11-07: Bot Framework delivers to Hermes, the plugin validates the token (unsigned:
401), Hermes answers, and the bot's credentials mint a Bot Framework token. **Web Chat cannot show
Hermes's reply:** Hermes's Teams plugin always replies through the Teams connector
(`smba.trafficmanager.net/teams/`, an allowlist that excludes `webchat.botframework.com`), by
design. Proving replies needs the Teams client (a Microsoft 365 licence with Teams).
