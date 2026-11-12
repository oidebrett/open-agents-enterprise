// oae-edge-authz — sign-in and per-Agent authorization for OAE's human ingress (docs/oae/edge-design.md).
//
// Traefik calls GET /check (forwardAuth) on every request to an Agent host, WebSocket upgrades
// included. A person without a session is sent to sign in through the installation's OIDC issuer;
// a signed-in person granted the Agent gets 200 with the two headers the Agent's gateway trusts
// (x-occ-identity, x-openclaw-scopes); anyone else gets 403. Traefik copies only those two headers
// to the upstream request, after stripping any client-supplied copies.
//
// Two more surfaces, each on its own host (docs/oae/edge-design.md § Access without a shell):
// - https://auth.agents.<host>/apps: a signed-in person connects the OpenClaw mobile app or Hermes
//   Desktop to an Agent they are granted (a revocable app token bound to that Agent).
// - https://<console host>/oae/api/: the console's People panel. Only for a human Installation
//   administrator, proven by OCE itself from the administrator's own console session; the panel
//   makes every OCE change (accounts, SSO identity, AccessBindings) with that session, and the edge
//   only looks people up in the directory and records which SSO subject an OCE Principal is.
import { createHash, createHmac, generateKeyPairSync, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import * as oidc from "openid-client";
import qrcode from "qrcode-generator";

const env = (name, fallback) => {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
};
const ISSUER = env("OAE_EDGE_ISSUER");
const CLIENT_ID = env("OAE_EDGE_CLIENT_ID");
const CLIENT_SECRET = env("OAE_EDGE_CLIENT_SECRET");
const AGENTS_DOMAIN = env("OAE_EDGE_AGENTS_DOMAIN").toLowerCase(); // agents.<host>
const AUTH_HOST = env("OAE_EDGE_AUTH_HOST", `auth.${AGENTS_DOMAIN}`).toLowerCase();
// The OCE console host (agents.<host> without "agents."): /oae/api/ is served there, so the
// browser sends the administrator's own console session with it.
const CONSOLE_HOST = env("OAE_EDGE_CONSOLE_HOST", AGENTS_DOMAIN.replace(/^agents\./, "")).toLowerCase();
const OCE_URL = `https://${CONSOLE_HOST}`;
const IDENTITY_PREFIX = env("OAE_EDGE_IDENTITY_PREFIX"); // issuer-qualified identities: <prefix>:<sub>
const SESSION_KEY = Buffer.from(env("OAE_EDGE_SESSION_KEY"), "hex");
// Written by oae-edge sync from OCE: { "<agent host>": { "<sub>": "user" | "operator" } } and
// { "<agent host>": { "name", "runtime": "openclaw" | "hermes" } }.
const ACL_FILE = env("OAE_EDGE_ACL_FILE", "/acl/acl.json");
const AGENTS_FILE = env("OAE_EDGE_AGENTS_FILE", "/acl/agents.json");
// Hermes agents (single-owner, no proxy identity): { "<host>": "<dashboard session token>" }. For a
// granted person the edge presents the agent's session token, as Hermes Desktop would.
const HERMES_FILE = env("OAE_EDGE_HERMES_FILE", "/hermes/hermes.json");
// Claude Gateways (docs/oae/claude-gateway.md): written by oae-claude-sync.
const CLAUDE_DIR = env("OAE_EDGE_CLAUDE_DIR", "/claude");
// The OCE installation, for /open: an Agent's host is agent-<sha256(installation\0namespace\0agent)
// [:32]>.<agents domain>, as oae-edge sync names it. Unset: /open is not offered.
const INSTALLATION_ID = process.env.OAE_EDGE_INSTALLATION_ID ?? "";
// The People panel's directory lookups (email -> SSO subject): a Keycloak client of the same realm
// that holds only realm-management view-users, never the sign-in client. Unset: no lookups.
const DIRECTORY_CLIENT_ID = process.env.OAE_EDGE_DIRECTORY_CLIENT_ID ?? "";
const DIRECTORY_CLIENT_SECRET = process.env.OAE_EDGE_DIRECTORY_CLIENT_SECRET ?? "";
const EDGE_NAMESPACE = env("OAE_EDGE_NAMESPACE", "oae-edge");
const SESSION_SECONDS = Number(env("OAE_EDGE_SESSION_SECONDS", String(8 * 3600)));
const PORT = Number(env("PORT", "8080"));
if (SESSION_KEY.length < 32) throw new Error("OAE_EDGE_SESSION_KEY must be at least 32 bytes of hex");

// Scope sets per grant level. Operators also approve the devices and nodes that ask to join the
// Agent, in the Agent's own Devices page (operator.pairing; never operator.admin).
const SCOPES = {
  user: "operator.read,operator.write",
  operator: "operator.read,operator.write,operator.approvals,operator.pairing",
};
const SESSION_COOKIE = "oae_edge";
const TX_COOKIE = "oae_edge_tx";
const REDIRECT_URI = `https://${AUTH_HOST}/callback`;
const APPS_URL = `https://${AUTH_HOST}/apps`;
const MAX_APP_TOKENS_PER_PERSON = 20;

// --- signed cookies -------------------------------------------------------------------------
const b64 = (buf) => Buffer.from(buf).toString("base64url");
const mac = (data) => createHmac("sha256", SESSION_KEY).update(data).digest();
function seal(payload) {
  const body = b64(JSON.stringify(payload));
  return `${body}.${b64(mac(body))}`;
}
function unseal(token) {
  if (typeof token !== "string") return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = mac(body);
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    return typeof payload.exp === "number" && payload.exp > Date.now() / 1000 ? payload : null;
  } catch {
    return null;
  }
}
function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
const cookie = (name, value, attrs) => `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; ${attrs}`;

// --- files written by oae-edge sync (mounted; re-read when they change) -----------------------
function watchedJson(file) {
  let value = {};
  let mtime = 0;
  return () => {
    try {
      const m = statSync(file).mtimeMs;
      if (m !== mtime) {
        value = JSON.parse(readFileSync(file, "utf8"));
        mtime = m;
      }
    } catch (error) {
      if (mtime !== 0) console.error(JSON.stringify({ event: "file.read_failed", file, message: error.message }));
      value = {}; // fail closed
      mtime = 0;
    }
    return value;
  };
}
const grants = watchedJson(ACL_FILE);
const agentsMeta = watchedJson(AGENTS_FILE);
const hermesTokens = watchedJson(HERMES_FILE);
const hermesToken = (host) => (Object.hasOwn(hermesTokens(), host) ? hermesTokens()[host] : null);
// { "<claude host>": { endpoint, serverPublicKey, subnet, tunnelIp, fingerprint, ikeServer? } }
const claudeGateways = watchedJson(`${CLAUDE_DIR}/gateways.json`);
const claudeCa = () => {
  try {
    return readFileSync(`${CLAUDE_DIR}/ca.crt`, "utf8");
  } catch {
    return "";
  }
};

