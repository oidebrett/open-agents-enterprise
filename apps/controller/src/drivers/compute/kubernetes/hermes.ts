// OAE: Hermes as a native OCE Agent runtime (docs/oae/strikes.md, strike 5b).
//
// An Agent whose model policy selects `agentRuntime.id: "hermes"` gets the approved Harness
// `hermes`/`embedded`: Hermes is both its gateway and its harness, in one workload. This module
// wraps the unchanged Kubernetes Compute Driver: revisions of every other Harness pass straight
// through; `hermes` revisions are prepared here as one Deployment per Agent in the Agent's tenant
// namespace (the official Hermes image, its dashboard on 9119), with the model key copied from the
// revision's resolved Harness authentication and a stable dashboard session token. People reach it
// only through OAE's edge (docs/oae/edge-design.md), which presents that session token for the
// people OCE grants the Agent; the NetworkPolicy admits only the edge.
//
// No OCE schema change: the Configuration stays kind "agent" (its model policy and providers are
// the source of the Hermes config), and the runtime is recorded in AgentRevision.harness as for
// Codex. A Configuration kind would need a migration, which OCE's linear history refuses for forks.
import { createHash, randomBytes } from "node:crypto";

import type {
  AgentRevision,
  ComputeDriver,
  ComputeReadiness,
  ComputeRevisionContext,
  OpenClawConfigurationDocument,
} from "@openclaw-enterprise/contracts";
import type { KubernetesObjectApi, V1Deployment } from "@kubernetes/client-node";
import { numericErrorStatus } from "@openclaw-enterprise/utils";
import { normalizeOpenAiBaseUrl } from "../../openai-endpoint.ts";

/** Harness id selected by `agentRuntime.id: "hermes"`. */
export const HERMES_HARNESS_ID = "hermes";
/**
 * The official Hermes image plus the Microsoft Teams SDK (deploy/oae/runtime-hermes), pinned by
 * digest (multi-arch).
 */
export const HERMES_IMAGE =
  process.env.OAE_HERMES_IMAGE ??
  "docker.io/oideibrett/open-agents-enterprise-hermes@sha256:936a0d721da2ccd17949ca5db5cadae0b96fe48b39bf04b721a1a4fe5c9ffa83";
const DASHBOARD_PORT = 9119;
// Hermes's Teams platform plugin serves Bot Framework's webhook (/api/messages) on its own port.
const TEAMS_PORT = 3978;
const TEAMS_PASSWORD_BINDING = "MSTEAMS_APP_PASSWORD";
const MANAGER = "oae-hermes";
const HERMES_UID = 10000; // the image's "hermes" user
const CONTAINER_SECURITY = {
  allowPrivilegeEscalation: false,
  capabilities: { drop: ["ALL"] },
};
// The edge's proxies (k3s Traefik Pods) — the Pod CIDR, as gatewayTrustedProxyCidrs.
const TRUSTED_PROXY_CIDRS = (process.env.OAE_HERMES_TRUSTED_PROXY_CIDRS ?? "10.42.0.0/16").split(
  ",",
);

type NamespaceAddress = { readonly name: string; readonly plane: "control" | "execution" };
type Clients = {
  readonly objects: KubernetesObjectApi;
  readonly core: CoreReader;
  readonly apps: AppsReader;
};
type SecretObject = {
  metadata?: { uid?: string; deletionTimestamp?: unknown; resourceVersion?: string };
  data?: Record<string, string>;
};
type CoreReader = {
  readNamespacedSecret(args: { name: string; namespace: string }): Promise<SecretObject>;
  createNamespacedSecret(args: {
    namespace: string;
    body: Record<string, unknown>;
  }): Promise<unknown>;
  replaceNamespacedSecret(args: {
    name: string;
    namespace: string;
    body: Record<string, unknown>;
  }): Promise<unknown>;
};
type AppsReader = {
  readNamespacedDeployment(args: { name: string; namespace: string }): Promise<V1Deployment>;
};
// The few Kubernetes Compute internals this module reuses (same clients, RBAC and placement).
type DriverInternals = {
  resolveNamespace(namespaceId: string): Promise<{ readonly name: NamespaceAddress }>;
  controlNamespace(namespaceId: string): Promise<NamespaceAddress>;
  clients(plane: NamespaceAddress["plane"]): Promise<Clients>;
  readonly options: { readonly runtime?: { readonly nodeSelector?: Record<string, string> } };
};

