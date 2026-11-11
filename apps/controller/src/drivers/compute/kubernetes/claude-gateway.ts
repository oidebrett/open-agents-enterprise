// OAE: Claude Gateway as a native OCE Agent runtime (docs/oae/claude-gateway.md).
//
// An Agent whose model policy selects `agentRuntime.id: "claude-gateway"` gets the approved
// Harness `claude-gateway`/`embedded`: Anthropic's own `claude gateway`, which people's Claude
// Code and Claude Desktop sign in to. Like Hermes (hermes.ts) this module wraps the unchanged
// Kubernetes Compute Driver and prepares one workload per Agent in its tenant namespace:
//
//   init  fetch-claude   the pinned Claude Code release from Anthropic, checksum-verified against
//                        its manifest, cached on the Agent's volume (OAE never ships the binary)
//   init  render-config  gateway.yaml from this module's template + the sign-in Secret
//   gateway              `claude gateway` on 8443 (its own TLS; clients pin the certificate)
//   pii-masker           the gateway's upstream on 127.0.0.1:8080 (as http://pii-masker:8080), the
//                        only holder of the key
//   postgres             gateway sessions, on the Agent's volume
//
// The host's `oae-claude-sync` (deploy/oae/claude-gateway) gives each gateway its private name's
// certificate (`<base>-tls`), its Keycloak client (`<base>-oidc`) and a WireGuard endpoint that
// reaches the NodePort Service; people connect laptops from /apps. Until the sync has run, the Pod
// waits for those two Secrets. No OCE schema change: the Configuration stays kind "agent".
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

/** Harness id selected by `agentRuntime.id: "claude-gateway"`. */
export const CLAUDE_GATEWAY_HARNESS_ID = "claude-gateway";
/** The Claude Code release whose `claude gateway` runs (its config schema changes between releases). */
export const CLAUDE_CODE_VERSION = process.env.OAE_CLAUDE_CODE_VERSION ?? "2.1.311";
const IMAGES = {
  // curl + busybox sh/sed/sha256sum for the two init steps.
  fetch:
    process.env.OAE_CLAUDE_FETCH_IMAGE ??
    "docker.io/curlimages/curl:8.17.0@sha256:935d9100e9ba842cdb060de42472c7ca90cfe9a7c96e4dacb55e79e560b3ff40",
  // glibc + CA certificates, no shell: enough for the self-contained claude binary.
  gateway:
    process.env.OAE_CLAUDE_GATEWAY_IMAGE ??
    "gcr.io/distroless/cc-debian12:nonroot@sha256:9dac0a79194e45a7da0158a9c6da57b217585af0786db3845d1f0ec1a0dd182f",
  // oidebrett/inference-router router/anthropic_masker, pinned by digest (multi-arch).
  masker:
    process.env.OAE_CLAUDE_MASKER_IMAGE ??
    "docker.io/oideibrett/oae-pii-masker@sha256:250ff8d5c68387540e12de7b73b9e1134e8d63e9fdeb8907f377ff3960fd97fc",
  postgres:
    process.env.OAE_CLAUDE_POSTGRES_IMAGE ??
    "docker.io/library/postgres:16-alpine@sha256:aa6cb33cf4c19c765cefcf48d96176258800870a9a1e930ad126200f9d825139",
};
/** The private DNS domain of gateway names (the host CA is name-constrained to it). */
export const CLAUDE_DOMAIN = process.env.OAE_CLAUDE_DOMAIN ?? "oae.internal";
const GATEWAY_PORT = 8443;
const MANAGER = "oae-claude-gateway";
const UID = 65532; // distroless "nonroot"; also used for the init steps
const CONTAINER_SECURITY = {
  allowPrivilegeEscalation: false,
  capabilities: { drop: ["ALL"] },
};
// The cluster's Pod CIDR: Pods do not reach the gateway (people come through WireGuard).
const POD_CIDR = process.env.OAE_POD_CIDR ?? "10.42.0.0/16";

