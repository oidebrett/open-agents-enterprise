import type { AgentAccessContext } from "./credential-access.mjs";

// OAE: on an SSO (OIDC) installation ordinary people reach their Agents through the edge — OAE's
// "Open Agent" button (oae-open-agent.mts) — so upstream's native Agent-UI button ("Open Agent UI" /
// "Open chat") is redundant next to it and confusing for operate-only users, whose native chat route
// is shadowed by the edge anyway (docs/oae/native-chat-rfc0031.md, strike 8). Keep the native UI only
// as the recovery administrator's break-glass: show it to `administer` holders, hide it for everyone
// reaching Agents by an `operate` grant. On a non-OIDC install the native card is upstream's, unchanged.
//
// This gates only the client button's visibility (the probe `renderNativeAdminAccess` runs before it
// shows the card); native-admin stays enabled on the server for break-glass. It is wired as the
// `browserAccessAllowed` answer in detail.mts.

// Matches the caller's resolved `Permissions | null`; `null` or absent fields read as "unknown".
type AgentPermissions =
  { readonly administer?: boolean; readonly operate?: boolean } | null | undefined;

let oidcEnabled: Promise<boolean> | undefined;

function oaeOidcEnabled(context: Pick<AgentAccessContext, "request">): Promise<boolean> {
  // One lookup per page: the provider set does not change under the reader.
  oidcEnabled ??= context
    .request("/api/auth/providers")
    .then((providers: unknown) => (providers as { oidc?: unknown } | undefined)?.oidc === true)
    .catch(() => false);
  return oidcEnabled;
}

// The answer upstream's native-admin card reads to decide whether to probe and show its button.
// `true` shows it, `false` hides it without an audited probe, `undefined` leaves the answer unknown.
export async function oaeNativeAdminBrowserAccess(
  context: Pick<AgentAccessContext, "request">,
  permissions: AgentPermissions,
): Promise<boolean | undefined> {
  if (await oaeOidcEnabled(context)) {
    if (permissions?.administer === true) {
      return true;
    }
    if (permissions?.administer === false) {
      return false;
    }
    return undefined;
  }
  // Upstream behaviour on a non-OIDC install: operate or administer may open the native UI.
  if (permissions?.administer === true || permissions?.operate === true) {
    return true;
  }
  if (permissions?.administer === false && permissions?.operate === false) {
    return false;
  }
  return undefined;
}
