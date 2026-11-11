# Claude Gateway as an OAE Agent (design)

An administrator creates a **Claude Gateway** Agent in the console like a Hermes or OpenClaw
Agent. People granted it connect Claude Code and Claude Desktop from `/apps`, sign in with the
installation's Keycloak, and use Anthropic's models through Anthropic's own `claude gateway`, with
personal data masked before Anthropic. An installation may run several gateways (per team, per
policy). Claude is a trademark of Anthropic, PBC.

The stack was proven on the Oracle spike (2026-11-11, proposal doc "OAE Claude Gateway Proposal")
and as the Compose package in `deploy/oae/claude-gateway/`, which stays as the reference and for
non-OAE servers. This design maps the same pieces onto OCE's model, as Hermes does
(`apps/controller/src/drivers/compute/kubernetes/hermes.ts`).

## The constraint that shapes it

Claude Code and Claude Desktop accept a gateway only at a **private address** (RFC 1918,
100.64.0.0/10, ULA, loopback); the check runs on the laptop. The edge's public
`agent-<hash>.agents.<host>` cannot serve them. Each gateway Agent therefore gets its own
**WireGuard** endpoint, and `/apps` hands a person a tunnel instead of an app token.

## Pieces

| Piece | Where | Does |
|---|---|---|
| Harness `claude-gateway` (Embedded, Anthropic only) | controller: `production-harness.ts`, `configured-harness.ts`, `harness-auth.mts`, console `create.mts` | the console's Create Agent choice; the Anthropic key is the Agent's API-key Secret binding |
| `withClaudeGatewayRuntime()` | `drivers/compute/kubernetes/claude-gateway.ts`, wraps the Compute Driver beside `withHermesRuntime()` | prepares one workload per gateway Agent in its tenant namespace |
| Gateway Pod | tenant namespace | init: download the pinned `claude` from Anthropic, check the manifest checksum (OAE never ships it); `gateway` (`claude gateway`); `pii-masker` sidecar on 127.0.0.1:8080, the only holder of the Anthropic key; `postgres` (sessions) on the Agent's volume |
| NetworkPolicy | tenant namespace | in: only the gateway's WireGuard; out: DNS, public HTTPS (Anthropic, the installation's Keycloak), metadata address excluded |
| Service (NodePort, `externalTrafficPolicy: Local`) | tenant namespace | the gateway's port for its WireGuard container on the `oce` Docker network |
| `oae-claude-sync` (timer, root) | host, `deploy/oae/claude-gateway/` | per gateway Agent: Keycloak client, TLS certificate from the host CA, WireGuard + Traefik containers, peers from `/apps`; removes all of it with the Agent |
| `/apps` "Connect Claude Code / Claude Desktop" | edge `authz/server.mjs` | makes the laptop's WireGuard key pair, records the public key for the sync, shows the hand-off once |
| Host CA (name-constrained to the private domain) | host, `/opt/oae-claude/ca` (root-only) | signs each gateway's certificate; never in the cluster |

## Per gateway Agent

- **Name**: `claude-<hash>.<private domain>` (default `oae.internal`), hash as for edge hosts.
- **Keycloak client** `oae-claude-<hash>`, redirect `https://claude-<hash>.<domain>:8443/oauth/callback`,
  scopes include `groups`. The sync creates it with a realm service account that may only manage
  clients (`oae-realm.sh` adds that account and the `groups` scope); secret into the tenant Secret.
- **WireGuard**: its own UDP port from `51830–51849` (opened as a range at install) and subnet
  `10.77.<n>.0/24`, tunnel address `10.77.<n>.1`. Traefik in its network namespace forwards
  `:8443` (TLS passthrough) to the gateway's NodePort; peers are applied with `wg syncconf`, no
  restart.
- **Configuration** (versioned and audited by OCE like any Agent): models per Keycloak group,
  allowed email domains, session lifetime, PII rules, under the model policy the console writes.

## People

| Action | Effect |
|---|---|
| People card: grant User | the gateway appears on the person's `/apps` |
| `/apps` → Connect | X25519 key pair made in the edge; the private key is shown once in the tunnel file; the public key goes to the sync's store; active within a minute |
| Disconnect, or grant removed | the sync removes the peer: the network path closes at once (gateway sessions also end at their lifetime, default 1 hour) |
| Keycloak group | picks the model policy |

The hand-off on `/apps`: tunnel file, CA certificate, `setup-mac.sh` (hosts line, CA trust,
Claude Code settings), the Desktop bootstrap URL and the certificate fingerprint.

## Installing

- **Keycloak**: `central-sso/oae-realm.sh` creates the `groups` client scope and the client
  manager `oae-claude-clients` (service account: realm-management manage-clients, view-clients,
  view-users, query-users); `central-sso/README.md` has the by-hand steps.
- **Server**: with the manager's ID and secret, as root:
  `CLAUDE_KC_ISSUER=… CLAUDE_KC_CLIENT_ID=oae-claude-clients CLAUDE_PUBLIC_HOST=<public IPv4>
  deploy/oae/claude-gateway/oae-claude-sync install` (the secret first in
  `/opt/oce/prod/secure/claude-kc-client-secret`). manidae-cloud does this when the OAE form has
  the Claude Gateway client, and opens UDP 51830–51849.
- **Firewall**: inbound UDP 51830–51849 (one port per gateway, up to 20).

## Lifecycle notes

- The sync restarts a gateway whose sign-in Secret changed (the gateway reads it at start).
- Deleting the Agent removes its workload (controller), then within a minute its WireGuard and
  Traefik containers, Keycloak client, certificate, sync-made Secrets and laptop peers (sync).
  Its volume stays until the Namespace is deleted, as for other Agents.

## Build order (each proven on Oracle before the next)

1. Harness id, console choice, workload in load-test mode; sync issues certificate and Keycloak
   client. Done 2026-11-11 (the in-cluster path for OAE's own Agents is still to come).
2. WireGuard per gateway, `/apps` connect/disconnect, Mac CLI + Desktop sign-in. Done 2026-11-11.
3. PII masker sidecar and real Anthropic key. Done 2026-11-11 (email and phone masked).
4. Second gateway on the same installation; delete an Agent and check everything is removed.
   Done 2026-11-11.
5. manidae: UDP range in the firewall, `oae-claude-sync` installed with OAE, docs.