type NamespaceAddress = { readonly name: string; readonly plane: "control" | "execution" };
type SecretObject = {
  metadata?: { uid?: string; deletionTimestamp?: unknown; resourceVersion?: string };
  data?: Record<string, string>;
};
type Clients = {
  readonly objects: KubernetesObjectApi;
  readonly core: {
    readNamespacedSecret(args: { name: string; namespace: string }): Promise<SecretObject>;
    createNamespacedSecret(args: { namespace: string; body: Record<string, unknown> }): Promise<unknown>;
    replaceNamespacedSecret(args: {
      name: string;
      namespace: string;
      body: Record<string, unknown>;
    }): Promise<unknown>;
  };
  readonly apps: {
    readNamespacedDeployment(args: { name: string; namespace: string }): Promise<V1Deployment>;
  };
};
type DriverInternals = {
  resolveNamespace(namespaceId: string): Promise<{ readonly name: NamespaceAddress }>;
  controlNamespace(namespaceId: string): Promise<NamespaceAddress>;
  clients(plane: NamespaceAddress["plane"]): Promise<Clients>;
  readonly options: { readonly runtime?: { readonly nodeSelector?: Record<string, string> } };
};

export class ClaudeGatewayConfigurationError extends Error {}

export const isClaudeGatewayRevision = (revision: Pick<AgentRevision, "harness">): boolean =>
  revision.harness?.id === CLAUDE_GATEWAY_HARNESS_ID;

const short = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 12);
export const claudeGatewayNames = (agentId: string) => {
  const base = `claude-gw-${short(agentId)}`;
  return {
    base,
    env: `${base}-env`, // generated secrets + the Anthropic key (masker only)
    oidc: `${base}-oidc`, // written by oae-claude-sync: issuer, client, allowed email domains
    tls: `${base}-tls`, // written by oae-claude-sync: tls.crt, tls.key, ca.crt
    config: `${base}-config`,
    data: `${base}-data`,
  };
};

/** The gateway's private name, e.g. claude-<hash>.oae.internal; oae-claude-sync reads it from the
 *  Service annotation, so only this module derives it. */
export function claudeGatewayHost(
  installationId: string | undefined,
  revision: Pick<AgentRevision, "namespaceId" | "agentId">,
): string {
  const hash = createHash("sha256")
    .update(`${installationId ?? ""}\0${revision.namespaceId}\0${revision.agentId}`)
    .digest("hex")
    .slice(0, 16);
  return `claude-${hash}.${CLAUDE_DOMAIN}`;
}

/**
 * The models people may use, from the Agent's OCE Configuration: the Anthropic entries of
 * `agents.defaults.models` (OpenClaw's allowlist), else the primary model.
 */
export function claudeGatewayModels(configuration: Readonly<OpenClawConfigurationDocument>): string[] {
  const defaults = (configuration.agents as { defaults?: { model?: unknown; models?: unknown } })
    ?.defaults;
  const refs = new Set<string>();
  if (defaults?.models && typeof defaults.models === "object") {
    for (const ref of Object.keys(defaults.models as Record<string, unknown>)) refs.add(ref);
  }
  const selected = defaults?.model;
  const primary =
    typeof selected === "string" ? selected : (selected as { primary?: unknown })?.primary;
  if (refs.size === 0 && typeof primary === "string") refs.add(primary);
  const models = [...refs]
    .filter((ref) => ref.startsWith("anthropic/"))
    .map((ref) => ref.slice("anthropic/".length))
    .filter((model) => /^claude-[a-z0-9.-]{1,60}$/.test(model));
  if (models.length === 0) {
    throw new ClaudeGatewayConfigurationError(
      "A Claude Gateway needs at least one Anthropic model (agents.defaults.model anthropic/claude-…).",
    );
  }
  return models.sort();
}

/** gateway.yaml with @@OIDC_*@@ placeholders the render-config step fills from `<base>-oidc`.
 *  ${VAR} values are secrets the gateway itself reads from its environment. */
