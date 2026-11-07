import { element } from "../dom.mjs";
import type { AgentAccessContext } from "./credential-access.mjs";

// OAE: on an SSO installation people reach each Agent through OAE's edge, at
// agent-<hash>.agents.<console host>, with their SSO identity and their grants. The edge's /open
// route resolves that address, so the console needs no Installation read. Upstream's native admin
// UI, which OCE turns off with SSO, is untouched.
export function renderOaeOpenAgent(
  context: Pick<AgentAccessContext, "request" | "isCurrent">,
  namespaceId: string,
  agentId: string,
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
  void context
    .request("/api/auth/providers")
    .then((providers: unknown) => {
      if (context.isCurrent()) {
        link.hidden = (providers as { oidc?: unknown } | undefined)?.oidc !== true;
      }
    })
    .catch(() => {});
  return link;
}
