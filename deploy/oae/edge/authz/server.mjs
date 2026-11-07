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
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
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
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  // Not "no-referrer": under it browsers send "Origin: null" on this page's own form posts.
  // same-origin still sends nothing to other sites.
  "referrer-policy": "same-origin",
  "x-content-type-options": "nosniff",
};
const STYLE =
  "body{font-family:system-ui;margin:2rem auto;max-width:46rem;padding:0 1rem;line-height:1.45}" +
  "table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:.4rem .5rem;border-bottom:1px solid #ddd;vertical-align:top}" +
  "form{display:inline}input[type=text]{width:9rem}code,.secret{font-family:ui-monospace,monospace;word-break:break-all}" +
  ".secret{background:#f4f4f4;padding:.5rem;border-radius:4px;display:block}.muted{color:#666}.qr{max-width:16rem}";
const page = (title, html) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${STYLE}</style><body><h1>${esc(title)}</h1>${html}</body>`;
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
      runtime: meta[host]?.runtime === "hermes" ? "hermes" : "openclaw",
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
  const tokens = Object.values(await devices.load())
    .filter((d) => d.sub === session.sub)
    .sort((a, b) => String(b.created).localeCompare(String(a.created)));
  const agentRows = agents.length
    ? agents
        .map(
          (a) => `<tr><td><a href="https://${esc(a.host)}/" target="_blank" rel="noopener">${esc(a.name)}</a><div class="muted">${a.runtime === "hermes" ? "Hermes" : "OpenClaw"} · ${esc(a.level)}</div></td>
<td><form method="post" action="/apps/connect"><input type="hidden" name="host" value="${esc(a.host)}">
<input type="text" name="label" maxlength="40" placeholder="${a.runtime === "hermes" ? "e.g. laptop" : "e.g. my phone"}" required pattern="[A-Za-z0-9 ._-]{1,40}" aria-label="Name for this app">
<button type="submit">${a.runtime === "hermes" ? "Connect Hermes Desktop" : "Connect the mobile app"}</button></form></td></tr>`,
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
    return json(200, { data: { personal: agentsMeta()[agentHost(namespaceId, agentId)]?.personal === true } });
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