export function claudeGatewayConfigTemplate(host: string, models: readonly string[]): string {
  return [
    "listen:",
    "  host: 0.0.0.0",
    `  port: ${GATEWAY_PORT}`,
    `  public_url: https://${host}:${GATEWAY_PORT}`,
    "  tls: { cert: /tls/tls.crt, key: /tls/tls.key }",
    "oidc:",
    "  issuer: @@OIDC_ISSUER@@",
    "  client_id: @@OIDC_CLIENT_ID@@",
    "  client_secret: ${OIDC_CLIENT_SECRET}",
    "  allowed_email_domains: [@@OIDC_EMAIL_DOMAINS@@]",
    "  scopes: [openid, profile, email, offline_access, groups]",
    "session:",
    "  jwt_secret: ${GATEWAY_JWT_SECRET}",
    "  ttl_hours: 1",
    "store:",
    "  postgres_url: ${GATEWAY_POSTGRES_URL}",
    "upstreams:",
    "  - provider: anthropic",
    "    base_url: http://pii-masker:8080",
    "    auth:",
    "      api_key: ${MASKER_KEY}",
    "    forward_user_identity: true",
    "access_control:",
    "  allow_cidrs: [10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10, 127.0.0.0/8]",
    "managed:",
    "  policies:",
    "    - match: {}",
    "      cli:",
    `        availableModels: [${models.join(", ")}]`,
    "        enforceAvailableModels: true",
    "      desktop: {}",
    "load_test_mode:",
    `  enabled: ${process.env.OAE_CLAUDE_LOAD_TEST === "1" ? "true" : "false"}`,
    "  reply_tokens: 40",
    "  reply_seconds: 1",
    "",
  ].join("\n");
}

/** The masker's default rules (router/anthropic_masker/pii-rules.example.json). */
const DEFAULT_PII_RULES = JSON.stringify(
  {
    mode: "mask",
    rules: {
      builtin: {
        email: true,
        phone: true,
        iban: true,
        payment_card: true,
        us_ssn: true,
        uk_nino: true,
        ie_ppsn: true,
        passport: true,
        date_of_birth: true,
      },
      custom: [],
      exceptions: [],
    },
  },
  null,
  2,
);

// Downloads the pinned release, checks it against the manifest, keeps it on the volume.
const FETCH_SCRIPT = `set -eu
V=${CLAUDE_CODE_VERSION}
case "$(uname -m)" in x86_64) P=linux-x64;; aarch64|arm64) P=linux-arm64;; *) echo "unsupported CPU"; exit 1;; esac
# local-path ignores fsGroup: make our directories as this user (the volume root is world-writable).
mkdir -p /volume/postgres && chmod 700 /volume/postgres
D=/volume/claude/$V-$P
if [ -x "$D/claude" ]; then ln -sfn "$D/claude" /volume/claude/current; exit 0; fi
mkdir -p "$D" && cd "$D"
B=https://downloads.claude.ai/claude-code-releases/$V
curl -fsSL "$B/manifest.json" -o manifest.json
curl -fsSL "$B/$P/claude" -o claude.part
want=$(tr -d '\\n ' < manifest.json | sed -n "s/.*\\"$P\\":{[^}]*\\"checksum\\":\\"\\([0-9a-f]*\\)\\".*/\\1/p")
got=$(sha256sum claude.part | cut -d' ' -f1)
[ -n "$want" ] && [ "$want" = "$got" ] || { echo "checksum mismatch for claude $V $P"; rm -f claude.part; exit 1; }
chmod 755 claude.part && mv claude.part claude && ln -sfn "$D/claude" /volume/claude/current`;