export class HermesConfigurationError extends Error {}

export const isHermesRevision = (revision: Pick<AgentRevision, "harness">): boolean =>
  revision.harness?.id === HERMES_HARNESS_ID;

const short = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 12);
const names = (agentId: string) => {
  const base = `hermes-${short(agentId)}`;
  return { base, env: `${base}-env`, data: `${base}-data`, seed: `${base}-seed` };
};

/** Model settings for Hermes from the Agent's OCE Configuration (its primary model). */
export function hermesModelSettings(configuration: Readonly<OpenClawConfigurationDocument>): {
  readonly provider: "anthropic" | "openai-api" | "custom";
  readonly model: string;
  readonly keyEnvironment: "ANTHROPIC_API_KEY" | "OPENAI_API_KEY";
  /** An OpenAI-compatible endpoint (provider "custom"). */
  readonly baseUrl?: string;
} {
  const agents = configuration.agents as { defaults?: { model?: unknown } } | undefined;
  const selected = agents?.defaults?.model;
  const primary =
    typeof selected === "string" ? selected : (selected as { primary?: unknown })?.primary;
  if (typeof primary !== "string" || !primary.includes("/")) {
    throw new HermesConfigurationError("Hermes needs agents.defaults.model as <provider>/<model>.");
  }
  const slash = primary.indexOf("/");
  const providerId = primary.slice(0, slash);
  const model = primary.slice(slash + 1);
  const providers = (
    configuration.models as { providers?: Record<string, { baseUrl?: unknown }> } | undefined
  )?.providers;
  const baseUrl = String(providers?.[providerId]?.baseUrl ?? "");
  if (providerId === "anthropic") {
    return { provider: "anthropic", model, keyEnvironment: "ANTHROPIC_API_KEY" };
  }
  // The console's OpenAI choice (provider "openai" at api.openai.com) is Hermes's "openai-api".
  if (providerId === "openai" && /^https:\/\/api\.openai\.com(\/|$)/.test(baseUrl)) {
    return { provider: "openai-api", model, keyEnvironment: "OPENAI_API_KEY" };
  }
  // Any other OpenAI-compatible endpoint is Hermes's "custom"
  // provider. Hermes sends OPENAI_API_KEY to a custom host only when OPENAI_BASE_URL names it.
  const endpoint = providerId === "openai" ? normalizeOpenAiBaseUrl(baseUrl) : undefined;
  if (endpoint) {
    return { provider: "custom", model, keyEnvironment: "OPENAI_API_KEY", baseUrl: endpoint };
  }
  throw new HermesConfigurationError(
    "Hermes Agents support Anthropic models and OpenAI-compatible models (models.providers.openai.baseUrl: an HTTPS endpoint ending in /v1).",
  );
}

/**
 * Microsoft Teams for Hermes, from the same `channels.msteams` settings the console's Teams card
 * writes for OpenClaw (docs/oae/teams.md); undefined when Teams is off.
 */
