// OAE: Microsoft Teams channel editor (OpenClaw's msteams plugin). Teams runs on Embedded Agents
// without the channel runtime; Bot Framework posts to https://<agent host>/api/messages, which
// the OAE edge routes to the gateway (docs/oae/teams.md).
import type { SecretMetadata } from "@openclaw-enterprise/contracts";
import { element } from "../dom.mjs";
import { createSecretReferenceField, secretBinding } from "../agents/secret-picker.mjs";
import {
  type ChannelDrawerContext,
  type ChannelProvider,
  type ChannelSupport,
  type ChannelValues,
  isRecord,
  refsEqual,
  providerConfig,
  withProvider,
  field,
  input,
  checkbox,
  uniqueList,
  arrayOfStrings,
} from "./shared-ui.mjs";

export const MSTEAMS_SECRET_BINDINGS = [
  {
    key: "MSTEAMS_APP_PASSWORD",
    label: "Teams app password",
    secretName: "Teams app password",
  },
] as const;
const [PASSWORD] = MSTEAMS_SECRET_BINDINGS;
const PASSWORD_REF = { source: "env", provider: "default", id: PASSWORD.key };
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DM_POLICIES = ["open", "allowlist", "pairing", "disabled"];

type TeamsConfig = ChannelValues & {
  appId?: string;
  tenantId?: string;
  appPassword?: unknown;
  dmPolicy?: string;
  allowFrom?: string[];
};

function supportTeams(values: ChannelValues): ChannelSupport<TeamsConfig> {
  if (values?.channels !== undefined && !isRecord(values.channels)) {
    return {
      supported: false,
      reason: "Native channels configuration is not an object.",
      config: values.channels,
    };
  }
  const config = providerConfig(values, "msteams");
  if (config === undefined) {
    return { supported: true, config: {} };
  }
  if (!isRecord(config)) {
    return { supported: false, reason: "Teams configuration is not an object.", config };
  }
  if (config.enabled !== undefined && typeof config.enabled !== "boolean") {
    return { supported: false, reason: "Teams enabled state is not boolean.", config };
  }
  if (config.accounts !== undefined) {
    return {
      supported: false,
      reason:
        "Only the default Teams bot is supported by this editor. Edit named accounts in the native JSON.",
      config,
    };
  }
  if (
    isRecord(config.webhook) &&
    config.webhook.path !== undefined &&
    config.webhook.path !== "/api/messages"
  ) {
    return {
      supported: false,
      reason: "This editor uses the webhook path /api/messages, the one the OAE edge routes.",
      config,
    };
  }
  const password = config.appPassword;
  if (
    password !== undefined &&
    !refsEqual(password, PASSWORD_REF) &&
    password !== `\${${PASSWORD.key}}`
  ) {
    return {
      supported: false,
      reason: `The Teams app password must be the ${PASSWORD.key} Secret binding to edit Teams here. Set appPassword to \${${PASSWORD.key}} in the Configuration JSON.`,
      config,
    };
  }
  if (config.allowFrom !== undefined && !arrayOfStrings(config.allowFrom)) {
    return { supported: false, reason: "Teams allowFrom is not a list of IDs.", config };
  }
  return { supported: true, config: config as TeamsConfig };
}

function value(body: HTMLFormElement, id: string) {
  return body.querySelector<HTMLInputElement | HTMLSelectElement>(`#${id}`)!.value.trim();
}

function updatedTeams(values: ChannelValues, body: HTMLFormElement) {
  const support = supportTeams(values);
  if (!support.supported) {
    throw new Error(support.reason);
  }
  const current = support.config;
  const dmPolicy = value(body, "msteams-dm-policy");
  const config: TeamsConfig = {
    ...current,
    enabled: body.querySelector<HTMLInputElement>("#msteams-enabled")!.checked,
    appId: value(body, "msteams-app-id").toLowerCase(),
    tenantId: value(body, "msteams-tenant-id").toLowerCase(),
    appPassword: current.appPassword ?? PASSWORD_REF,
    dmPolicy,
  };
  if (dmPolicy === "open") {
    config.allowFrom = ["*"];
  } else if (dmPolicy === "allowlist") {
    config.allowFrom = uniqueList(value(body, "msteams-dm-user-ids").split(","));
  } else {
    delete config.allowFrom;
  }
  return withProvider(values, "msteams", config);
}

function activeSecretBindings(context: ChannelDrawerContext) {
  return context.draftSecretBindings ?? context.secretBindings ?? {};
}

function updatedSecretBindings(context: ChannelDrawerContext) {
  if (context.draftSecretBindings === undefined) {
    return undefined;
  }
  const secret = context.draftChangedSecrets?.[PASSWORD.key];
  return {
    secretBindings: context.draftSecretBindings,
    changedSecrets: secret === undefined ? [] : [secret],
  };
}

function bindSecret(context: ChannelDrawerContext, secret: SecretMetadata) {
  context.draftSecretBindings = {
    ...activeSecretBindings(context),
    [PASSWORD.key]: secretBinding(secret),
  };
  context.draftChangedSecrets = { ...(context.draftChangedSecrets ?? {}), [PASSWORD.key]: secret };
}

function agentName(context: ChannelDrawerContext) {
  const name = typeof context.agentName === "function" ? context.agentName() : context.agentName;
  return typeof name === "string" && name.trim().length ? name.trim() : "Teams";
}