// Fills the sign-in values into gateway.yaml (they come from the host's sync, not OCE).
const RENDER_SCRIPT = `set -eu
v() { cat "/oidc/$1"; }
domains=$(v EMAIL_DOMAINS | sed 's/[^a-z0-9.,-]//g; s/,/, /g')
sed -e "s|@@OIDC_ISSUER@@|$(v ISSUER)|" -e "s|@@OIDC_CLIENT_ID@@|$(v CLIENT_ID)|" \\
    -e "s|@@OIDC_EMAIL_DOMAINS@@|$domains|" /template/gateway.yaml > /rendered/gateway.yaml`;

class ClaudeGatewayWorkloads {
  private readonly driver: DriverInternals;

  constructor(driver: DriverInternals) {
    this.driver = driver;
  }

  private async target(revision: AgentRevision) {
    const namespace = (await this.driver.resolveNamespace(revision.namespaceId)).name;
    return { namespace, clients: await this.driver.clients(namespace.plane) };
  }

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

  /** The Anthropic key, copied from the source Secret the revision's binding resolved (uid-checked). */
  private async anthropicKey(revision: AgentRevision, context: ComputeRevisionContext | undefined) {
    const auth = context?.harnessAuth as
      | { method?: string; backendRef?: { name: string; key: string; uid: string } }
      | undefined;
    if (!auth || auth.method !== "api_key" || !auth.backendRef) {
      throw new ClaudeGatewayConfigurationError(
        "A Claude Gateway needs an Anthropic API key from a Secret.",
      );
    }
    const source = await this.driver.controlNamespace(revision.namespaceId);
    const control = await this.driver.clients(source.plane);
    const secret = await control.core.readNamespacedSecret({
      name: auth.backendRef.name,
      namespace: source.name,
    });
    if (secret.metadata?.deletionTimestamp || secret.metadata?.uid !== auth.backendRef.uid) {
      throw new ClaudeGatewayConfigurationError(
        "The Anthropic key Secret changed identity or is being deleted.",
      );
    }
    const value = secret.data?.[auth.backendRef.key];
    if (!value) {
      throw new ClaudeGatewayConfigurationError("The Anthropic key Secret has no value.");
    }
    return value; // base64, as Secret data
  }

