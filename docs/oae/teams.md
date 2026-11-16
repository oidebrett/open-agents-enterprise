# Microsoft Teams for OAE Agents

**Status (2026-11-16):** OpenClaw Agents answer Microsoft Teams / Bot Framework messages. Verified
end to end on the Oracle testbed with an Azure Bot's **Test in Web Chat** (real Bot Framework
service, Microsoft-signed tokens, replies through the Bot Connector) on an Embedded OpenClaw Agent
with Claude Haiku. The Teams _client_ itself needs a Microsoft 365 licence with Teams and a
sideloaded Teams app package (not yet tested — see
[Azure: Web Chat vs the Teams client](#azure-web-chat-vs-the-teams-client)).

## What OAE adds to OCE

|                 | Stock OCE                                                             | OAE                                                                                                              |
| --------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Teams plugin    | Configuration shape accepted; the runtime image ships only Slack      | `@openclaw/msteams@2026.10.8` bundled beside Slack (`deploy/oae/runtime-claude`, npm integrity checked)          |
| Embedded Agents | Every channel refused ("channels require a dedicated Agent workload") | `msteams` allowed (`EMBEDDED_DIRECT_CHANNELS`): no channel proxy, no proxy NetworkPolicy; Slack keeps OCE's rule |
| Ingress         | "Teams requires operator-provided ingress"                            | `oae-edge sync` routes exactly `https://<agent host>/api/messages` to the gateway, without the edge's sign-in    |

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

## End-to-end setup

Three parts: register the Azure Bot, enable Teams on the Agent (console **or** `occ` CLI), point the
bot's messaging endpoint at the Agent. The Agent must be **Embedded OpenClaw (Claude)** for the Web
Chat test — that path replies through the generic Bot Connector, which Web Chat can display (Hermes
cannot; see below).

### 1. Azure Bot

1. Create a resource → **Azure Bot**; Pricing **F0** (free); Type **Single Tenant**; **Create new
   Microsoft App ID**.
2. **Settings → Configuration** gives the **Microsoft App ID** and **App Tenant ID** (both GUIDs,
   not secrets).
3. **Manage Password → Certificates & secrets → New client secret** → copy the **Value** (shown
   once; the _Secret ID_ is not what you need). This is the Teams app password.

### 2. Enable Teams on the Agent — console

Agent → Configuration → **Channels** → **Microsoft Teams** card (beside Slack, on Embedded and
Dedicated Agents). Scroll the drawer past App ID / Tenant ID to reach **Teams app password**:

- **Enable Microsoft Teams**, enter **App ID** and **App Tenant ID**.
- **Teams app password** → open the combobox → **Create new Secret…** → paste the Azure client
  secret **Value**. The binding key is fixed to `MSTEAMS_APP_PASSWORD`. (Creating the Secret stores
  it in the Namespace immediately, even before the channel save completes.)
- **Direct messages** → **Anyone** (open) for a Web Chat test; use pairing/allowlist in production.
- **Save**. On save the Agent's service principal is granted `operate` on the Secret, and
  `oae-edge sync` publishes the `/api/messages` route.

> **Console fixes (ride the next controller image rebuild):** two console-only bugs were fixed on
> `oae` but only reach deploys after a multi-arch controller rebuild + re-pin in manidae:
>
> - A **duplicate "Enable Microsoft Teams" checkbox** in the drawer (the shared drawer already
>   renders one; the Teams card rendered a second). Fixed in `msteams.mts`.
> - The drawer **save gate refused channels on Embedded Agents** ("Channels require Dedicated
>   execution."), missing the `provider.embedded !== true` exemption the backend already applies
>   (`EMBEDDED_DIRECT_CHANNELS = ["msteams"]`). Fixed in `shared-ui.mts`.
>
> Until the rebuilt image is deployed, an Embedded Agent cannot be Teams-enabled through the drawer
> — use the `occ` path below.

### 2b. Enable Teams on the Agent — `occ` CLI fallback

Use this on a testbed whose console image predates the save-gate fix, or to script it. Run as root
on the box (`. /opt/oce/env.sh`); `OCC=/opt/oce/src/bin/occ`. All resources are namespace-scoped by
the **`ns_…` ID** (`$OCC namespace list`).

Find the Agent, its Configuration and service principal, and the Secret:

```bash
NS=ns_...                       # occ namespace list
OCC="/opt/oce/src/bin/occ --namespace $NS"
$OCC agent list                 # -> agent ID (agt_…), CONFIGURATION (cfg_…), SERVICE PRINCIPAL (service-agent-agt_…), MODE=embedded
$OCC secret list                # -> the Teams secret ID (sec_…); create it first if absent:
                                #    console Namespace → Secrets, or `occ secret create`
```

**Update the Configuration** — add `channels.msteams`, enable the `msteams` plugin, and set the
`secretBindings` entry (the console editor cannot save bindings; `occ configuration update` can).
`values` replaces the whole native document, so start from the live one:

```bash
$OCC configuration get <cfg_…> -o json > cur.json
python3 - <<'PY'
import json
d=json.load(open('cur.json')); v=d['values']
v['channels']={"msteams":{"enabled":True,"appId":"<APP_ID>","tenantId":"<TENANT_ID>",
  "appPassword":{"source":"env","provider":"default","id":"MSTEAMS_APP_PASSWORD"},
  "dmPolicy":"open","allowFrom":["*"]}}
pl=v.setdefault('plugins',{})
pl['allow']=sorted(set((pl.get('allow') or [])+["msteams"]))
pl.setdefault('entries',{})['msteams']={"enabled":True}
doc={"values":v,
  "secretBindings":{"MSTEAMS_APP_PASSWORD":{
     "source":{"kind":"secret","namespaceId":d['namespaceId'],"id":"<sec_…>"},
     "delivery":{"type":"env"}}},
  "expectedGeneration":d.get("generation")}
json.dump(doc,open('upd.json','w'),indent=2)
PY
$OCC configuration update <cfg_…> --file upd.json
```

**Grant the Agent `operate` on the Secret** (role **"Agent Secret operate"**, `operate` on
`secret`), mirroring how its model secret is bound:

```bash
ROLE=$($OCC iam role list -o json | python3 -c 'import sys,json;print(next(r["id"] for r in json.load(sys.stdin) if r["name"]=="Agent Secret operate"))')
cat > binding.json <<JSON
{"subjectKind":"identity","subjectId":"service-agent-<agt_…>","roleId":"$ROLE","resourceKind":"secret","resourceId":"<sec_…>"}
JSON
$OCC iam access-binding create --file binding.json
```

**Deploy** a new revision so the gateway pod picks up the plugin + env and the edge publishes the
route:

```bash
$OCC agent deploy <agt_…>
```

### 3. Messaging endpoint

In the Azure Bot (**Settings → Configuration**) set **Messaging endpoint** to the Agent's address
plus `/api/messages`: `https://agent-<hash>.agents.<console host>/api/messages`. The console's Teams
card shows the exact URL (`GET /oae/api/agent` returns the Agent's host).

## Verify

On the box (`. /opt/oce/env.sh`; `K="env KUBECONFIG=/opt/oce/prod/kubeconfig /opt/oce/tools/bin/kubectl"`),
the Agent's gateway runs in its own `oce-<hash>` namespace:

```bash
# gateway pod Ready, password injected (value hidden), plugin loaded + listening
$K -n <oce-ns> exec <gateway-pod> -c gateway -- sh -c '[ -n "$MSTEAMS_APP_PASSWORD" ] && echo SET || echo MISSING'
$K -n <oce-ns> logs <gateway-pod> -c gateway | grep -E "listening|channels/msteams"
#   -> "http server listening (2 plugins: memory-core, msteams; …)"
#   -> "channels/msteams: starting provider (Gateway route /api/messages)"
```

From anywhere, the public path proves the edge routes it and the plugin guards it:

```bash
HOST=agent-<hash>.agents.<console host>
curl -sS -o /dev/null -w "%{http_code}\n" -X POST "https://$HOST/api/messages" \
  -H 'Content-Type: application/json' -d '{"type":"message","text":"ping"}'
#   -> 401  {"error":"Unauthorized"}   (plugin rejects the unsigned request — healthy)
curl -sS -o /dev/null -w "%{http_code}\n" "https://$HOST/"
#   -> not 200   (rest of the host stays behind SSO)
```

Final proof is **Test in Web Chat** in the Azure Bot: a signed Bot Framework request gets through,
the plugin validates Microsoft's token, and the Embedded Agent replies.

## Azure: Web Chat vs the Teams client

Teams and Web Chat are two **channels** on the same Azure Bot, both delivered by the **Bot Framework
/ Bot Connector** to the same `/api/messages` endpoint with the same signed-token validation and the
same App ID / tenant / password. So **Test in Web Chat exercises the entire OAE/server path Teams
uses** — route, auth, agent reply. Only the Teams-client rendering (adaptive cards, @mentions,
channel-vs-DM context) is Teams-specific and unproven without a Teams tenant.

To actually use the bot inside a Teams client (two Microsoft-side steps, no OAE change):

1. **Connect the Teams channel**: Azure Bot → **Channels → Microsoft Teams** → _Commercial_ →
   **Apply**. This only routes Teams activities to the bot's endpoint; it installs nothing and makes
   the bot visible to no one.
2. **Package and install a Teams app**: a manifest (`manifest.json` + icons) carrying the bot's App
   ID, **sideloaded into a Teams-licensed tenant** (custom-app upload or the org app catalog).

A **Single Tenant** bot only serves its own Entra tenant, so a client in another tenant registers
their own Azure Bot (multi-tenant, or in their tenant) and enters the same OAE fields. A free
**Microsoft 365 Developer** tenant (includes Teams licences and custom-app upload) is the cheapest
way to prove the full Teams-client path without a paid subscription.

## Console

Agent → Configuration → **Channels** shows a **Microsoft Teams** card beside Slack, on Embedded and
Dedicated Agents: enable, App ID, Tenant ID, the `MSTEAMS_APP_PASSWORD` Secret (choose or create;
the Agent is granted `operate` on save), direct-message policy, and the exact messaging endpoint
(`GET /oae/api/agent` returns the Agent's host). The Credentials tab no longer blocks Teams. See the
console-fixes note under [step 2](#2-enable-teams-on-the-agent--console).

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