export function hermesTeams(
  configuration: Readonly<OpenClawConfigurationDocument>,
):
  | { readonly appId: string; readonly tenantId: string; readonly allowedUsers?: string }
  | undefined {
  const channels = configuration.channels as Record<string, unknown> | undefined;
  const teams = channels?.msteams as
    | {
        enabled?: unknown;
        appId?: unknown;
        tenantId?: unknown;
        dmPolicy?: unknown;
        allowFrom?: unknown;
      }
    | undefined;
  if (teams === undefined || teams.enabled === false) {
    return undefined;
  }
  const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (typeof teams.appId !== "string" || !guid.test(teams.appId)) {
    throw new HermesConfigurationError("Hermes Teams needs channels.msteams.appId (a GUID).");
  }
  if (typeof teams.tenantId !== "string" || !guid.test(teams.tenantId)) {
    throw new HermesConfigurationError("Hermes Teams needs channels.msteams.tenantId (a GUID).");
  }
  const allowFrom = Array.isArray(teams.allowFrom)
    ? teams.allowFrom.filter((id): id is string => typeof id === "string")
    : [];
  // "open" (or allowFrom ["*"]) admits anyone in the bot's tenant; otherwise the listed users.
  const open = teams.dmPolicy === "open" || allowFrom.includes("*");
  return {
    appId: teams.appId,
    tenantId: teams.tenantId,
    ...(open ? {} : { allowedUsers: allowFrom.join(",") }),
  };
}

function hermesConfigYaml(
  settings: ReturnType<typeof hermesModelSettings>,
  publicUrl?: string,
): string {
  const lines = [
    "model:",
    `  provider: ${settings.provider}`,
    `  default: ${JSON.stringify(settings.model)}`,
    ...(settings.baseUrl ? [`  base_url: ${JSON.stringify(settings.baseUrl)}`] : []),
    "dashboard:",
    `  trusted_proxies: ${JSON.stringify(TRUSTED_PROXY_CIDRS)}`,
  ];
  if (publicUrl) {
    lines.push(`  public_url: ${JSON.stringify(publicUrl)}`);
  }
  return `${lines.join("\n")}\n`;
}

/** The Agent's public host, as OAE's edge derives it (oae-edge sync). */
export function hermesPublicUrl(
  installationId: string | undefined,
  revision: AgentRevision,
): string | undefined {
  const host = process.env.OAE_EDGE_AGENTS_DOMAIN;
  if (!installationId || !host) {
    return undefined;
  }
  const hash = createHash("sha256")
    .update(`${installationId}\0${revision.namespaceId}\0${revision.agentId}`)
    .digest("hex")
    .slice(0, 32);
  return `https://agent-${hash}.${host}`;
}

class HermesWorkloads {
  private readonly driver: DriverInternals;

  constructor(driver: DriverInternals) {
    this.driver = driver;
  }

  private async target(revision: AgentRevision) {
    const namespace = (await this.driver.resolveNamespace(revision.namespaceId)).name;
    return { namespace, clients: await this.driver.clients(namespace.plane) };
  }

  // Server-side apply. Scaling uses its own field manager: an apply with the workload's manager
  // and only `replicas` would remove every other field that manager owns.
  private async apply(clients: Clients, manifest: Record<string, unknown>, manager = MANAGER) {
    await clients.objects.patch(
      manifest as never,
      undefined,
      undefined,
      manager,
      true,
      "application/apply-patch+yaml" as never,
    );
  }

  /** The model key, copied from the source Secret the revision's binding resolved (uid-checked). */
  private async modelKey(revision: AgentRevision, context: ComputeRevisionContext | undefined) {
    const auth = context?.harnessAuth as
      { method?: string; backendRef?: { name: string; key: string; uid: string } } | undefined;
    if (!auth || auth.method !== "api_key" || !auth.backendRef) {
      throw new HermesConfigurationError(
        "Hermes Agents need an api_key Harness authentication from a Secret.",
      );
    }
    const source = await this.driver.controlNamespace(revision.namespaceId);
    const control = await this.driver.clients(source.plane);
    const secret = await control.core.readNamespacedSecret({
      name: auth.backendRef.name,
      namespace: source.name,
    });
    if (secret.metadata?.deletionTimestamp || secret.metadata?.uid !== auth.backendRef.uid) {
      throw new HermesConfigurationError(
        "The Hermes model key Secret changed identity or is being deleted.",
      );
    }
    const value = secret.data?.[auth.backendRef.key];
    if (!value) {
      throw new HermesConfigurationError("The Hermes model key Secret has no value.");
    }
    return value; // base64, as Secret data
  }