// --- records the edge keeps itself: Kubernetes Secrets in its own namespace -----------------
// Its ServiceAccount may get and update exactly these two Secrets (oae-edge install).
const SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";
let k8sCa;
function k8s(method, path, body) {
  const token = readFileSync(`${SA_DIR}/token`, "utf8"); // projected; rotates
  k8sCa ??= readFileSync(`${SA_DIR}/ca.crt`);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: process.env.KUBERNETES_SERVICE_HOST ?? "kubernetes.default.svc",
        port: Number(process.env.KUBERNETES_SERVICE_PORT ?? 443),
        method,
        path,
        ca: k8sCa,
        timeout: 10_000,
        headers: {
          authorization: `Bearer ${token.trim()}`,
          accept: "application/json",
          ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {}
          resolve({ status: res.statusCode, json });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("Kubernetes API timeout")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// secretStore(NAME, KEY): one JSON object in Secret NAME, key KEY. Reads are cached for a few
// seconds (a revocation takes effect within that); when the API cannot be read, the last good
// copy serves for up to five minutes, then requests fail closed.
function secretStore(name, key) {
  const path = `/api/v1/namespaces/${EDGE_NAMESPACE}/secrets/${name}`;
  let value = {};
  let version = "";
  let loadedAt = 0;
  let inflight = null;
  async function read() {
    const { status, json } = await k8s("GET", path);
    if (status !== 200) throw new Error(`reading ${name}: HTTP ${status}`);
    const raw = json?.data?.[key];
    value = raw ? JSON.parse(Buffer.from(raw, "base64").toString("utf8")) : {};
    version = json.metadata.resourceVersion;
    loadedAt = Date.now();
    return value;
  }
  async function load({ fresh = false } = {}) {
    if (!fresh && Date.now() - loadedAt < 5_000) return value;
    try {
      inflight ??= read().finally(() => {
        inflight = null;
      });
      return await inflight;
    } catch (error) {
      log("store.read_failed", { name, message: error.message });
      if (!fresh && loadedAt && Date.now() - loadedAt < 300_000) return value;
      throw error;
    }
  }
  // update(change): change(copy) returns the new object; retried on a concurrent write.
  async function update(change) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const next = change(structuredClone(await load({ fresh: true })));
      const body = {
        apiVersion: "v1",
        kind: "Secret",
        type: "Opaque",
        metadata: { name, namespace: EDGE_NAMESPACE, resourceVersion: version },
        data: { [key]: Buffer.from(JSON.stringify(next)).toString("base64") },
      };
      const { status, json } = await k8s("PUT", path, body);
      if (status === 200) {
        value = next;
        version = json.metadata.resourceVersion;
        loadedAt = Date.now();
        return next;
      }
      if (status !== 409) throw new Error(`writing ${name}: HTTP ${status}`);
    }
    throw new Error(`writing ${name}: too many concurrent changes`);
  }
  return { load, update };
}
// App tokens: { "<sha256 hex>": { sub, email, host, id, label, created } }. A token without
// `host` (made before tokens were bound to one Agent) reaches every Agent its person is granted.
const devices = secretStore("oae-edge-devices", "devices.json");
// Who an OCE Principal is: { "<prn_ id>": { email, userId, subject } }, recorded only from OCE's
// own account record (read with an administrator's session) and the directory.
const people = secretStore("oae-edge-people", "people.json");
// One unused OpenClaw bootstrap token per Agent, minted by the sync with `openclaw qr --limited`
// (node + operator without operator.admin; minting needs operator.admin, which no person holds):
// { "<agent host>": { bootstrapToken, expiresAtMs } }. Connect takes it; the sync mints the next.
const pairing = secretStore("oae-edge-pairing", "pairing.json");
// Claude Gateway laptops: { "<WireGuard public key>": { sub, email, claudeHost, ip, id, label, created } },
// and for the built-in VPN { "ike:<id>": { kind: "ikev2", password, sub, email, claudeHost, id, label, created } }.
// The private key is made here and shown once; only the public key is kept. oae-claude-sync
// applies these peers while their person is still granted the gateway.
const claudePeers = secretStore("oae-claude-peers", "peers.json");
// A taken token must outlive the person's scan.
const PAIRING_MIN_LIFE_MS = 120_000;

// --- helpers --------------------------------------------------------------------------------
const isAgentHost = (host) =>
  typeof host === "string" && host !== AUTH_HOST && /^[a-z0-9-]+$/.test(host.slice(0, -(AGENTS_DOMAIN.length + 1))) &&
  host.endsWith(`.${AGENTS_DOMAIN}`);
function safeReturnUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    if (url.hostname === AUTH_HOST && url.pathname === "/apps" && !url.search) return url.toString();
    return isAgentHost(url.hostname) ? url.toString() : null;
  } catch {
    return null;
  }
}
function send(res, status, headers = {}, body = "") {
  res.writeHead(status, { "cache-control": "no-store", ...headers });
  res.end(body);
}
const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy":
    `default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; img-src data: https://${CONSOLE_HOST}; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
  // Not "no-referrer": under it browsers send "Origin: null" on this page's own form posts.
  // same-origin still sends nothing to other sites.
  "referrer-policy": "same-origin",
  "x-content-type-options": "nosniff",
};
// The OAE console's look (apps/controller/src/console/console.css): its colour roles, type and
// controls, its inverse top bar and mascot, and Instrument Sans (served from this image, OFL).
const DISPLAY_NAME = process.env.OAE_EDGE_DISPLAY_NAME ?? "Open Agents Enterprise";
const FONT = readFileSync(new URL("./assets/instrument-sans-latin.woff2", import.meta.url));
const STYLE = `@font-face{font-family:"Instrument Sans";font-style:normal;font-weight:400 700;font-display:swap;src:url("/assets/instrument-sans-latin.woff2") format("woff2")}
:root{--bg:#f7f5f0;--surface:#fff;--surface-2:#f1f4f6;--hover:#eaf1f6;--border:#d4d9dc;--border-strong:#7e8c99;--text:#293847;--strong:#202e40;--muted:#566573;--accent:#b53d2a;--accent-hover:#963322;--link:#245784;--danger:#b91c1c;--danger-subtle:rgba(185,28,28,.08);--info-subtle:#e8f1f9;--radius:10px;--radius-lg:14px;--shadow:0 8px 24px rgba(60,42,24,.09);
color-scheme:light;font-family:"Instrument Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:14px;line-height:1.5;color:var(--text);background:var(--bg);font-synthesis:none}
*{box-sizing:border-box}body{margin:0;min-height:100dvh}
.topbar{display:flex;align-items:center;gap:12px;padding:12px 24px;background:var(--strong);color:#fff}
.topbar img{height:36px;width:auto}.topbar .name{font-weight:600;font-size:16px;letter-spacing:-.01em}.topbar .where{margin-left:auto;font-size:12px;color:color-mix(in srgb,#fff 82%,#193e61)}
.topbar a{color:inherit}
main{max-width:960px;margin:0 auto;padding:32px 24px 48px}
h1{color:var(--strong);font-size:24px;line-height:1.2;font-weight:600;letter-spacing:-.02em;margin:0 0 4px}
h2{color:var(--strong);font-size:18px;font-weight:500;margin:32px 0 12px}
p{margin:0 0 12px}.muted{color:var(--muted)}.error{color:var(--danger);background:var(--danger-subtle);border-radius:var(--radius);padding:8px 12px}
a{color:var(--link);text-underline-offset:2px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-lg);box-shadow:var(--shadow);padding:4px 20px;margin-top:16px}
table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:12px 4px;border-bottom:1px solid var(--border);vertical-align:middle}
tr:last-child td{border-bottom:0}th{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);font-weight:600}
form{display:inline-flex;gap:8px;flex-wrap:wrap;align-items:center}
input[type=text]{height:40px;width:11rem;padding:0 12px;border:1px solid var(--border-strong);border-radius:var(--radius);font:inherit;color:var(--text);background:var(--surface)}
button{height:40px;cursor:pointer;font:inherit;font-weight:500;color:var(--strong);background:var(--surface);border:1px solid var(--border-strong);border-radius:var(--radius);padding:0 14px}
button:hover{background:var(--hover)}button.primary{background:var(--accent);border-color:var(--accent);color:#fff}button.primary:hover{background:var(--accent-hover);border-color:var(--accent-hover)}
:focus-visible{outline:2px solid var(--link);outline-offset:2px}
code,.secret{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;word-break:break-all}
.secret{display:block;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius);padding:8px 12px;margin:6px 0}
ol{padding-left:20px}ol li{margin:0 0 12px}.qr{max-width:16rem}
.tag{display:inline-block;font-size:12px;color:var(--muted)}`;
const page = (title, html) =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · ${esc(DISPLAY_NAME)}</title><style>${STYLE}</style>` +
  `<body><header class="topbar"><img src="https://${CONSOLE_HOST}/console/oce-mascot-inverse.png" alt=""><span class="name">${esc(DISPLAY_NAME)}</span><span class="where"><a href="/apps">Your Agents</a></span></header>` +
  `<main><h1>${esc(title)}</h1><div class="card">${html}</div></main></body></html>`;
const textPage = (title, text) => page(title, `<p>${esc(text)}</p>`);
const log = (event, fields = {}) => console.log(JSON.stringify({ time: new Date().toISOString(), event, ...fields }));

async function readBody(req, limit = 16_384) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("request too large"), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

let config;
async function oidcConfig() {
  config ??= await oidc.discovery(new URL(ISSUER), CLIENT_ID, CLIENT_SECRET);
  return config;
}

// --- Agent requests (forwardAuth) -------------------------------------------------------------
// An Agent on a person's Claude subscription token (the sync marks it `personal`) is for one person:
// with more than one granted, the edge refuses everyone until an administrator removes the others.
function personalShared(host) {
  return agentsMeta()[host]?.personal === true && Object.keys(grants()[host] ?? {}).length > 1;
}

function grant(res, host, sub, via) {
  const scopes = SCOPES[grants()[host]?.[sub]];
  if (!scopes) {
    log("check.denied", { host, sub, via });
    return null;
  }
  if (personalShared(host)) {
    log("check.denied", { host, sub, via, reason: "personal Agent granted to more than one person" });
    return null;
  }
  const headers = { "x-occ-identity": `${IDENTITY_PREFIX}:${sub}`, "x-openclaw-scopes": scopes };
  const token = hermesToken(host);
  if (token) headers.authorization = `Bearer ${token}`;
  send(res, 200, headers);
  return true; // callers fall back to a refusal only on null
}

const DEVICE_PATH = /^\/d\/(oaed_[A-Za-z0-9_-]{32,64})(?:[/?#]|$)/;
const tokenHash = (token) => createHash("sha256").update(token).digest("hex");

async function check(req, res) {
  const host = String(req.headers["x-forwarded-host"] ?? "").toLowerCase().split(":")[0];
  if (!isAgentHost(host)) return send(res, 403, {}, "unknown host");
  // An app's token in the path: never a redirect, only allowed or refused.
  const device = DEVICE_PATH.exec(String(req.headers["x-forwarded-uri"] ?? ""));
  if (device) {
    let record;
    try {
      const all = await devices.load();
      const hash = tokenHash(device[1]);
      record = Object.hasOwn(all, hash) ? all[hash] : null;
    } catch {
      return send(res, 503, {}, "try again");
    }
    if (!record?.sub) return send(res, 401, {}, "unknown app token");
    if (record.host && record.host !== host) return send(res, 403, {}, "this app token is for another Agent");
    return grant(res, host, record.sub, "app") ?? send(res, 403, {}, "no access to this Agent");
  }
  const session = unseal(cookies(req)[SESSION_COOKIE]);
  if (!session) {
    const uri = String(req.headers["x-forwarded-uri"] ?? "/");
    const method = String(req.headers["x-forwarded-method"] ?? "GET");
    const wantsPage = method === "GET" && /text\/html/.test(String(req.headers.accept ?? ""));
    if (!wantsPage) return send(res, 401, {}, "sign in required");
    const rd = encodeURIComponent(`https://${host}${uri.startsWith("/") ? uri : "/"}`);
    return send(res, 302, { location: `https://${AUTH_HOST}/login?rd=${rd}` });
  }
  return (
    grant(res, host, session.sub, "session") ??
    send(res, 403, PAGE_HEADERS, textPage("No access", `You are signed in as ${session.email ?? session.sub}, but you have not been given access to this Agent. Ask an administrator.`))
  );
}

// --- sign-in --------------------------------------------------------------------------------
async function login(req, res, url) {
  const rd = safeReturnUrl(url.searchParams.get("rd") ?? "");
  if (!rd) return send(res, 400, {}, "invalid return address");
  const verifier = oidc.randomPKCECodeVerifier();
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const authUrl = oidc.buildAuthorizationUrl(await oidcConfig(), {
    redirect_uri: REDIRECT_URI,
    scope: "openid email",
    code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
    code_challenge_method: "S256",
    state,
    nonce,
  });
  const tx = seal({ verifier, state, nonce, rd, exp: Math.floor(Date.now() / 1000) + 600 });
  return send(res, 302, { location: authUrl.href, "set-cookie": cookie(TX_COOKIE, tx, "Max-Age=600") });
}

async function callback(req, res, url) {
  const tx = unseal(cookies(req)[TX_COOKIE]);
  if (!tx) return send(res, 400, {}, "sign-in expired; start again");
  try {
    const tokens = await oidc.authorizationCodeGrant(await oidcConfig(), new URL(`https://${AUTH_HOST}${url.pathname}${url.search}`), {
      pkceCodeVerifier: tx.verifier,
      expectedState: tx.state,
      expectedNonce: tx.nonce,
      idTokenExpected: true,
    });
    const claims = tokens.claims();
    if (!claims?.sub) throw new Error("ID token has no subject");
    const session = seal({ sub: claims.sub, email: claims.email, exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS });
    log("login.ok", { sub: claims.sub });
    res.writeHead(302, {
      location: tx.rd,
      "cache-control": "no-store",
      "set-cookie": [
        cookie(SESSION_COOKIE, session, `Domain=.${AGENTS_DOMAIN}; Max-Age=${SESSION_SECONDS}`),
        cookie(TX_COOKIE, "", "Max-Age=0"),
      ],
    });
    return res.end();
  } catch (error) {
    log("login.failed", { message: error.message });
    return send(res, 400, PAGE_HEADERS, textPage("Sign-in failed", "Please try again."));
  }
}

// GET /open/<namespace>/<agent>: the console's "Open Agent" link. Redirects to that Agent's host,
// which signs the person in and checks their grant as any visit does. Only ever redirects to a host
// it computes under the agents domain; IDs are OCE's own formats.
// An Agent's host, as the sync computes it: agent-<sha256(installation\0namespace\0agent)[:32]>.
function agentHost(namespaceId, agentId) {
  const hash = createHash("sha256").update(`${INSTALLATION_ID}\0${namespaceId}\0${agentId}`).digest("hex").slice(0, 32);
  return `agent-${hash}.${AGENTS_DOMAIN}`;
}

function open(res, url) {
  const match = /^\/open\/(ns_[0-9a-f-]{36})\/(agt_[0-9a-f-]{36})$/.exec(url.pathname);
  if (!INSTALLATION_ID || !match) return send(res, 404, {}, "not found");
  return send(res, 302, { location: `https://${agentHost(match[1], match[2])}/`, "cache-control": "no-store" });
}

function logout(req, res) {
  return send(
    res,
    200,
    { ...PAGE_HEADERS, "set-cookie": cookie(SESSION_COOKIE, "", `Domain=.${AGENTS_DOMAIN}; Max-Age=0`) },
    textPage("Signed out", "You are signed out of your Agents."),
  );
}

// --- /apps: a person connects their own apps ----------------------------------------------------
// Each app token is bound to the person and to one Agent, works only while that person is
// granted the Agent (checked on every request), and is shown once; only its SHA-256 is kept.
function myAgents(sub) {
  const meta = agentsMeta();
  return Object.entries(grants())
    .filter(([, levels]) => levels && Object.hasOwn(levels, sub))
    .map(([host, levels]) => ({
      host,
      level: levels[sub],
      name: meta[host]?.name ?? host.split(".")[0],
      runtime: ["hermes", "claude-gateway"].includes(meta[host]?.runtime) ? meta[host].runtime : "openclaw",
      claudeHost: meta[host]?.claudeHost ?? "",
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function signInFirst(res) {
  return send(res, 302, { location: `https://${AUTH_HOST}/login?rd=${encodeURIComponent(APPS_URL)}` });
}

async function appsPage(req, res, notice = "") {
  const session = unseal(cookies(req)[SESSION_COOKIE]);
  if (!session) return signInFirst(res);
  const agents = myAgents(session.sub);
  const names = Object.fromEntries(agents.map((a) => [a.host, a.name]));
  const claudeNames = Object.fromEntries(agents.filter((a) => a.claudeHost).map((a) => [a.claudeHost, a.host]));
  const tokens = [
    ...Object.values(await devices.load()),
    // Claude Gateway laptops, listed with the app tokens; their ids start with "cgw-".
    ...Object.values(await claudePeers.load()).map((p) => ({ ...p, host: claudeNames[p.claudeHost] ?? "gone" })),
  ]
    .filter((d) => d.sub === session.sub)
    .sort((a, b) => String(b.created).localeCompare(String(a.created)));
  const agentRows = agents.length
    ? agents
        .map(
          (a) => `<tr><td>${a.runtime === "claude-gateway" ? esc(a.name) : `<a href="https://${esc(a.host)}/" target="_blank" rel="noopener">${esc(a.name)}</a>`}<div class="muted">${{ hermes: "Hermes", "claude-gateway": "Claude Gateway" }[a.runtime] ?? "OpenClaw"} · ${esc(a.level)}</div></td>
<td><form method="post" action="/apps/connect"><input type="hidden" name="host" value="${esc(a.host)}">
<input type="text" name="label" maxlength="40" placeholder="${a.runtime === "openclaw" ? "e.g. my phone" : "e.g. laptop"}" required pattern="[A-Za-z0-9 ._-]{1,40}" aria-label="Name for this app">
${a.runtime === "claude-gateway" && claudeGateways()[a.claudeHost]?.ikeServer ? `<select name="vpn" aria-label="How this computer connects"><option value="ikev2">Built-in VPN (nothing to install)</option><option value="wireguard">WireGuard app</option></select>` : ""}
<button type="submit" class="primary">${{ hermes: "Connect Hermes Desktop", "claude-gateway": "Connect Claude Code / Desktop" }[a.runtime] ?? "Connect the mobile app"}</button></form></td></tr>`,
        )
        .join("")
    : `<tr><td colspan="2" class="muted">You have not been given access to any Agent yet. Ask an administrator.</td></tr>`;
  const tokenRows = tokens.length
    ? tokens
        .map(
          (t) => `<tr><td>${esc(t.label)}<div class="muted">${esc(t.host ? (names[t.host] ?? "an Agent you no longer have") : "all your Agents")} · created ${esc(String(t.created).slice(0, 10))}</div></td>
<td><form method="post" action="/apps/revoke"><input type="hidden" name="id" value="${esc(t.id)}"><button type="submit">Disconnect</button></form></td></tr>`,
        )
        .join("")
    : `<tr><td colspan="2" class="muted">No apps connected.</td></tr>`;
  return send(
    res,
    200,
    PAGE_HEADERS,
    page(
      "Your Agents",
      `${notice}<p class="muted">Signed in as ${esc(session.email ?? session.sub)} · <a href="/logout">Sign out</a></p>
<table><tr><th>Agent</th><th>Connect an app</th></tr>${agentRows}</table>
<h2>Connected apps</h2><table>${tokenRows}</table>
<p class="muted">An app keeps working only while you have access to its Agent. Disconnect any app you no longer use.</p>`,
    ),
  );
}

// A form post from this host's own pages: the browser's Origin, or, where a browser sends
// "Origin: null", its Sec-Fetch-Site (set by the browser; a page cannot forge it).
function sameOriginPost(req, origin) {
  if (req.method !== "POST") return false;
  const sent = req.headers.origin;
  if (sent === origin) return true;
  return (sent === undefined || sent === "null") && req.headers["sec-fetch-site"] === "same-origin";
}

async function appsConnect(req, res) {
  const session = unseal(cookies(req)[SESSION_COOKIE]);
  if (!session) return signInFirst(res);
  if (!sameOriginPost(req, `https://${AUTH_HOST}`)) return send(res, 403, {}, "cross-origin request refused");
  const form = new URLSearchParams(await readBody(req));
  const host = String(form.get("host") ?? "").toLowerCase();
  const label = String(form.get("label") ?? "").trim();
  const agent = myAgents(session.sub).find((a) => a.host === host);
  if (!agent) return send(res, 403, PAGE_HEADERS, textPage("No access", "You do not have access to that Agent."));
  if (!/^[A-Za-z0-9 ._-]{1,40}$/.test(label)) return appsPage(req, res, `<p class="error">Name the app with up to 40 letters, digits, spaces or . _ -</p>`);
  if (agent.runtime === "claude-gateway") return claudeConnect(req, res, session, agent, label, String(form.get("vpn") ?? "wireguard"));
  // OpenClaw: take this Agent's bootstrap token first, so the phone pairs on its own.
  let bootstrap = null;
  if (agent.runtime !== "hermes") {
    try {
      await pairing.update((all) => {
        const entry = Object.hasOwn(all, host) ? all[host] : null;
        if (!entry?.bootstrapToken || !(entry.expiresAtMs > Date.now() + PAIRING_MIN_LIFE_MS)) {
          throw Object.assign(new Error("no pairing token"), { code: "NO_PAIRING" });
        }
        bootstrap = entry;
        delete all[host];
        return all;
      });
    } catch (error) {
      if (error.code !== "NO_PAIRING") throw error;
      return appsPage(req, res, `<p class="error">The phone setup for ${esc(agent.name)} is being prepared. Try again in a minute.</p>`);
    }
  }
  const token = `oaed_${randomBytes(32).toString("base64url")}`;
  const hash = tokenHash(token);
  const id = hash.slice(0, 12);
  await devices.update((all) => {
    if (Object.values(all).filter((d) => d.sub === session.sub).length >= MAX_APP_TOKENS_PER_PERSON) {
      throw Object.assign(new Error("too many apps"), { status: 409 });
    }
    all[hash] = { sub: session.sub, email: session.email ?? "", host, id, label, created: new Date().toISOString() };
    return all;
  });
  log("app.connected", { sub: session.sub, host, id, label });
  let body;
  if (agent.runtime === "hermes") {
    const url = `https://${host}/d/${token}`;
    // Hermes Desktop puts its session token in the chat WebSocket's ?token=, which the edge cannot
    // set, so the person enters the Agent's own one. It opens nothing alone: every request still
    // needs this app token (or a signed-in session) at the edge.
    const sessionToken = hermesToken(host);
    body = sessionToken
      ? `<p>In Hermes Desktop open <b>Settings → Gateways → Saved connections</b>, add a connection, choose <b>Session token</b> (not Sign in), and enter:</p>
<p>Gateway URL:</p><code class="secret">${esc(url)}</code>
<p>Session token:</p><code class="secret">${esc(sessionToken)}</code>
<p class="muted">Then switch Desktop to that connection. Use Saved connections, not Primary gateway: the Primary gateway form sees that this Agent requires sign-in and offers only "Sign in with your identity provider". The session token belongs to the Agent and works only together with the URL above, which is yours alone.</p>`
      : `<p>This Agent is still starting, so Hermes Desktop cannot connect yet. Disconnect this app below and connect again in a few minutes.</p>`;
  } else {
    const url = `wss://${host}/d/${token}`;
    // OpenClaw's setup code: base64url JSON. The bootstrap token pairs the phone at once, with
    // limited access (no operator.admin); the edge authenticates every request as you.
    const setupCode = Buffer.from(
      JSON.stringify({ url, bootstrapToken: bootstrap.bootstrapToken, expiresAtMs: bootstrap.expiresAtMs }),
    ).toString("base64url");
    const minutes = Math.max(1, Math.floor((bootstrap.expiresAtMs - Date.now()) / 60_000));
    const qr = qrcode(0, "M");
    qr.addData(setupCode);
    qr.make();
    const svg = Buffer.from(qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true })).toString("base64");
    body = `<p>In the OpenClaw app open <b>Settings → Gateway</b> and scan this code, or paste the setup code.</p>
<img class="qr" alt="Setup code QR" src="data:image/svg+xml;base64,${svg}">
<p>Setup code:</p><code class="secret">${esc(setupCode)}</code>
<p>Gateway URL (for manual setup):</p><code class="secret">${esc(url)}</code>
<p><b>Scan within ${minutes} minutes.</b> After that, disconnect this app below and connect again.</p>
<p class="muted">The app chats as you and pairs on its own, with limited access (it cannot change the Agent's settings).</p>`;
  }
  return send(
    res,
    200,
    PAGE_HEADERS,
    page(
      `Connect ${agent.name}`,
      `<p><b>Shown once.</b> Anyone with this can use ${esc(agent.name)} as you, so treat it like a password. It stops working when you disconnect it or lose access to the Agent.</p>
${body}<p><a href="/apps">Done</a></p>`,
    ),
  );
}

// --- Claude Gateway: a laptop gets its own WireGuard peer to the gateway -----------------------
const wgKey = (jwkValue) => Buffer.from(jwkValue, "base64url").toString("base64");
const download = (name, text, label) =>
  `<a download="${esc(name)}" href="data:application/octet-stream;base64,${Buffer.from(text).toString("base64")}">${esc(label)}</a>`;

// The laptop setup per OS: hosts entry, CA trust, Claude Code's gateway sign-in, and the CA for
// Claude Code started outside a shell (Desktop's Code tab). macOS is tested; Linux and Windows
// follow each OS's standard tools (docs/oae/claude-gateway.md).
const settingsPython = (gw) => `CFG=\${CLAUDE_CONFIG_DIR:-$HOME/.claude}
mkdir -p "$CFG"
CFG="$CFG" GW_URL="https://${gw}:8443" python3 - <<'PY'
import json, os
p = os.path.join(os.environ["CFG"], "settings.json")
s = json.load(open(p)) if os.path.exists(p) else {}
s.update({"forceLoginMethod": "gateway", "forceLoginGatewayUrl": os.environ["GW_URL"]})
json.dump(s, open(p, "w"), indent=2)
PY
echo "Claude Code settings written to $CFG/settings.json (set CLAUDE_CONFIG_DIR to keep them elsewhere)."`;

// How to bring the connection up, as the setup scripts' last words.
const VPN_HINT = {
  wireguard: {
    mac: "Import the tunnel file in WireGuard and activate it",
    linux: "Start the tunnel: sudo install -m 600 <your tunnel file>.conf /etc/wireguard/cgw.conf && sudo wg-quick up cgw (or: nmcli connection import type wireguard file <your tunnel file>.conf)",
    windows: "Import the tunnel file in WireGuard for Windows and activate it",
  },
  ikev2: {
    mac: "Install the VPN profile (double-click it, then System Settings, Profiles) and switch the VPN on in System Settings, VPN",
    linux: "Add the built-in VPN in NetworkManager (IPsec/IKEv2, EAP) with the details shown on the page",
    windows: "Connect the VPN from Settings, Network and internet, VPN, with the username and password shown on the page",
  },
};

function claudeScriptMac(gw, ip, fingerprint, ca, vpn = "wireguard") {
  return `#!/bin/bash
# Claude Gateway: one-time setup for this Mac. Run: bash setup-claude-gateway-mac.sh
set -e
cd "$(dirname "$0")"
grep -q " ${gw}" /etc/hosts || echo "${ip} ${gw}" | sudo tee -a /etc/hosts >/dev/null
mkdir -p ~/.claude-gateway
cat > ~/.claude-gateway/ca.crt <<'CA'
${ca.trim()}
CA
# Name-constrained to the gateway's private domain: it cannot vouch for any other site.
sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ~/.claude-gateway/ca.crt
${settingsPython(gw)}
grep -q NODE_EXTRA_CA_CERTS ~/.zshrc 2>/dev/null || echo 'export NODE_EXTRA_CA_CERTS=$HOME/.claude-gateway/ca.crt' >> ~/.zshrc
# Claude Desktop's Code tab runs Claude Code without your shell's settings: give apps the CA too,
# now and at every login (remove: launchctl unsetenv NODE_EXTRA_CA_CERTS; delete the plist).
mkdir -p ~/Library/LaunchAgents
cat > ~/Library/LaunchAgents/dev.oae.claude-gateway-ca.plist <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>dev.oae.claude-gateway-ca</string>
<key>ProgramArguments</key><array><string>/bin/launchctl</string><string>setenv</string><string>NODE_EXTRA_CA_CERTS</string><string>$HOME/.claude-gateway/ca.crt</string></array>
<key>RunAtLoad</key><true/>
</dict></plist>
PLIST
launchctl setenv NODE_EXTRA_CA_CERTS "$HOME/.claude-gateway/ca.crt"
echo "Done. ${VPN_HINT[vpn].mac}, then open Claude Code, or quit and reopen Claude Desktop."
echo "Certificate fingerprint to confirm: ${fingerprint}"
`;
}

function claudeScriptLinux(gw, ip, fingerprint, ca, vpn = "wireguard") {
  return `#!/bin/bash
# Claude Gateway: one-time setup for this Linux machine. Run: bash setup-claude-gateway-linux.sh
set -e
cd "$(dirname "$0")"
grep -q " ${gw}" /etc/hosts || echo "${ip} ${gw}" | sudo tee -a /etc/hosts >/dev/null
mkdir -p ~/.claude-gateway
cat > ~/.claude-gateway/ca.crt <<'CA'
${ca.trim()}
CA
# System trust (name-constrained to the gateway's private domain).
if [ -d /usr/local/share/ca-certificates ] && command -v update-ca-certificates >/dev/null; then
  sudo cp ~/.claude-gateway/ca.crt /usr/local/share/ca-certificates/claude-gateway-ca.crt && sudo update-ca-certificates >/dev/null
elif command -v trust >/dev/null; then
  sudo trust anchor --store ~/.claude-gateway/ca.crt
else
  echo "Add ~/.claude-gateway/ca.crt to your system's trusted certificates by hand."
fi
${settingsPython(gw)}
for f in ~/.profile ~/.bashrc; do
  grep -q NODE_EXTRA_CA_CERTS "$f" 2>/dev/null || echo 'export NODE_EXTRA_CA_CERTS=$HOME/.claude-gateway/ca.crt' >> "$f"
done
echo "Done. ${VPN_HINT[vpn].linux}. Then open a new terminal and run claude."
echo "Certificate fingerprint to confirm: ${fingerprint}"
`;
}

// PowerShell (Windows): no backticks or "\${" here, both of which this template literal would take.
function claudeScriptWindows(gw, ip, fingerprint, ca, vpn = "wireguard", ike = null) {
  return `#Requires -RunAsAdministrator
# Claude Gateway: one-time setup for this Windows PC. In PowerShell as Administrator, run:
#   powershell -ExecutionPolicy Bypass -File setup-claude-gateway-windows.ps1
$ErrorActionPreference = 'Stop'
$GW = '${gw}'
$hosts = Join-Path $env:WINDIR 'System32\\drivers\\etc\\hosts'
if (-not (Select-String -Path $hosts -Pattern (' ' + $GW) -SimpleMatch -Quiet)) { Add-Content -Path $hosts -Value ('${ip} ' + $GW) }
$dir = Join-Path $env:USERPROFILE '.claude-gateway'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$caPath = Join-Path $dir 'ca.crt'
$ca = @'
${ca.trim()}
'@
[IO.File]::WriteAllText($caPath, $ca + [Environment]::NewLine)
# Name-constrained to the gateway's private domain: it cannot vouch for any other site.
Import-Certificate -FilePath $caPath -CertStoreLocation Cert:\\LocalMachine\\Root | Out-Null
$cfg = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $env:USERPROFILE '.claude' }
New-Item -ItemType Directory -Force -Path $cfg | Out-Null
$sp = Join-Path $cfg 'settings.json'
$s = if (Test-Path $sp) { Get-Content $sp -Raw | ConvertFrom-Json } else { [pscustomobject]@{} }
$s | Add-Member -Force -NotePropertyName forceLoginMethod -NotePropertyValue 'gateway'
$s | Add-Member -Force -NotePropertyName forceLoginGatewayUrl -NotePropertyValue ('https://' + $GW + ':8443')
# UTF-8 without a byte-order mark: Claude Code reads plain JSON.
[IO.File]::WriteAllText($sp, ($s | ConvertTo-Json -Depth 20), (New-Object Text.UTF8Encoding $false))
[Environment]::SetEnvironmentVariable('NODE_EXTRA_CA_CERTS', $caPath, 'User')
Write-Host ('Claude Code settings written to ' + $sp)
${ike ? windowsIkev2(ike) : ""}Write-Host 'Done. ${VPN_HINT[vpn].windows}, then open a new terminal (or restart Claude Desktop).'
Write-Host 'Certificate fingerprint to confirm: ${fingerprint}'
`;
}

// The built-in VPN on Windows: a per-user IKEv2 connection with EAP-MSCHAPv2 that carries only the
// gateway's address (split tunnel), with the IKE algorithms the server offers instead of Windows'
// older defaults. Windows asks for the username and password on the first connect.
function windowsIkev2({ name, server, tunnelIp }) {
  return `$vpn = '${name}'
Get-VpnConnection -Name $vpn -ErrorAction SilentlyContinue | Remove-VpnConnection -Force
Add-VpnConnection -Name $vpn -ServerAddress '${server}' -TunnelType Ikev2 -EncryptionLevel Required -AuthenticationMethod Eap -SplitTunneling -RememberCredential -Force
Set-VpnConnectionIPsecConfiguration -ConnectionName $vpn -AuthenticationTransformConstants GCMAES256 -CipherTransformConstants GCMAES256 -EncryptionMethod AES256 -IntegrityCheckMethod SHA256 -DHGroup Group14 -PfsGroup None -Force
Add-VpnConnectionRoute -ConnectionName $vpn -DestinationPrefix '${tunnelIp}/32'
Write-Host ('Built-in VPN added: ' + $vpn)
`;
}

// The built-in VPN on a Mac: a configuration profile with one IKEv2 VPN (EAP-MSCHAPv2, the server
// checked by its public certificate and name). The server narrows the traffic to the gateway.
function macIkev2Profile({ name, server, user, password }) {
  const x = (v) => esc(String(v));
  const vpnId = randomUUID().toUpperCase();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>PayloadContent</key><array><dict>
<key>PayloadType</key><string>com.apple.vpn.managed</string>
<key>PayloadIdentifier</key><string>dev.oae.claude-gateway.vpn.${vpnId}</string>
<key>PayloadUUID</key><string>${vpnId}</string>
<key>PayloadVersion</key><integer>1</integer>
<key>PayloadDisplayName</key><string>${x(name)}</string>
<key>UserDefinedName</key><string>${x(name)}</string>
<key>VPNType</key><string>IKEv2</string>
<key>IKEv2</key><dict>
<key>RemoteAddress</key><string>${x(server)}</string>
<key>RemoteIdentifier</key><string>${x(server)}</string>
<key>LocalIdentifier</key><string>${x(user)}</string>
<key>AuthenticationMethod</key><string>None</string>
<key>ExtendedAuthEnabled</key><integer>1</integer>
<key>AuthName</key><string>${x(user)}</string>
<key>AuthPassword</key><string>${x(password)}</string>
</dict>
</dict></array>
<key>PayloadDisplayName</key><string>${x(name)}</string>
<key>PayloadIdentifier</key><string>dev.oae.claude-gateway.${vpnId}</string>
<key>PayloadUUID</key><string>${randomUUID().toUpperCase()}</string>
<key>PayloadType</key><string>Configuration</string>
<key>PayloadVersion</key><integer>1</integer>
</dict></plist>
`;
}

const CLAUDE_OS = {
  mac: { label: "macOS", file: "setup-claude-gateway-mac.sh", script: claudeScriptMac,
    run: "bash ~/Downloads/setup-claude-gateway-mac.sh", tunnel: "WireGuard (Mac App Store): <b>Import tunnel(s) from file</b>, pick the tunnel file, <b>Activate</b>." },
  windows: { label: "Windows", file: "setup-claude-gateway-windows.ps1", script: claudeScriptWindows,
    run: "powershell -ExecutionPolicy Bypass -File $HOME\\Downloads\\setup-claude-gateway-windows.ps1 (in PowerShell as Administrator)",
    tunnel: "WireGuard for Windows (wireguard.com/install): <b>Import tunnel(s) from file</b>, pick the tunnel file, <b>Activate</b>." },
  linux: { label: "Linux", file: "setup-claude-gateway-linux.sh", script: claudeScriptLinux,
    run: "bash ~/Downloads/setup-claude-gateway-linux.sh",
    tunnel: "<code>sudo install -m 600 TUNNEL.conf /etc/wireguard/cgw.conf && sudo wg-quick up cgw</code> (wireguard-tools), or import it in NetworkManager." },
};
function clientOs(req) {
  const ua = String(req.headers["user-agent"] ?? "");
  if (/Windows/i.test(ua)) return "windows";
  if (/Mac OS X|Macintosh/i.test(ua)) return "mac";
  if (/Linux|X11/i.test(ua) && !/Android/i.test(ua)) return "linux";
  return "mac";
}

async function claudeConnect(req, res, session, agent, label, choice) {
  const gw = claudeGateways()[agent.claudeHost];
  const ca = claudeCa();
  if (!agent.claudeHost || !gw?.serverPublicKey || !ca) {
    return appsPage(req, res, `<p class="error">${esc(agent.name)} is still being set up. Try again in a minute.</p>`);
  }
  const vpn = choice === "ikev2" && gw.ikeServer ? "ikev2" : "wireguard";
  const id = `cgw-${randomBytes(6).toString("hex")}`;
  const record = { sub: session.sub, email: session.email ?? "", claudeHost: agent.claudeHost, id, label, created: new Date().toISOString() };
  const tooMany = (all) => Object.values(all).filter((p) => p.sub === session.sub).length >= MAX_APP_TOKENS_PER_PERSON;
  let tunnel = "";
  let password = "";
  if (vpn === "wireguard") {
    const { publicKey, privateKey } = generateKeyPairSync("x25519");
    const pub = wgKey(publicKey.export({ format: "jwk" }).x);
    const priv = wgKey(privateKey.export({ format: "jwk" }).d);
    let ip = "";
    await claudePeers.update((all) => {
      if (tooMany(all)) throw Object.assign(new Error("too many apps"), { status: 409 });
      const used = new Set(Object.values(all).filter((p) => p.claudeHost === agent.claudeHost).map((p) => p.ip));
      for (let i = 2; i < 255 && !ip; i += 1) if (!used.has(`${gw.subnet}.${i}`)) ip = `${gw.subnet}.${i}`;
      if (!ip) throw Object.assign(new Error("gateway full"), { status: 409 });
      all[pub] = { ...record, ip };
      return all;
    });
    tunnel = `[Interface]\nPrivateKey = ${priv}\nAddress = ${ip}/32\n\n[Peer]\nPublicKey = ${gw.serverPublicKey}\nEndpoint = ${gw.endpoint}\nAllowedIPs = ${gw.tunnelIp}/32\nPersistentKeepalive = 25\n`;
  } else {
    // The username is the device's id; the password is made here, shown once and kept for the
    // VPN server (it needs the password itself for EAP-MSCHAPv2).
    password = randomBytes(18).toString("base64url");
    await claudePeers.update((all) => {
      if (tooMany(all)) throw Object.assign(new Error("too many apps"), { status: 409 });
      all[`ike:${id}`] = { ...record, kind: "ikev2", password };
      return all;
    });
  }
  log("app.connected", { sub: session.sub, host: agent.host, id, label, runtime: "claude-gateway", vpn });
  const fileBase = `${agent.name}-${label}`.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 60);
  const vpnName = `${agent.name} (${label})`.replace(/[^A-Za-z0-9 ._()-]+/g, "-").slice(0, 60);
  const ike = vpn === "ikev2" ? { name: vpnName, server: gw.ikeServer, tunnelIp: gw.tunnelIp, user: id, password } : null;
  const bootstrap = `https://${agent.claudeHost}:8443/user/bootstrap`;
  const os = clientOs(req);
  const mine = CLAUDE_OS[os];
  const script = (o) => CLAUDE_OS[o].script(agent.claudeHost, gw.tunnelIp, gw.fingerprint, ca, vpn, o === "windows" ? ike : null);
  const others = Object.keys(CLAUDE_OS)
    .filter((o) => o !== os)
    .map((o) => download(CLAUDE_OS[o].file, script(o), `${CLAUDE_OS[o].label} setup script`))
    .join(" · ");
  let connectStep;
  let downloads;
  if (vpn === "wireguard") {
    downloads = `${download(`${fileBase}.conf`, tunnel, "your tunnel file")} and ${download(mine.file, script(os), "the setup script")}`;
    connectStep = `<li>Tunnel: ${mine.tunnel} Run one WireGuard tunnel at a time. It works within a minute.</li>`;
  } else {
    const details = `<table><tr><td>Server and remote ID</td><td><code>${esc(ike.server)}</code></td></tr>
<tr><td>Username</td><td><code>${esc(id)}</code></td></tr><tr><td>Password</td><td><code class="secret">${esc(password)}</code></td></tr></table>`;
    if (os === "mac") {
      downloads = `${download(`${fileBase}.mobileconfig`, macIkev2Profile(ike), "the VPN profile")} and ${download(mine.file, script(os), "the setup script")}`;
      connectStep = `<li>VPN: double-click the profile, then open <b>System Settings → General → Device Management</b> (or Profiles), install it and confirm with your password. Switch it on in <b>System Settings → VPN</b>. It carries only this gateway's traffic and works within a minute. To set it up by hand instead: <b>Add VPN Configuration → IKEv2</b>, authentication <b>Username</b>: ${details}</li>`;
    } else if (os === "windows") {
      downloads = download(mine.file, script(os), "the setup script");
      connectStep = `<li>VPN: the setup script added <b>${esc(vpnName)}</b>. Connect it in <b>Settings → Network &amp; internet → VPN</b> and sign in with: ${details}</li>`;
    } else {
      downloads = download(mine.file, script(os), "the setup script");
      connectStep = `<li>VPN: in NetworkManager add an <b>IPsec/IKEv2 (strongswan)</b> VPN (package network-manager-strongswan), authentication <b>EAP</b>, route only <code>${esc(gw.tunnelIp)}/32</code>: ${details}</li>`;
    }
  }
  const body = `<p class="muted">Set up for ${esc(mine.label)}. Another computer: ${others}.</p>
<ol>
<li>Download ${downloads}.</li>
<li>Run the setup script once: <code>${esc(mine.run)}</code>. It makes this gateway your Claude Code sign-in; to keep it apart from another setup, set <code>CLAUDE_CONFIG_DIR</code> when you run it and when you start Claude Code.</li>
${connectStep}
<li><b>Claude Code</b> (2.1.295 or later): open a new terminal and run <code>claude</code>. Trust the gateway only if its fingerprint is <code>${esc(gw.fingerprint)}</code>, then sign in.</li>
${os === "linux" ? "" : `<li><b>Claude Desktop</b>: Help → Troubleshooting → Enable Developer Mode; Developer → Configure Third-Party Inference… → Source. Bootstrap config URL:<code class="secret">${esc(bootstrap)}</code>Leave the OIDC fields empty, save, then <b>Sign in with your organization</b>.</li>`}
</ol>
<p class="muted">${vpn === "wireguard" ? "The tunnel file holds a private key" : "The password (also inside the VPN profile)"} is shown only now: keep it to yourself. Disconnecting below, or losing access to ${esc(agent.name)}, closes the connection.${os === "mac" ? "" : " Tested on macOS; " + esc(mine.label) + " follows the same steps with that system's tools."}</p>`;
  return send(res, 200, PAGE_HEADERS, page(`Connect ${agent.name}`, `${body}<p><a href="/apps">Done</a></p>`));
}

async function appsRevoke(req, res) {
  const session = unseal(cookies(req)[SESSION_COOKIE]);
  if (!session) return signInFirst(res);
  if (!sameOriginPost(req, `https://${AUTH_HOST}`)) return send(res, 403, {}, "cross-origin request refused");
  const id = String(new URLSearchParams(await readBody(req)).get("id") ?? "");
  let removed = 0;
  await devices.update((all) => {
    for (const [hash, d] of Object.entries(all)) {
      if (d.sub === session.sub && d.id === id) {
        delete all[hash];
        removed += 1;
      }
    }
    return all;
  });
  if (id.startsWith("cgw-")) {
    await claudePeers.update((all) => {
      for (const [key, p] of Object.entries(all)) {
        if (p.sub === session.sub && p.id === id) {
          delete all[key];
          removed += 1;
        }
      }
      return all;
    });
  }
  log("app.disconnected", { sub: session.sub, id, removed });
  return send(res, 303, { location: "/apps" });
}

// --- /oae/api/: the console's People panel (console host only) ---------------------------------
// Calls OCE with the administrator's own console session, exactly as the console itself would.
async function oce(req, method, path) {
  const headers = { cookie: String(req.headers.cookie ?? ""), accept: "application/json", origin: OCE_URL };
  const key = req.headers["x-occ-session-key"];
  if (typeof key === "string") headers["x-occ-session-key"] = key;
  const res = await fetch(`${OCE_URL}${path}`, { method, headers, redirect: "manual", signal: AbortSignal.timeout(10_000) });
  let json = null;
  try {
    json = await res.json();
  } catch {}
  return { status: res.status, data: json?.data };
}

// A human Installation administrator: OCE answers the account read only for one.
async function consoleAdministrator(req) {
  if (!req.headers.cookie) return null;
  const session = await oce(req, "GET", "/api/auth/session");
  const user = session.status === 200 ? session.data?.user : null;
  if (typeof user?.id !== "string") return null;
  const account = await oce(req, "GET", `/api/auth/accounts/${encodeURIComponent(user.id)}`);
  return account.status === 200 ? { userId: user.id, email: user.email } : null;
}

// Keycloak's admin REST API, read-only, as the directory client (view-users).
const DIRECTORY_BASE = /^(https:\/\/.+)\/realms\/([^/]+)\/?$/.exec(ISSUER);
let directoryConfig;
let directoryToken = { value: "", exp: 0 };
async function directory(path) {
  if (!DIRECTORY_CLIENT_ID || !DIRECTORY_BASE) throw Object.assign(new Error("No directory is configured for lookups."), { status: 503 });
  if (directoryToken.exp < Date.now() / 1000 + 30) {
    directoryConfig ??= await oidc.discovery(new URL(ISSUER), DIRECTORY_CLIENT_ID, DIRECTORY_CLIENT_SECRET);
    const tokens = await oidc.clientCredentialsGrant(directoryConfig);
    directoryToken = { value: tokens.access_token, exp: Date.now() / 1000 + (tokens.expires_in ?? 60) };
  }
  const res = await fetch(`${DIRECTORY_BASE[1]}/admin/realms/${DIRECTORY_BASE[2]}${path}`, {
    headers: { authorization: `Bearer ${directoryToken.value}`, accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`directory: HTTP ${res.status}`);
  return res.json();
}
const personName = (u) => [u.firstName, u.lastName].filter(Boolean).join(" ") || u.username || u.email;

async function consoleApi(req, res, url) {
  const json = (status, body) => send(res, status, { "content-type": "application/json" }, JSON.stringify(body));
  const fail = (status, message) => json(status, { error: { code: status === 403 ? "FORBIDDEN" : "OAE_EDGE", message } });
  if (req.method !== "GET" && (req.headers.origin !== OCE_URL || !/^application\/json\b/.test(String(req.headers["content-type"] ?? "")))) {
    return fail(403, "Cross-origin request refused.");
  }
  const admin = await consoleAdministrator(req);
  if (!admin) return fail(403, "Managing people requires Installation administration.");
  const route = `${req.method} ${url.pathname}`;
  if (route === "GET /oae/api/status") {
    return json(200, { data: { appsUrl: APPS_URL, directory: Boolean(DIRECTORY_CLIENT_ID && DIRECTORY_BASE) } });
  }
  // Whether an Agent runs on a person's Claude subscription token (one person only).
  if (route === "GET /oae/api/agent") {
    const namespaceId = String(url.searchParams.get("namespaceId") ?? "");
    const agentId = String(url.searchParams.get("agentId") ?? "");
    if (!INSTALLATION_ID || !/^ns_[0-9a-f-]{36}$/.test(namespaceId) || !/^agt_[0-9a-f-]{36}$/.test(agentId)) {
      return fail(400, "Unknown Agent.");
    }
    const host = agentHost(namespaceId, agentId);
    return json(200, { data: { host, personal: agentsMeta()[host]?.personal === true } });
  }
  if (route === "GET /oae/api/people") {
    const all = await people.load({ fresh: true });
    return json(200, { data: Object.entries(all).map(([principalId, p]) => ({ principalId, ...p })) });
  }
  if (route === "GET /oae/api/directory") {
    const email = String(url.searchParams.get("email") ?? "").trim().toLowerCase();
    if (!/^[^@\s]{1,128}@[^@\s]{1,253}\.[^@\s]{1,63}$/.test(email)) return fail(400, "Enter an email address.");
    const found = ((await directory(`/users?email=${encodeURIComponent(email)}&exact=true&briefRepresentation=true`)) ?? []).find(
      (u) => String(u.email ?? "").toLowerCase() === email,
    );
    log("console.directory.lookup", { by: admin.email, email, found: Boolean(found) });
    if (!found) return json(200, { data: null });
    const known = Object.entries(await people.load({ fresh: true })).find(([, p]) => p.subject === found.id);
    return json(200, {
      data: {
        subject: found.id,
        email,
        name: personName(found),
        enabled: found.enabled !== false,
        ...(known ? { principalId: known[0], userId: known[1].userId } : {}),
      },
    });
  }
  // OCE answers account reads only with an Origin header, which browsers omit on same-origin GETs:
  // the panel reads one account here, with the same administrator session, and gets only what
  // linking an SSO identity needs.
  if (route === "GET /oae/api/account") {
    const userId = String(url.searchParams.get("userId") ?? "");
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(userId)) return fail(400, "Invalid account ID.");
    const account = await oce(req, "GET", `/api/auth/accounts/${encodeURIComponent(userId)}`);
    if (account.status !== 200) return fail(404, "No such account.");
    const methods = (account.data?.methods ?? []).map((m) => ({ providerId: m.providerId, subject: m.subject }));
    return json(200, { data: { principalId: account.data?.principalId, version: account.data?.version, methods } });
  }
  if (route === "POST /oae/api/people") {
    let userId;
    try {
      userId = JSON.parse(await readBody(req)).userId;
    } catch {
      return fail(400, "Invalid request.");
    }
    if (typeof userId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(userId)) return fail(400, "Invalid account ID.");
    // Everything recorded comes from OCE's account and the directory, never from the request.
    const account = await oce(req, "GET", `/api/auth/accounts/${encodeURIComponent(userId)}`);
    if (account.status !== 200) return fail(404, "No such account.");
    const principalId = account.data?.principalId;
    const subject = (account.data?.methods ?? []).find((m) => String(m.providerId ?? "").startsWith("oidc:"))?.subject;
    if (typeof principalId !== "string" || typeof subject !== "string") return fail(409, "The account has no SSO identity yet.");
    const person = await directory(`/users/${encodeURIComponent(subject)}`);
    if (!person?.email) return fail(409, "The SSO identity is not in the directory.");
    const record = { email: String(person.email).toLowerCase(), userId, subject };
    await people.update((all) => ({ ...all, [principalId]: record }));
    log("console.people.recorded", { by: admin.email, principalId, email: record.email, subject });
    return json(200, { data: { principalId, ...record } });
  }
  return fail(404, "Not found.");
}

// --- server ---------------------------------------------------------------------------------
createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://local");
    if (url.pathname === "/healthz") return send(res, 200, {}, "ok");
    if (url.pathname === "/assets/instrument-sans-latin.woff2" && req.method === "GET")
      return send(res, 200, { "content-type": "font/woff2", "cache-control": "public, max-age=604800" }, FONT);
    if (url.pathname === "/check") return await check(req, res);
    const host = String(req.headers.host ?? "").toLowerCase().split(":")[0];
    if (host === CONSOLE_HOST && url.pathname.startsWith("/oae/api/")) return await consoleApi(req, res, url);
    // The remaining routes are served on the auth host only.
    if (host !== AUTH_HOST) return send(res, 404, {}, "not found");
    if (url.pathname === "/login" && req.method === "GET") return await login(req, res, url);
    if (url.pathname === "/callback" && req.method === "GET") return await callback(req, res, url);
    if (url.pathname === "/logout") return logout(req, res);
    if (url.pathname === "/apps" && req.method === "GET") return await appsPage(req, res);
    if (url.pathname === "/apps/connect") return await appsConnect(req, res);
    if (url.pathname === "/apps/revoke") return await appsRevoke(req, res);
    if (url.pathname.startsWith("/open/") && req.method === "GET") return open(res, url);
    return send(res, 404, {}, "not found");
  } catch (error) {
    log("request.failed", { message: error.message });
    if (!res.headersSent) {
      const status = error.status ?? 500;
      send(res, status, { "content-type": "application/json" }, JSON.stringify({ error: { code: "OAE_EDGE", message: status === 500 ? "The request failed." : error.message } }));
    }
  }
}).listen(PORT, () => log("listening", { port: PORT, authHost: AUTH_HOST, agentsDomain: AGENTS_DOMAIN, consoleHost: CONSOLE_HOST }));