function appendFields(body: HTMLFormElement, config: TeamsConfig, context: ChannelDrawerContext) {
  const dmPolicy = DM_POLICIES.includes(config.dmPolicy ?? "") ? config.dmPolicy! : "open";
  const policy = element(
    "select",
    { id: "msteams-dm-policy", className: "channel-select" },
    element("option", { value: "open" }, "Anyone in the bot's tenant"),
    element("option", { value: "allowlist" }, "Only the Microsoft Entra user IDs listed below"),
    element("option", { value: "pairing" }, "Pairing: approve each new person in the Agent"),
    element("option", { value: "disabled" }, "Disabled"),
  );
  policy.value = dmPolicy;
  const allowed = (config.allowFrom ?? []).filter((id) => id !== "*");
  const dmUsers = input("msteams-dm-user-ids", allowed.join(", "));
  const dmUsersField = field(
    "Allowed Entra user object IDs",
    dmUsers,
    "Comma-separated. Used only with the allowlist policy.",
  );
  const syncPolicy = () => {
    dmUsersField.hidden = policy.value !== "allowlist";
  };
  policy.addEventListener("change", syncPolicy);
  syncPolicy();
  const endpoint = element(
    "p",
    { className: "hint", id: "msteams-endpoint" },
    "In your Azure Bot (Settings → Configuration), set the Messaging endpoint to this Agent's address followed by /api/messages.",
  );
  void context.messagingEndpoint?.().then(
    (url) => {
      if (url) {
        endpoint.replaceChildren(
          "In your Azure Bot (Settings → Configuration), set the Messaging endpoint to ",
          element("code", {}, url),
          ". Microsoft calls it without signing in; the plugin verifies Microsoft's signed token on every request.",
        );
      }
    },
    () => {},
  );
  const picker = createSecretReferenceField({
    context,
    id: "msteams-secret-app-password",
    label: PASSWORD.label,
    getCurrentSource: () => activeSecretBindings(context)[PASSWORD.key]?.source,
    onSecretSelected: (secret) => bindSecret(context, secret),
    createSecretName: () => `${agentName(context)} ${PASSWORD.secretName}`,
    createDialogTitle: `Create ${PASSWORD.label} Secret`,
    createFixedKey: {
      label: "Binding key",
      value: PASSWORD.key,
      hint: "The Azure Bot's client secret value (Certificates & secrets). This environment key is fixed for Teams.",
    },
    metadataLabel: "View Teams app password Secret metadata",
    ...(context.creating
      ? { stagedHint: "Secret selected. Apply channel settings, then Create Agent binds it." }
      : {}),
    fieldClassName: "channel-field channel-reference",
    selectClassName: "channel-select",
  });
  body.append(
    checkbox("msteams-enabled", "Enable Microsoft Teams", config.enabled !== false),
    field(
      "Microsoft App ID",
      input("msteams-app-id", config.appId ?? "", {
        required: true,
        autocomplete: "off",
        placeholder: "00000000-0000-0000-0000-000000000000",
      }),
      "Azure Bot → Settings → Configuration → Microsoft App ID.",
    ),
    field(
      "App Tenant ID",
      input("msteams-tenant-id", config.tenantId ?? "", {
        required: true,
        autocomplete: "off",
        placeholder: "00000000-0000-0000-0000-000000000000",
      }),
      "The Microsoft Entra tenant of a Single Tenant bot.",
    ),
    picker.field,
    endpoint,
    field("Direct messages", policy),
    dmUsersField,
  );
}

function summary(config: TeamsConfig, status: { label: string }) {
  return status.label === "Not configured"
    ? "Bot Framework webhook · Embedded Agents"
    : [
        "Bot Framework webhook",
        config.appId ? `App ${config.appId.slice(0, 8)}…` : "No App ID",
        `Direct messages: ${config.dmPolicy ?? "pairing"}`,
      ].join(" · ");
}

export const msteams = {
  id: "msteams",
  name: "Microsoft Teams",
  description: "Bot Framework messages from Teams or an Azure Bot's Web Chat.",
  setup:
    "Register an Azure Bot, then provide its App ID, Tenant ID and the MSTEAMS_APP_PASSWORD Secret binding.",
  plugin: "msteams",
  embedded: true,
  secretBindings: MSTEAMS_SECRET_BINDINGS,
  listFields: ["msteams-dm-user-ids"],
  support: supportTeams,
  validate(body) {
    if (!GUID.test(value(body, "msteams-app-id"))) {
      return "Enter the Microsoft App ID, a GUID such as 00000000-0000-0000-0000-000000000000.";
    }
    if (!GUID.test(value(body, "msteams-tenant-id"))) {
      return "Enter the App Tenant ID, a GUID such as 00000000-0000-0000-0000-000000000000.";
    }
    if (value(body, "msteams-dm-policy") === "allowlist") {
      const users = uniqueList(value(body, "msteams-dm-user-ids").split(","));
      if (users.length === 0 || users.includes("*")) {
        return "Enter specific Entra user object IDs, or choose a different direct-message policy.";
      }
    }
    return null;
  },
  updatedValues: updatedTeams,
  updatedSecretBindings,
  appendFields,
  summary,
} satisfies ChannelProvider<TeamsConfig>;