  /** Hermes's TEAMS_* settings; the app password from its Secret binding (uid-checked). */
  private async teamsEnvironment(
    revision: AgentRevision,
    context: ComputeRevisionContext | undefined,
    teams: NonNullable<ReturnType<typeof hermesTeams>>,
  ): Promise<Record<string, string>> {
    const projection = context?.secretEnvironment?.find(
      (each) => each.name === TEAMS_PASSWORD_BINDING,
    );
    if (!projection) {
      throw new HermesConfigurationError(
        `Hermes Teams needs the ${TEAMS_PASSWORD_BINDING} Secret binding (the Azure Bot's client secret).`,
      );
    }
    const source = await this.driver.controlNamespace(revision.namespaceId);
    if (projection.backendRef.namespaceName !== source.name) {
      throw new HermesConfigurationError("The Teams app password Secret is in another namespace.");
    }
    const control = await this.driver.clients(source.plane);
    const secret = await control.core.readNamespacedSecret({
      name: projection.backendRef.name,
      namespace: source.name,
    });
    if (secret.metadata?.deletionTimestamp || secret.metadata?.uid !== projection.backendRef.uid) {
      throw new HermesConfigurationError(
        "The Teams app password Secret changed identity or is being deleted.",
      );
    }
    const password = secret.data?.[projection.backendRef.key];
    if (!password) {
      throw new HermesConfigurationError("The Teams app password Secret has no value.");
    }
    const b64 = (value: string) => Buffer.from(value).toString("base64");
    return {
      TEAMS_CLIENT_ID: b64(teams.appId),
      TEAMS_TENANT_ID: b64(teams.tenantId),
      TEAMS_CLIENT_SECRET: password, // base64, as Secret data
      TEAMS_PORT: b64(String(TEAMS_PORT)),
      ...(teams.allowedUsers === undefined
        ? { TEAMS_ALLOW_ALL_USERS: b64("true") }
        : { TEAMS_ALLOWED_USERS: b64(teams.allowedUsers) }),
    };
  }

