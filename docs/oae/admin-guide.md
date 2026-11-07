# Open Agents Enterprise — administrator guide

How an administrator runs OAE day to day: people and access, Agents and their models, how people
reach their Agents (browser, phone, desktop), and channels such as Microsoft Teams. Everything here
is done in the browser, under your own sign-in, so OCE checks and audits it as you. A server shell
is only for the platform operator (installs, upgrades, break-glass).

Design background: [edge-design.md](edge-design.md) (access), [claude-harness.md](claude-harness.md)
(Claude Code), [teams.md](teams.md) (Microsoft Teams).

## 1. The pieces

| Address                                     | What it is                                                          | Who uses it                       |
| ------------------------------------------- | ------------------------------------------------------------------- | --------------------------------- |
| `https://<console host>/console/`           | The OCE console: Agents, Configurations, Secrets, People            | Administrators                    |
| `https://auth.agents.<console host>/apps`   | "My apps": a person's Agents, and their phone / desktop connections | Everyone                          |
| `https://agent-<id>.agents.<console host>/` | One Agent's own web UI (OpenClaw Control UI or Hermes dashboard)    | People granted that Agent         |
| Your SSO provider (Keycloak, Entra ID, …)   | Who people are                                                      | Administrators manage users there |

Two kinds of sign-in:

- **Recovery administrator**: the email and password from installation
  (`/root/oce-access.txt` on the server). Password sign-in always works for this one account, even
  when SSO is down. Keep the password safe.
- **Everyone else**: **SSO** ("Continue with SSO" on the console, or any Agent address). People
  exist in your SSO directory; OAE never creates SSO users.

## 2. Add a person

1. **Create them in your SSO directory** (for Keycloak: the realm's _Users → Add user_, with a
   verified email). OAE's directory client can only read users, never create them.
2. In the console open the **Agent → Access** tab. The **People** card lists who can use it.
3. Enter their **email**, choose a level and select **Give access**:
   - **User**: chat with the Agent in its web UI and connect their own apps.
   - **Operator**: also change and redeploy the Agent, and approve devices in its UI.
4. Access takes effect within about a minute (the edge syncs every minute). An Operator grant
   redeploys the Agent once so its gateway admits them.
5. Send them `https://auth.agents.<console host>/apps`. After signing in they see their Agents
   with links to each web UI.

To remove someone, select **Remove access** on their row. Their browser sessions and connected apps
stop working within a minute.

If the People card says the directory is unavailable, the installation has no read-only directory
client (see section 8); the platform operator can still grant with `oae-user` (break-glass).

## 3. Create an Agent

Console → **Agents → Create Agent**. Choose a **Provider**, then a **Harness**:

| Provider                               | Harness         | What runs                                                        |
| -------------------------------------- | --------------- | ---------------------------------------------------------------- |
| OpenAI                                 | **Codex**       | OpenAI's Codex agent in its own Pod (Dedicated)                  |
| OpenAI / Anthropic / OpenAI-compatible | **OpenClaw**    | OpenClaw's own agent loop with that model (Embedded)             |
| Anthropic                              | **Claude Code** | OpenClaw's gateway with every turn run by Claude Code (Embedded) |
| OpenAI / Anthropic / OpenAI-compatible | **Hermes**      | Hermes Agent (Embedded)                                          |

- **API key**: paste it, or pick an existing Secret. Each Agent may use only the Secrets granted
  to it; the console grants the one you pick.
- **OpenAI-compatible**: any HTTPS endpoint ending in `/v1` (a model gateway, NVIDIA, a
  self-hosted server). Its key is sent only to that host.
- **Claude Code with a Claude subscription** (personal Agents only): instead of an Anthropic API
  key, the person may paste a token from `claude setup-token` (it starts `sk-ant-oat`). The Agent
  then uses that person's Claude plan, so it must stay **one person's** Agent: the People card
  refuses a second person, and the edge refuses everyone if two are ever granted. Use API keys for
  shared Agents.
- **Execution mode**: Embedded runs the agent inside its gateway Pod; Dedicated (Codex) runs it in
  a separate Pod. Anthropic, OpenAI-compatible, Claude Code and Hermes are Embedded.

Then **Deploy**. Every deploy is a new immutable version; the Agent page shows its status and logs.

## 4. How people reach their Agents

- **Browser**: the Agent's address (from `/apps`, or **Open Agent** on its console page). They sign
  in with SSO and land in the Agent's own UI as themselves.
