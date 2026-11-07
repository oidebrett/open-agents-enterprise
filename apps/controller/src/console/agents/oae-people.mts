import type { Agent, Permission } from "@openclaw-enterprise/contracts";
import { requestFailure, responseFields } from "../api-client.mjs";
import { button, element } from "../dom.mjs";
import type { AgentAccessContext } from "./credential-access.mjs";
import { namespacePath } from "./list.mjs";

// OAE: the Access tab's People panel, for SSO installations (docs/oae/edge-design.md § Access
// without a shell). An Installation administrator gives a person in the SSO directory access to
// this Agent by email. Every OCE change (the person's account, its SSO identity, the Roles and
// AccessBindings) is made here with the administrator's own console session, so OCE checks and
// audits it as them. The edge (/oae/api/, same origin) only looks the email up in the directory
// and records which SSO subject the account's Principal is; it checks the administrator with OCE
// itself. Hidden unless OIDC sign-in is on and the edge accepts the caller as an administrator.

const ROLE_USER = "OAE Agent user";
const ROLE_OPERATOR = "OAE Agent operator";
// The same Roles oae-user and oae-edge sync use; sync reads the level from the Role's name.
const ROLE_PERMISSIONS: Record<Level, Permission[]> = {
  user: [
    { action: "read", resourceKind: "namespace" },
    { action: "read", resourceKind: "agent" },
    { action: "read", resourceKind: "agent_revision" },
  ],
  operator: [
    { action: "read", resourceKind: "namespace" },
    { action: "read", resourceKind: "agent" },
    { action: "update", resourceKind: "agent" },
    { action: "deploy", resourceKind: "agent" },
    { action: "operate", resourceKind: "agent" },
    { action: "read", resourceKind: "configuration" },
    { action: "update", resourceKind: "configuration" },
    { action: "read", resourceKind: "agent_revision" },
  ],
};
const ROLE_NAMES: Record<Level, string> = { user: ROLE_USER, operator: ROLE_OPERATOR };

type Level = "user" | "operator";
interface Role {
  id: string;
  name: string;
}
interface Binding {
  id: string;
  subjectKind: string;
  subjectId: string;
  roleId: string;
  resourceKind: string;
  resourceId: string;
}
interface Person {
  principalId: string;
  email: string;
  userId: string;
}

function list(value: unknown) {
  if (!Array.isArray(value)) {
    throw new Error("Invalid list");
  }
  return value.map((item) => responseFields(item));
}
const text = (value: unknown) => (typeof value === "string" ? value : "");

function randomPassword() {
  // OCE creates every account with a password; a person who signs in with SSO never receives it.
  const bytes = crypto.getRandomValues(new Uint8Array(33));
  return btoa(String.fromCharCode(...bytes));
}

// A message this panel words itself, shown as written.
class PanelError extends Error {}

function problem(error: unknown) {
  if (error instanceof PanelError) {
    return error.message;
  }
  const { status, serverMessage } = requestFailure(error);
  return serverMessage ?? (status ? `The request failed (HTTP ${status}).` : "The request failed.");
}