  async prepare(revision: AgentRevision, context?: ComputeRevisionContext): Promise<ComputeReadiness> {
    const result = { namespaceId: revision.namespaceId, agentId: revision.agentId, revisionId: revision.id };
    const models = claudeGatewayModels(revision.configuration);
    const host = claudeGatewayHost(process.env.OAE_INSTALLATION_ID, revision);
    const { namespace, clients } = await this.target(revision);
    const n = claudeGatewayNames(revision.agentId);
    const labels = {
      "app.kubernetes.io/managed-by": MANAGER,
      "openclaw.dev/agent": revision.agentId,
      "openclaw.dev/namespace": revision.namespaceId,
      "oae.dev/runtime": "claude-gateway",
    };
    const meta = (name: string) => ({ name, namespace: namespace.name, labels });
    const b64 = (value: string) => Buffer.from(value).toString("base64");

    // Generated once per Agent and kept; the key follows the binding. Create/replace, not apply:
    // the worker may not patch Secrets (OCE's tenant Role).
    let existing: SecretObject | undefined;
    try {
      existing = await clients.core.readNamespacedSecret({ name: n.env, namespace: namespace.name });
    } catch (error) {
      if (numericErrorStatus(error) !== 404) throw error;
    }
    const keep = (name: string) => existing?.data?.[name] ?? b64(randomBytes(24).toString("hex"));
    const pg = keep("POSTGRES_PASSWORD");
    const secret = {
      apiVersion: "v1",
      kind: "Secret",
      metadata: { ...meta(n.env), resourceVersion: existing?.metadata?.resourceVersion },
      type: "Opaque",
      data: {
        ANTHROPIC_API_KEY: await this.anthropicKey(revision, context),
        MASKER_KEY: keep("MASKER_KEY"),
        MASK_SECRET: keep("MASK_SECRET"),
        GATEWAY_JWT_SECRET: keep("GATEWAY_JWT_SECRET"),
        POSTGRES_PASSWORD: pg,
        GATEWAY_POSTGRES_URL: b64(
          `postgres://gateway:${Buffer.from(pg, "base64").toString()}@127.0.0.1:5432/gateway`,
        ),
      },
    };
    await (existing
      ? clients.core.replaceNamespacedSecret({ name: n.env, namespace: namespace.name, body: secret })
      : clients.core.createNamespacedSecret({ namespace: namespace.name, body: secret }));
    await this.apply(clients, {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: meta(n.config),
      data: {
        "gateway.yaml": claudeGatewayConfigTemplate(host, models),
        "pii-rules.json": DEFAULT_PII_RULES,
      },
    });
    await this.apply(clients, {
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: meta(n.data),
      spec: { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: "5Gi" } } },
    });
    const selector = { "openclaw.dev/agent": revision.agentId, "oae.dev/runtime": "claude-gateway" };
    const fromEnv = (name: string, key = name) => ({
      name,
      valueFrom: { secretKeyRef: { name: n.env, key } },
    });
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
            // The gateway refuses a loopback upstream URL; the masker sidecar gets a name instead.
            hostAliases: [{ ip: "127.0.0.1", hostnames: ["pii-masker"] }],
            securityContext: {
              runAsNonRoot: true,
              runAsUser: UID,
              runAsGroup: UID,
              fsGroup: UID,
              seccompProfile: { type: "RuntimeDefault" },
            },
            initContainers: [
              {
                name: "fetch-claude",
                image: IMAGES.fetch,
                command: ["sh", "-c", FETCH_SCRIPT],
                securityContext: CONTAINER_SECURITY,
                volumeMounts: [{ name: "data", mountPath: "/volume" }],
              },
              {
                name: "render-config",
                image: IMAGES.fetch,
                command: ["sh", "-c", RENDER_SCRIPT],
                securityContext: CONTAINER_SECURITY,
                volumeMounts: [
                  { name: "template", mountPath: "/template" },
                  { name: "oidc", mountPath: "/oidc" },
                  { name: "rendered", mountPath: "/rendered" },
                ],
              },
            ],
            containers: [
              {
                name: "gateway",
                image: IMAGES.gateway,
                command: ["/volume/claude/current", "gateway", "--config", "/etc/claude/gateway.yaml"],
                env: [
                  { name: "CLAUDE_CONFIG_DIR", value: "/tmp/.claude" },
                  // Its SSRF guard refuses loopback upstreams; the masker sidecar is one. Only OAE
                  // writes upstreams (people cannot), so allowing loopback opens nothing else.
                  { name: "CLAUDE_GATEWAY_ALLOW_LOOPBACK", value: "1" },
                  { name: "HOME", value: "/tmp" },
                  { name: "OIDC_CLIENT_SECRET", valueFrom: { secretKeyRef: { name: n.oidc, key: "CLIENT_SECRET" } } },
                  fromEnv("GATEWAY_JWT_SECRET"),
                  fromEnv("GATEWAY_POSTGRES_URL"),
                  fromEnv("MASKER_KEY"),
                ],
                ports: [{ name: "https", containerPort: GATEWAY_PORT }],
                readinessProbe: { tcpSocket: { port: "https" }, periodSeconds: 10 },
                securityContext: CONTAINER_SECURITY,
                volumeMounts: [
                  { name: "data", mountPath: "/volume", readOnly: true },
                  { name: "rendered", mountPath: "/etc/claude", readOnly: true },
                  { name: "tls", mountPath: "/tls", readOnly: true },
                  { name: "tmp", mountPath: "/tmp" },
                ],
                resources: { requests: { cpu: "50m", memory: "256Mi" }, limits: { memory: "1Gi" } },
              },
              {
                name: "pii-masker",
                image: IMAGES.masker,
                env: [
                  fromEnv("ANTHROPIC_API_KEY"),
                  fromEnv("MASKER_KEY"),
                  fromEnv("MASK_SECRET"),
                  { name: "PII_RULES_FILE", value: "/etc/pii-masker/pii-rules.json" },
                  { name: "MASKER_DUMP_DIR", value: "" },
                ],
                command: [
                  "uvicorn", "--factory", "anthropic_masker.app:app_factory",
                  "--host", "127.0.0.1", "--port", "8080", "--no-access-log",
                ],
                securityContext: { ...CONTAINER_SECURITY, runAsUser: 10002, runAsGroup: 10002 },
                volumeMounts: [
                  { name: "template", mountPath: "/etc/pii-masker/pii-rules.json", subPath: "pii-rules.json", readOnly: true },
                ],
                resources: { requests: { cpu: "50m", memory: "128Mi" }, limits: { memory: "512Mi" } },
              },
              {
                name: "postgres",
                image: IMAGES.postgres,
                env: [
                  { name: "POSTGRES_USER", value: "gateway" },
                  { name: "POSTGRES_DB", value: "gateway" },
                  fromEnv("POSTGRES_PASSWORD"),
                  { name: "PGDATA", value: "/volume/postgres/data" },
                ],
                args: ["-c", "listen_addresses=127.0.0.1"],
                readinessProbe: { exec: { command: ["pg_isready", "-h", "127.0.0.1", "-U", "gateway"] }, periodSeconds: 10 },
                // Same user as the rest of the Pod: the official image runs as any user that owns PGDATA.
                securityContext: CONTAINER_SECURITY,
                volumeMounts: [
                  { name: "data", mountPath: "/volume" },
                  { name: "pgrun", mountPath: "/var/run/postgresql" },
                ],
                resources: { requests: { cpu: "50m", memory: "128Mi" }, limits: { memory: "512Mi" } },
              },
            ],
            volumes: [
              { name: "data", persistentVolumeClaim: { claimName: n.data } },
              { name: "template", configMap: { name: n.config } },
              { name: "oidc", secret: { secretName: n.oidc } },
              { name: "tls", secret: { secretName: n.tls } },
              { name: "rendered", emptyDir: { medium: "Memory", sizeLimit: "1Mi" } },
              { name: "tmp", emptyDir: { sizeLimit: "256Mi" } },
              { name: "pgrun", emptyDir: { medium: "Memory", sizeLimit: "1Mi" } },
            ],
          },
        },
      },
    });
    await this.apply(clients, {
      apiVersion: "v1",
      kind: "Service",
      metadata: {
        ...meta(n.base),
        // oae-claude-sync: the private name to certify, its Keycloak client and WireGuard route.
        annotations: { "oae.dev/claude-host": host },
      },
      spec: {
        type: "NodePort",
        // Keep the WireGuard container's source address, so the NetworkPolicy can admit it alone.
        externalTrafficPolicy: "Local",
        selector,
        ports: [{ name: "https", port: GATEWAY_PORT, targetPort: "https" }],
      },
    });
    await this.apply(clients, {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: meta(n.base),
      spec: {
        podSelector: { matchLabels: selector },
        policyTypes: ["Ingress", "Egress"],
        // People arrive through the gateway's WireGuard (outside the cluster); no Pod may connect.
        ingress: [
          {
            from: [{ ipBlock: { cidr: "0.0.0.0/0", except: [POD_CIDR] } }],
            ports: [{ protocol: "TCP", port: GATEWAY_PORT }],
          },
        ],
        // DNS; HTTPS to public addresses only (Anthropic, the installation's Keycloak, Anthropic's
        // release bucket). Private and link-local ranges, the cloud metadata address included, are out.
        egress: [
          {
            to: [{ namespaceSelector: {}, podSelector: { matchLabels: { "k8s-app": "kube-dns" } } }],
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
                  except: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "100.64.0.0/10"],
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

  private async serving(clients: Clients, namespace: string, name: string, revisionId: string) {
    try {
      const deployment = await clients.apps.readNamespacedDeployment({ name, namespace });
      return deployment.metadata?.annotations?.["openclaw.dev/revision"] === revisionId;
    } catch {
      return false;
    }
  }

  async stop(revision: AgentRevision) {
    const { namespace, clients } = await this.target(revision);
    const n = claudeGatewayNames(revision.agentId);
    if (!(await this.serving(clients, namespace.name, n.base, revision.id))) return;
    await this.apply(
      clients,
      { apiVersion: "apps/v1", kind: "Deployment", metadata: { name: n.base, namespace: namespace.name }, spec: { replicas: 0 } },
      `${MANAGER}-scale`,
    );
  }

  /** Agent deletion: remove the workload; oae-claude-sync then removes its client, certificate and
   *  WireGuard. The volume stays until the Namespace is deleted, as for other Agents. */
  async retire(revision: AgentRevision) {
    const { namespace, clients } = await this.target(revision);
    const n = claudeGatewayNames(revision.agentId);
    if (!(await this.serving(clients, namespace.name, n.base, revision.id))) return;
    for (const [apiVersion, kind, name] of [
      ["apps/v1", "Deployment", n.base],
      ["v1", "Service", n.base],
      ["networking.k8s.io/v1", "NetworkPolicy", n.base],
      ["v1", "ConfigMap", n.config],
      ["v1", "Secret", n.env],
    ] as const) {
      try {
        await clients.objects.delete({ apiVersion, kind, metadata: { name, namespace: namespace.name } } as never);
      } catch {
        // already gone
      }
    }
  }
}

/**
 * Wraps a Kubernetes Compute Driver so `claude-gateway` revisions are prepared here and every
 * other revision reaches the wrapped driver unchanged (composes with withHermesRuntime).
 */
export function withClaudeGatewayRuntime<T extends ComputeDriver>(driver: T): T {
  const workloads = new ClaudeGatewayWorkloads(driver as unknown as DriverInternals);
  const mine = isClaudeGatewayRevision;
  const overrides: Partial<Record<keyof ComputeDriver, unknown>> = {
    prepareRevision: (revision: AgentRevision, context?: ComputeRevisionContext) =>
      mine(revision) ? workloads.prepare(revision, context) : driver.prepareRevision(revision, context),
    activateRevision: (revision: AgentRevision, context?: ComputeRevisionContext) =>
      mine(revision) ? Promise.resolve() : driver.activateRevision?.(revision, context),
    deactivateRevision: (revision: AgentRevision) =>
      mine(revision) ? Promise.resolve() : driver.deactivateRevision?.(revision),
    stopRevision: (revision: AgentRevision) =>
      mine(revision) ? workloads.stop(revision) : driver.stopRevision(revision),
    retireRevision: (revision: AgentRevision) =>
      mine(revision) ? workloads.retire(revision) : driver.retireRevision(revision),
    admitRevision: (revision: Readonly<AgentRevision>) =>
      mine(revision) ? undefined : driver.admitRevision?.(revision),
    requiresStoppedPredecessors: (revision: AgentRevision) =>
      mine(revision) ? false : (driver.requiresStoppedPredecessors?.(revision) ?? false),
    getRuntimeImages: (revision: AgentRevision) =>
      mine(revision) ? Promise.resolve([]) : (driver.getRuntimeImages?.(revision) ?? Promise.resolve([])),
    getGatewayEndpoint: (revision: AgentRevision) =>
      mine(revision) ? undefined : driver.getGatewayEndpoint?.(revision),
    validateHarnessAuth: (harness: { id: string }, ...rest: unknown[]) =>
      harness.id === CLAUDE_GATEWAY_HARNESS_ID
        ? undefined
        : (driver.validateHarnessAuth as (...args: unknown[]) => unknown)?.call(driver, harness, ...rest),
  };
  return new Proxy(driver, {
    get(target, property, receiver) {
      if (Object.hasOwn(overrides, property) && typeof Reflect.get(target, property) === "function") {
        return overrides[property as keyof ComputeDriver];
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