  async prepare(
    revision: AgentRevision,
    context?: ComputeRevisionContext,
  ): Promise<ComputeReadiness> {
    const result = {
      namespaceId: revision.namespaceId,
      agentId: revision.agentId,
      revisionId: revision.id,
    };
    const settings = hermesModelSettings(revision.configuration);
    const teams = hermesTeams(revision.configuration);
    const { namespace, clients } = await this.target(revision);
    const n = names(revision.agentId);
    const labels = {
      "app.kubernetes.io/managed-by": MANAGER,
      "openclaw.dev/agent": revision.agentId,
      "openclaw.dev/namespace": revision.namespaceId,
      "oae.dev/runtime": "hermes",
    };
    const meta = (name: string) => ({ name, namespace: namespace.name, labels });

    // A stable session token per Agent (the edge reads it); the model key follows the binding.
    // The worker may create and replace Secrets but not patch them (OCE's tenant Role), so no apply.
    let existing: SecretObject | undefined;
    try {
      existing = await clients.core.readNamespacedSecret({
        name: n.env,
        namespace: namespace.name,
      });
    } catch (error) {
      if (numericErrorStatus(error) !== 404) {
        throw error;
      }
    }
    const token =
      existing?.data?.HERMES_DASHBOARD_SESSION_TOKEN ??
      Buffer.from(randomBytes(32).toString("hex")).toString("base64");
    const secret = {
      apiVersion: "v1",
      kind: "Secret",
      metadata: { ...meta(n.env), resourceVersion: existing?.metadata?.resourceVersion },
      type: "Opaque",
      data: {
        [settings.keyEnvironment]: await this.modelKey(revision, context),
        ...(settings.baseUrl
          ? { OPENAI_BASE_URL: Buffer.from(settings.baseUrl).toString("base64") }
          : {}),
        HERMES_DASHBOARD_SESSION_TOKEN: token,
        ...(teams ? await this.teamsEnvironment(revision, context, teams) : {}),
      },
    };
    await (existing
      ? clients.core.replaceNamespacedSecret({
          name: n.env,
          namespace: namespace.name,
          body: secret,
        })
      : clients.core.createNamespacedSecret({ namespace: namespace.name, body: secret }));
    await this.apply(clients, {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: meta(n.seed),
      data: {
        "config.yaml": hermesConfigYaml(
          settings,
          hermesPublicUrl(process.env.OAE_INSTALLATION_ID, revision),
        ),
      },
    });
    await this.apply(clients, {
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: meta(n.data),
      spec: { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: "10Gi" } } },
    });
    const selector = { "openclaw.dev/agent": revision.agentId, "oae.dev/runtime": "hermes" };
    await this.apply(clients, {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { ...meta(n.base), annotations: { "openclaw.dev/revision": revision.id } },
      spec: {
        replicas: 1,
        strategy: { type: "Recreate" },
        selector: { matchLabels: selector },
        template: {
          metadata: {
            labels: { ...labels, "openclaw.dev/workload-role": "gateway" },
            annotations: { "openclaw.dev/revision": revision.id },
          },
          spec: {
            automountServiceAccountToken: false,
            nodeSelector: this.driver.options.runtime?.nodeSelector,
            // OCE tenant namespaces enforce Pod Security "restricted"; Hermes runs as its own user.
            securityContext: {
              runAsNonRoot: true,
              runAsUser: HERMES_UID,
              runAsGroup: HERMES_UID,
              fsGroup: HERMES_UID,
              seccompProfile: { type: "RuntimeDefault" },
            },
            initContainers: [
              {
                name: "seed-config",
                image: HERMES_IMAGE,
                // The model policy is OCE's; everything else the Agent changes in Hermes is kept.
                command: [
                  "sh",
                  "-c",
                  // Hermes wants a home it owns with mode 0700; volume roots need not be (local-path
                  // ignores fsGroup), so the home is a directory on the volume, made by this user.
                  // Hermes' own YAML library (ruamel, round-trip: the Agent's comments survive).
                  "mkdir -p /volume/home && chmod 700 /volume/home && " +
                    "if [ -f /volume/home/config.yaml ]; then /opt/hermes/.venv/bin/python - <<'PY'\n" +
                    "from ruamel.yaml import YAML\n" +
                    "y = YAML()\n" +
                    "seed = y.load(open('/seed/config.yaml'))\n" +
                    "cur = y.load(open('/volume/home/config.yaml')) or {}\n" +
                    "for section in ('model', 'dashboard'):\n" +
                    "    cur.setdefault(section, {})\n" +
                    "    cur[section] = cur[section] or {}\n" +
                    "    if section == 'model':\n" +
                    "        cur[section].pop('base_url', None)\n" +
                    "    cur[section].update(seed[section])\n" +
                    "y.dump(cur, open('/volume/home/config.yaml', 'w'))\n" +
                    "PY\nelse cp /seed/config.yaml /volume/home/config.yaml; fi",
                ],
                securityContext: CONTAINER_SECURITY,
                volumeMounts: [
                  { name: "data", mountPath: "/volume" },
                  { name: "seed", mountPath: "/seed" },
                ],
              },
            ],
            containers: [
              {
                // s6 supervises the gateway and, with HERMES_DASHBOARD, the dashboard in one tree.
                name: "hermes",
                image: HERMES_IMAGE,
                args: ["gateway", "run"],
                env: [
                  { name: "HERMES_DASHBOARD", value: "1" },
                  // s6-overlay runs unprivileged; /run is an emptyDir, world-writable as Kubernetes makes it.
                  { name: "S6_YES_I_WANT_A_WORLD_WRITABLE_RUN_BECAUSE_KUBERNETES", value: "1" },
                ],
                envFrom: [{ secretRef: { name: n.env } }],
                ports: [
                  { name: "http", containerPort: DASHBOARD_PORT },
                  ...(teams ? [{ name: "teams", containerPort: TEAMS_PORT }] : []),
                ],
                readinessProbe: {
                  httpGet: { path: "/api/status", port: "http" },
                  periodSeconds: 10,
                },
                securityContext: CONTAINER_SECURITY,
                volumeMounts: [
                  { name: "data", mountPath: "/opt/data", subPath: "home" },
                  { name: "run", mountPath: "/run" },
                ],
                resources: {
                  requests: { cpu: "100m", memory: "768Mi" },
                  limits: { memory: "4Gi" },
                },
              },
            ],
            volumes: [
              { name: "data", persistentVolumeClaim: { claimName: n.data } },
              { name: "seed", configMap: { name: n.seed } },
              { name: "run", emptyDir: { medium: "Memory", sizeLimit: "64Mi" } },
            ],
          },
        },
      },
    });
    await this.apply(clients, {
      apiVersion: "v1",
      kind: "Service",
      metadata: meta(n.base),
      spec: {
        selector,
        ports: [
          { name: "http", port: DASHBOARD_PORT, targetPort: "http" },
          ...(teams ? [{ name: "teams", port: TEAMS_PORT, targetPort: "teams" }] : []),
        ],
      },
    });
    await this.apply(clients, {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: meta(n.base),
      spec: {
        podSelector: { matchLabels: selector },
        policyTypes: ["Ingress", "Egress"],
        // Only the edge (k3s Traefik) reaches the dashboard.
        ingress: [
          {
            from: [
              {
                namespaceSelector: {
                  matchLabels: { "kubernetes.io/metadata.name": "kube-system" },
                },
                podSelector: { matchLabels: { "app.kubernetes.io/name": "traefik" } },
              },
            ],
            ports: [
              { protocol: "TCP", port: DASHBOARD_PORT },
              ...(teams ? [{ protocol: "TCP", port: TEAMS_PORT }] : []),
            ],
          },
        ],
        // DNS, and HTTPS anywhere public (model API, channels).
        egress: [
          {
            to: [
              { namespaceSelector: {}, podSelector: { matchLabels: { "k8s-app": "kube-dns" } } },
            ],
            ports: [
              { protocol: "UDP", port: 53 },
              { protocol: "TCP", port: 53 },
            ],
          },
          {
            to: [
              {
                ipBlock: {
                  cidr: "0.0.0.0/0",
                  except: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"],
                },
              },
            ],
            ports: [{ protocol: "TCP", port: 443 }],
          },
        ],
      },
    });
    return { ...result, ready: await this.ready(clients, namespace.name, n.base, revision.id) };
  }

  private async ready(clients: Clients, namespace: string, name: string, revisionId: string) {
    try {
      const deployment = await clients.apps.readNamespacedDeployment({ name, namespace });
      return (
        deployment.metadata?.annotations?.["openclaw.dev/revision"] === revisionId &&
        (deployment.status?.observedGeneration ?? 0) >= (deployment.metadata?.generation ?? 1) &&
        (deployment.status?.updatedReplicas ?? 0) >= 1 &&
        (deployment.status?.availableReplicas ?? 0) >= 1
      );
    } catch {
      return false;
    }
  }

  private async scale(revision: AgentRevision, replicas: number) {
    const { namespace, clients } = await this.target(revision);
    const n = names(revision.agentId);
    try {
      const deployment = await clients.apps.readNamespacedDeployment({
        name: n.base,
        namespace: namespace.name,
      });
      // Only the revision the workload currently serves may stop it.
      if (deployment.metadata?.annotations?.["openclaw.dev/revision"] !== revision.id) {
        return;
      }
    } catch {
      return;
    }
    await this.apply(
      clients,
      {
        apiVersion: "apps/v1",
        kind: "Deployment",
        metadata: { name: n.base, namespace: namespace.name },
        spec: { replicas },
      },
      `${MANAGER}-scale`,
    );
  }

  stop(revision: AgentRevision) {
    return this.scale(revision, 0);
  }

  /** Retiring the serving revision (Agent deletion) removes the workload; data stays until the
   *  Namespace is deleted, as OCE keeps gateway storage across redeploys. */
  async retire(revision: AgentRevision) {
    const { namespace, clients } = await this.target(revision);
    const n = names(revision.agentId);
    let serving: boolean;
    try {
      const deployment = await clients.apps.readNamespacedDeployment({
        name: n.base,
        namespace: namespace.name,
      });
      serving = deployment.metadata?.annotations?.["openclaw.dev/revision"] === revision.id;
    } catch {
      return;
    }
    if (!serving) {
      return;
    }
    for (const [apiVersion, kind, name] of [
      ["apps/v1", "Deployment", n.base],
      ["v1", "Service", n.base],
      ["networking.k8s.io/v1", "NetworkPolicy", n.base],
      ["v1", "ConfigMap", n.seed],
      ["v1", "Secret", n.env],
    ] as const) {
      try {
        await clients.objects.delete({
          apiVersion,
          kind,
          metadata: { name, namespace: namespace.name },
        } as never);
      } catch {
        // already gone
      }
    }
  }
}