export function renderOaePeople(
  context: AgentAccessContext,
  agent: Pick<Agent, "id" | "name" | "configurationId" | "activeRevisionId">,
) {
  const iam = `${namespacePath(context.namespaceId)}/iam`;
  const section = element("section", {
    className: "card agent-access-share oae-people",
    "aria-labelledby": "oae-people-title",
    hidden: true,
  });
  const feedback = element("div", { role: "status" });
  const rows = element("div");
  const email = element("input", {
    id: "oae-people-email",
    type: "email",
    required: true,
    autocomplete: "off",
  });
  const level = element(
    "select",
    { id: "oae-people-level" },
    element("option", { value: "user" }, "User — chat with the Agent and connect their apps"),
    element(
      "option",
      { value: "operator" },
      "Operator — also change and deploy it, and approve devices in its UI",
    ),
  );
  const give = element("button", { type: "submit" }, "Give access");
  const appsHint = element("p", { className: "hint" });
  // Shown when the Agent runs on a person's Claude subscription token.
  const personalNote = element(
    "p",
    { className: "hint", hidden: true },
    "This Agent runs on a personal Claude subscription token, so only one person may use it: the subscriber. With more than one person, the edge refuses everyone.",
  );
  const form = element(
    "form",
    { className: "agent-access-form" },
    element(
      "div",
      { className: "form-field" },
      element("label", { for: "oae-people-email" }, "Email in your SSO directory"),
      email,
    ),
    element(
      "div",
      { className: "form-field" },
      element("label", { for: "oae-people-level" }, "Access"),
      level,
    ),
    element("div", { className: "form-actions" }, give),
  );
  section.append(
    element("h3", { id: "oae-people-title" }, "People"),
    element(
      "p",
      { className: "muted" },
      "People sign in with SSO and open this Agent with Open Agent. Changes here are made with your own session and recorded in OCE’s audit log.",
    ),
    appsHint,
    personalNote,
    feedback,
    rows,
    form,
  );

  const state = {
    pending: false,
    directory: true,
    personal: false,
    roles: [] as Role[],
    bindings: [] as Binding[],
    people: [] as Person[],
  };

  function say(message: string, tone: "info" | "error" = "info") {
    feedback.replaceChildren(
      element("p", tone === "error" ? { className: "error", role: "alert" } : {}, message),
    );
  }

  function onAgent(binding: Binding) {
    return (
      binding.subjectKind === "identity" &&
      ((binding.resourceKind === "agent" && binding.resourceId === agent.id) ||
        (binding.resourceKind === "configuration" &&
          binding.resourceId === agent.configurationId) ||
        (binding.resourceKind === "agent_revision" &&
          agent.activeRevisionId !== undefined &&
          binding.resourceId === agent.activeRevisionId))
    );
  }

  function render() {
    give.disabled = state.pending || !state.directory;
    personalNote.hidden = !state.personal;
    const roleName = new Map(state.roles.map((role) => [role.id, role.name]));
    const levels = new Map<string, Level>();
    for (const binding of state.bindings) {
      if (
        binding.subjectKind !== "identity" ||
        binding.resourceKind !== "agent" ||
        binding.resourceId !== agent.id
      ) {
        continue;
      }
      const operator = roleName.get(binding.roleId) === ROLE_OPERATOR;
      if (operator || !levels.has(binding.subjectId)) {
        levels.set(binding.subjectId, operator ? "operator" : "user");
      }
    }
    const byPrincipal = new Map(state.people.map((person) => [person.principalId, person]));
    const entries = [...levels.entries()].sort(([a], [b]) =>
      (byPrincipal.get(a)?.email ?? a).localeCompare(byPrincipal.get(b)?.email ?? b),
    );
    rows.replaceChildren(
      ...(entries.length
        ? entries.map(([principalId, granted]) =>
            element(
              "div",
              { className: "agent-access-grant" },
              element(
                "div",
                {},
                element("p", {}, byPrincipal.get(principalId)?.email ?? principalId),
                element(
                  "p",
                  { className: "hint" },
                  byPrincipal.has(principalId)
                    ? granted === "operator"
                      ? "Operator"
                      : "User"
                    : "Not an SSO person the edge knows; this grant does not open the Agent UI.",
                ),
              ),
              button("Remove access", () => void run(() => revoke(principalId)), {
                tone: "danger",
                disabled: state.pending,
              }),
            ),
          )
        : [
            element("p", { className: "muted" }, "Nobody has been given access to this Agent yet."),
          ]),
    );
  }

  async function load() {
    const [roles, bindings, people, agentState] = await Promise.all([
      context.request(`${iam}/roles`),
      context.request(`${iam}/access-bindings`),
      context.request("/oae/api/people"),
      context.request(
        `/oae/api/agent?namespaceId=${encodeURIComponent(context.namespaceId)}&agentId=${encodeURIComponent(agent.id)}`,
      ),
    ]);
    state.personal = responseFields(agentState).personal === true;
    state.roles = list(roles).map((role) => ({ id: text(role.id), name: text(role.name) }));
    state.bindings = list(bindings).map((binding) => ({
      id: text(binding.id),
      subjectKind: text(binding.subjectKind),
      subjectId: text(binding.subjectId),
      roleId: text(binding.roleId),
      resourceKind: text(binding.resourceKind),
      resourceId: text(binding.resourceId),
    }));
    state.people = list(people).map((person) => ({
      principalId: text(person.principalId),
      email: text(person.email),
      userId: text(person.userId),
    }));
  }

  async function run(work: () => Promise<string>) {
    if (state.pending || !context.isCurrent()) {
      return;
    }
    state.pending = true;
    render();
    try {
      await load();
      const done = await work();
      await load();
      if (context.isCurrent()) {
        say(done);
      }
    } catch (error) {
      if (context.isCurrent()) {
        say(problem(error), "error");
      }
    } finally {
      state.pending = false;
      if (context.isCurrent()) {
        render();
      }
    }
  }

  async function ensureRole(granted: Level) {
    const existing = state.roles.find((role) => role.name === ROLE_NAMES[granted]);
    if (existing) {
      return existing.id;
    }
    const created = responseFields(
      await context.request(`${iam}/roles`, {
        method: "POST",
        body: { name: ROLE_NAMES[granted], permissions: ROLE_PERMISSIONS[granted] },
      }),
    );
    return text(created.id);
  }

  async function bind(
    principalId: string,
    roleId: string,
    resourceKind: string,
    resourceId: string,
  ) {
    const exists = state.bindings.some(
      (binding) =>
        binding.subjectId === principalId &&
        binding.roleId === roleId &&
        binding.resourceKind === resourceKind &&
        binding.resourceId === resourceId,
    );
    if (!exists) {
      await context.request(`${iam}/access-bindings`, {
        method: "POST",
        body: { subjectKind: "identity", subjectId: principalId, roleId, resourceKind, resourceId },
      });
    }
  }

  async function unbind(principalId: string, keep: (binding: Binding) => boolean = () => false) {
    for (const binding of state.bindings) {
      if (binding.subjectId === principalId && onAgent(binding) && !keep(binding)) {
        await context.request(`${iam}/access-bindings/${encodeURIComponent(binding.id)}`, {
          method: "DELETE",
          expectedStatus: 204,
        });
      }
    }
  }

  // The person's OCE account with their SSO identity attached: found through the edge's records,
  // or created now (with the administrator's session).
  async function account(found: Record<string, unknown>, address: string) {
    let userId = text(found.userId);
    if (!userId) {
      try {
        const created = responseFields(
          await context.request("/api/auth/accounts", {
            method: "POST",
            body: { email: address, password: randomPassword() },
          }),
        );
        userId = text(created.id);
      } catch (error) {
        if (requestFailure(error).status === 409) {
          throw new PanelError(
            `An OCE account for ${address} already exists, but it is not linked to this person’s SSO identity here. The platform operator links it once with: oae-user add ${address} ${text(found.subject)}`,
            { cause: error },
          );
        }
        throw error;
      }
    }
    const current = responseFields(
      // Through the edge: OCE needs an Origin header on account reads, which a browser GET lacks.
      await context.request(`/oae/api/account?userId=${encodeURIComponent(userId)}`),
    );
    const methods = Array.isArray(current.methods)
      ? current.methods.map((m) => responseFields(m))
      : [];
    const sso = methods.filter((m) => text(m.providerId).startsWith("oidc:"));
    if (!sso.some((m) => m.subject === found.subject)) {
      if (sso.length) {
        throw new PanelError(
          `The OCE account for ${address} is linked to a different SSO identity.`,
        );
      }
      await context.request(`/api/auth/accounts/${encodeURIComponent(userId)}/providers/oidc`, {
        method: "POST",
        body: { subject: found.subject, expectedVersion: current.version },
      });
    }
    const person = responseFields(
      await context.request("/oae/api/people", { method: "POST", body: { userId } }),
    );
    return text(person.principalId);
  }

  async function grant(address: string, granted: Level) {
    const found = responseFields(
      await context.request(`/oae/api/directory?email=${encodeURIComponent(address)}`),
    );
    if (!found.subject) {
      throw new PanelError(
        `Nobody with the email ${address} is in the SSO directory. Add them in Keycloak first, then try again.`,
      );
    }
    if (found.enabled === false) {
      throw new PanelError(`${address} is disabled in the SSO directory.`);
    }
    const principalId = await account(found, address);
    await load();
    // A personal Agent (a Claude subscription token) is for its subscriber alone.
    const others = new Set(
      state.bindings
        .filter(
          (binding) =>
            binding.subjectKind === "identity" &&
            binding.resourceKind === "agent" &&
            binding.resourceId === agent.id &&
            binding.subjectId !== principalId,
        )
        .map((binding) => binding.subjectId),
    );
    if (state.personal && others.size > 0) {
      throw new PanelError(
        `${agent.name} runs on a personal Claude subscription token, so only one person may use it. Remove the person who has access first, or give the Agent an Anthropic API key.`,
      );
    }
    const roleId = await ensureRole(granted);
    // A change of level replaces the other OAE Role's bindings on this Agent.
    const other = state.roles.find(
      (role) => role.name === ROLE_NAMES[granted === "user" ? "operator" : "user"],
    );
    if (other) {
      await unbind(principalId, (binding) => binding.roleId !== other.id);
    }
    await bind(principalId, roleId, "namespace", context.namespaceId);
    await bind(principalId, roleId, "agent", agent.id);
    if (granted === "operator") {
      await bind(principalId, roleId, "configuration", agent.configurationId);
    }
    if (agent.activeRevisionId) {
      await bind(principalId, roleId, "agent_revision", agent.activeRevisionId);
    }
    return `${address} now has ${granted} access to ${agent.name}. It takes effect within about two minutes${granted === "operator" ? "; the Agent redeploys once to admit them" : ""}.`;
  }

  async function revoke(principalId: string) {
    await unbind(principalId);
    const who =
      state.people.find((person) => person.principalId === principalId)?.email ?? principalId;
    return `${who} no longer has access to ${agent.name}. Their open sessions and apps are refused within a minute.`;
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const address = email.value.trim().toLowerCase();
    const granted: Level = level.value === "operator" ? "operator" : "user";
    if (!address) {
      return;
    }
    void run(async () => {
      const done = await grant(address, granted);
      email.value = "";
      return done;
    });
  });

  async function start() {
    try {
      const providers = responseFields(await context.request("/api/auth/providers"));
      if (providers.oidc !== true || !context.isCurrent()) {
        return;
      }
      const status = responseFields(await context.request("/oae/api/status"));
      if (!context.isCurrent()) {
        return;
      }
      appsHint.replaceChildren(
        "People connect the OpenClaw mobile app or Hermes Desktop themselves at ",
        element(
          "a",
          { href: text(status.appsUrl), target: "_blank", rel: "noopener noreferrer" },
          text(status.appsUrl),
        ),
        ".",
      );
      if (status.directory !== true) {
        state.directory = false;
        say(
          "No SSO directory is configured for lookups, so people cannot be added here yet.",
          "error",
        );
      }
      await load();
      section.hidden = false;
      render();
    } catch {
      // Not an administrator, or no edge: the panel stays hidden.
    }
  }
  void start();
  return { section };
}
