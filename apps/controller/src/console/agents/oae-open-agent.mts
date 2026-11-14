import { element } from "../dom.mjs";
import type { AgentAccessContext } from "./credential-access.mjs";

// OAE: harness ids whose Agents have no browser UI, so neither launch button applies. Claude Gateway
// Agents (people's own Claude Code / Claude Desktop over the VPN, docs/oae/claude-gateway.md) are
// reached by a remote client, never a web UI; upstream's native card already hides itself for them
// (the compute driver returns no gateway endpoint), and the edge button must do the same. Kept as a
// literal so the Console does not import compute-driver code (module boundaries).
const NO_BROWSER_UI_HARNESS_IDS = new Set(["claude-gateway"]);

// OAE: on an SSO installation people reach each Agent through OAE's edge, at
// agent-<hash>.agents.<console host>, with their SSO identity and their grants. The edge's /open
// route resolves that address, so the console needs no Installation read. Shown only when OIDC is on
// and the Agent actually has a browser UI. Upstream's native admin UI, which OCE turns off with SSO,
// is untouched. Returns `update()` so the caller can re-apply visibility once the revision (and so
// its harness) is known — see docs/oae/native-chat-rfc0031.md (strike 8).
export function renderOaeOpenAgent(
  context: Pick<AgentAccessContext, "request" | "isCurrent">,
  namespaceId: string,
  agentId: string,
  currentHarnessId?: () => string | null | undefined,
) {
  const link = element(
    "a",
    {
      className: "button button--primary agent-ui-launch oae-open-agent",
      href: `https://auth.agents.${window.location.host}/open/${encodeURIComponent(namespaceId)}/${encodeURIComponent(agentId)}`,
      target: "_blank",
      rel: "noopener noreferrer",
      title: "Open this Agent through the edge, signed in with SSO (needs a grant)",
      hidden: true,
    },
    "Open Agent",
    element("span", { "aria-hidden": "true" }, "↗"),
  );
  let oidc = false;
  // A Claude Gateway Agent has no web UI; hide the button for it. While the harness is still unknown
  // the button follows OIDC alone, then hides if the resolved harness is a no-UI one (as the native
  // card does on its own probe).
  const update = () => {
    if (!context.isCurrent()) {
      return;
    }
    const harness = currentHarnessId?.();
    const noBrowserUi = harness != null && NO_BROWSER_UI_HARNESS_IDS.has(harness);
    link.hidden = !oidc || noBrowserUi;
  };
  void context
    .request("/api/auth/providers")
    .then((providers: unknown) => {
      oidc = (providers as { oidc?: unknown } | undefined)?.oidc === true;
      update();
    })
    .catch(() => {});
  return { link, update };
}