/**
 * Wraps a Kubernetes Compute Driver so `hermes` revisions are prepared by HermesWorkloads and every
 * other revision reaches the wrapped driver unchanged.
 */
export function withHermesRuntime<T extends ComputeDriver>(driver: T): T {
  const hermes = new HermesWorkloads(driver as unknown as DriverInternals);
  const overrides: Partial<Record<keyof ComputeDriver, unknown>> = {
    prepareRevision: (revision: AgentRevision, context?: ComputeRevisionContext) =>
      isHermesRevision(revision)
        ? hermes.prepare(revision, context)
        : driver.prepareRevision(revision, context),
    activateRevision: (revision: AgentRevision, context?: ComputeRevisionContext) =>
      isHermesRevision(revision) ? Promise.resolve() : driver.activateRevision?.(revision, context),
    deactivateRevision: (revision: AgentRevision) =>
      isHermesRevision(revision) ? Promise.resolve() : driver.deactivateRevision?.(revision),
    stopRevision: (revision: AgentRevision) =>
      isHermesRevision(revision) ? hermes.stop(revision) : driver.stopRevision(revision),
    retireRevision: (revision: AgentRevision) =>
      isHermesRevision(revision) ? hermes.retire(revision) : driver.retireRevision(revision),
    admitRevision: (revision: Readonly<AgentRevision>) =>
      isHermesRevision(revision) ? undefined : driver.admitRevision?.(revision),
    requiresStoppedPredecessors: (revision: AgentRevision) =>
      isHermesRevision(revision)
        ? false
        : (driver.requiresStoppedPredecessors?.(revision) ?? false),
    getRuntimeImages: (revision: AgentRevision) =>
      isHermesRevision(revision)
        ? Promise.resolve([])
        : (driver.getRuntimeImages?.(revision) ?? Promise.resolve([])),
    getGatewayEndpoint: (revision: AgentRevision) =>
      isHermesRevision(revision) ? undefined : driver.getGatewayEndpoint?.(revision),
    validateHarnessAuth: (harness: { id: string }, ...rest: unknown[]) =>
      harness.id === HERMES_HARNESS_ID
        ? undefined
        : (driver.validateHarnessAuth as (...args: unknown[]) => unknown)?.call(
            driver,
            harness,
            ...rest,
          ),
  };
  return new Proxy(driver, {
    get(target, property, receiver) {
      if (
        Object.hasOwn(overrides, property) &&
        typeof Reflect.get(target, property) === "function"
      ) {
        return overrides[property as keyof ComputeDriver];
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
