# The OAE testbed (Oracle)

OAE's verification bench is the Oracle BYOVPS (`130.61.64.124`, key `~/.ssh/tf_oracle`, user `ubuntu`
with sudo). It also runs the live AgentGateway (Pangolin stack, `ivos-openclaw` and `ivos-hermes`
sandboxes, the openshell controller): **never touch those**. Confirm the address with the operator
before connecting.

OAE runs beside them, installed with manidae-cloud's BYOVPS script for the OAE package
(`backend/app/core/deployment/oce.py :: build_oce_script`), which finds the existing reverse proxy on
:443 (Pangolin's Traefik) and only writes its own rules into its rules directory:

|                     |                                                                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Console             | `https://oae.ag-6a4baf8a.nemoclaw.dpdns.org/console/` (administrator `ivo.brett@gmail.com`, password in `/opt/oce/prod/secure/initial-admin-password`) |
| Sign-in             | Keycloak realm `oae-oracle` (`~/.config/oae-sso/` on the operator's Mac)                                                                               |
| People's apps       | `https://auth.agents.oae.ag-6a4baf8a.nemoclaw.dpdns.org/apps`                                                                                          |
| Claude Gateway VPNs | WireGuard UDP 51830-51849, built-in VPN UDP 500/4500 (OCI security list opened)                                                                        |
| Backups             | none (manidae knows this server only as the Level 1 AgentGateway; `oae-backup` must stay off: its default folder is the AgentGateway's backup folder)  |

OAE's own pieces, all separate from the AgentGateway's: the k3d cluster `oce`, the `oce-postgres`
container, the `oce` Docker network, `/opt/oce`, the `oae-*` and `oce-*` systemd units, the
`oae-claude-*` containers, and the `oce-console.yml`, `oae-edge.yml`, `oae-claude-vpn.yml` Traefik rules.

## Moving the testbed to a candidate

Build the candidate's images from the commit (`OAE.md`, the release image commands), then on the box:

```bash
sudo oae-upgrade status
sudo oae-upgrade apply --ref <full sha> --controller docker.io/oideibrett/open-agents-enterprise-controller@sha256:… \
     --edge docker.io/oideibrett/open-agents-enterprise-edge@sha256:…
# if it misbehaves:
sudo oae-upgrade rollback
```

`oae-upgrade` (deploy/oae) keeps the data. A candidate that changes the database (new migrations)
cannot be rolled back by images alone: export the database first (`oae-backup stage --out
/root/pre-upgrade` with a throwaway key) or reinstall.

## Verification checklist

Run after every candidate, in this order, and record the result in the sync branch's merge message:

1. `oae-upgrade status`: every deployment ready; the console answers.
2. Console: sign in as administrator, then with SSO as a person (`oae-demo`).
3. Agents: create, deploy and chat with an **OpenClaw**, a **Hermes** and a **Claude Code** Agent;
   grant a person on the People card.
4. `/apps`: the person sees the granted Agents; connect a phone or Hermes Desktop if the change
   touches the edge.
5. Claude Gateway: create one; connect a laptop with the **built-in VPN** and with **WireGuard**;
   one Claude Code message each; the masker log shows the request.
6. Channels, when the change touches them: one Teams or Slack message.
7. The AgentGateway is untouched: its containers and Traefik rules as before (compare with
   `/root/ag-baseline.txt` and `/root/ag-rules-baseline.txt`).

## Reinstalling the testbed

Only when its state is beyond repair: render the BYOVPS script from manidae-cloud's current code
(OAE package, subdomain `oae`, domain `ag-6a4baf8a.nemoclaw.dpdns.org`, the `oae-oracle` realm's
clients) and run it as root. It replaces OAE's cluster, database and state, removes its own host
containers first, and leaves the AgentGateway alone (done 2026-11-12).