- **OpenClaw mobile app**: at `/apps` the person chooses **Connect the mobile app**, then scans
  the QR code in the OpenClaw app (Settings → Gateway) within the minutes shown. The phone pairs on
  its own with limited access (chat and phone features, never administration). Each code works
  once and for one Agent.
- **Hermes Desktop**: at `/apps` the person chooses **Connect Hermes Desktop** and copies the URL
  and session token into Hermes Desktop **Settings → Gateways → Saved connections** (choose
  **Session token**, not Sign in; the Primary gateway form offers only an identity-provider
  sign-in).
- Each person can see and **Disconnect** their apps at `/apps`. Removing their access stops their
  apps too.

Operators approve extra device requests (for example a phone asking to act as a node) in the
Agent's own UI, **Devices** page.

## 5. Channels: Microsoft Teams

Teams works for OpenClaw (Embedded and Dedicated) and Hermes Agents.

**In Microsoft Azure** (once per bot):

1. _Create a resource_ → **Azure Bot**: pricing **F0** (free), type **Single Tenant**, _Create new
   Microsoft App ID_.
2. _Settings → Configuration_: note the **Microsoft App ID** and **App Tenant ID**.
3. _Manage Password → Certificates & secrets → New client secret_: copy the **Value** (shown once).

**In the console**, Agent → **Configuration → Channels → Microsoft Teams**:

1. Enable it; enter the App ID and Tenant ID.
2. **Teams app password**: create a Secret with the client secret value (or pick one).
3. **Direct messages**: _Anyone in the bot's tenant_, _only listed Entra user IDs_, _pairing_
   (approve each new person in the Agent), or _disabled_.
4. Save, then **Deploy** the new version.
5. Copy the **messaging endpoint** the card shows (`https://agent-…/api/messages`) into the Azure
   Bot's _Settings → Configuration → Messaging endpoint_, and Apply.

**Test**: the Azure Bot's **Test in Web Chat** (OpenClaw answers there; Hermes answers only in the
Teams app). **In Teams**: add the _Microsoft Teams_ channel to the Azure Bot and install the bot
for your users. That needs a Microsoft 365 licence that includes Teams and custom apps allowed by
your Teams administrator (Teams admin center → Teams apps).

The messaging endpoint is the only address on an Agent that skips SSO: Microsoft cannot sign in,
so the Teams plugin checks Microsoft's signature on every request instead.

## 6. Channels: Slack

Agent → **Configuration → Channels → Slack** (Socket Mode). Slack needs a **Dedicated** Agent
(Codex). Create a Slack app with Socket Mode, then bind its app token and bot token as Secrets on
the card and choose channels and people. See the OCE guide `docs/guides/integrations/slack.md`.

## 7. Day-to-day checks

- **Who did what**: OCE's audit log names the person who made each change; the platform's own
  background sync appears as a service principal.
- **An Agent will not start**: Agent page → status and logs. Common causes: a wrong or out-of-credit
  model key, or the Namespace's Pod quota (stop Agents you do not use).
- **Someone cannot open an Agent**: check the People card, wait a minute for the sync, and check
  they exist (and are enabled) in your SSO directory.
- **Teams does not answer**: the bot's messaging endpoint must be the one on the Teams card, and
  the Agent's version with Teams must be deployed.

## 8. For the platform operator

These need a server shell and are not part of daily administration.

- **Installation** (manidae-cloud's _Open Agents Enterprise_ package) needs: a console host name;
  an OIDC issuer with a client for the console and one for the edge (redirect
  `https://auth.agents.<host>/callback`); optionally a **read-only directory client**
  (`client_credentials`, Keycloak `realm-management` → `view-users`) for the People card's email
  lookup. OAE's `deploy/oae/central-sso/oae-realm.sh` creates all three in a Keycloak realm.
- **Break-glass** (SSO down): `oae-user add <email> <sso subject>`,
  `oae-user grant <email> <agent> [user|operator]`, `oae-user list`. Changes are made as the
  recovery administrator.
- **Recovery password lost**: OCE's `auth-maintain reset-recovery-password`
  (`docs/guides/deploy/auth-maintenance.md`; stops the API for a minute).
- **Changing the Agent runtime image**: render the profile, `helm upgrade`, **and** update the
  `occ-installation-startup` Secret from the rendered `installation.yaml`, then restart the API and
  worker; redeploy Agents to pick it up.
