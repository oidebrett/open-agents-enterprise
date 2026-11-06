# CLAUDE.md

This checkout is **Open Agents Enterprise (OAE)**, a fork of OpenClaw Enterprise.

1. Follow upstream's [`AGENTS.md`](AGENTS.md) for everything in the codebase.
2. Read [`OAE.md`](OAE.md) for the fork rules (add, don't edit; upstream first;
   branches; sync; Actions policy) and [`docs/oae/strikes.md`](docs/oae/strikes.md)
   for the plan and its status.
3. Work on `strike/<n>-<topic>` branches off `oae`. Never commit to `main`.
4. The test box is the Oracle BYOVPS, which also runs the live AgentGateway.
   Confirm its address with the user before connecting, and never disturb the
   AgentGateway sandboxes (`ivos-openclaw`, `ivos-hermes`) or its Traefik routes.
5. Packaging lives in manidae-cloud (`backend/app/core/deployment/oce.py` and the
   OAE package). Reference implementation for access and remote clients:
   `~/Projects/nvidia/openshell_controller` (`HERMES_REMOTE_DESKTOP.md`,
   `SANDBOX_ACCESS_CONTROL.md`, `app/lib/auth/`).
