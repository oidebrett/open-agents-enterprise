// oae-edge-authz — sign-in and per-Agent authorization for OAE's human ingress (docs/oae/edge-design.md).
//
// Traefik calls GET /check (forwardAuth) on every request to an Agent host, WebSocket upgrades
// included. A person without a session is sent to sign in through the installation's OIDC issuer;
// a signed-in person granted the Agent gets 200 with the two headers the Agent's gateway trusts
// (x-occ-identity, x-openclaw-scopes); anyone else gets 403. Traefik copies only those two headers
// to the upstream request, after stripping any client-supplied copies.
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import * as oidc from "openid-client";

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
const IDENTITY_PREFIX = env("OAE_EDGE_IDENTITY_PREFIX"); // issuer-qualified identities: <prefix>:<sub>
const SESSION_KEY = Buffer.from(env("OAE_EDGE_SESSION_KEY"), "hex");
const ACL_FILE = env("OAE_EDGE_ACL_FILE", "/acl/acl.json");
const SESSION_SECONDS = Number(env("OAE_EDGE_SESSION_SECONDS", String(8 * 3600)));
const PORT = Number(env("PORT", "8080"));
if (SESSION_KEY.length < 32) throw new Error("OAE_EDGE_SESSION_KEY must be at least 32 bytes of hex");

// Scope sets per grant level (oae-user grant … user|operator).
const SCOPES = {
  user: "operator.read,operator.write",
  operator: "operator.read,operator.write,operator.approvals",
};
const SESSION_COOKIE = "oae_edge";
const TX_COOKIE = "oae_edge_tx";
const REDIRECT_URI = `https://${AUTH_HOST}/callback`;

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

// --- ACL (written by oae-edge-sync: { "<agent host>": { "<sub>": "user" | "operator" } }) -----
let acl = {};
let aclMtime = 0;
function grants() {
  try {
    const m = statSync(ACL_FILE).mtimeMs;
    if (m !== aclMtime) {
      acl = JSON.parse(readFileSync(ACL_FILE, "utf8"));
      aclMtime = m;
    }
  } catch (error) {
    console.error(JSON.stringify({ event: "acl.read_failed", message: error.message }));
    acl = {}; // fail closed
  }
  return acl;
}

// --- helpers --------------------------------------------------------------------------------
const isAgentHost = (host) =>
  typeof host === "string" && host !== AUTH_HOST && /^[a-z0-9-]+$/.test(host.slice(0, -(AGENTS_DOMAIN.length + 1))) &&
  host.endsWith(`.${AGENTS_DOMAIN}`);
function safeReturnUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && isAgentHost(url.hostname) ? url.toString() : null;
  } catch {
    return null;
  }
}
function send(res, status, headers = {}, body = "") {
  res.writeHead(status, { "cache-control": "no-store", ...headers });
  res.end(body);
}
const page = (title, text) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;margin:3rem;max-width:40rem"><h1>${title}</h1><p>${text}</p></body>`;
const log = (event, fields = {}) => console.log(JSON.stringify({ event, ...fields }));

let config;
async function oidcConfig() {
  config ??= await oidc.discovery(new URL(ISSUER), CLIENT_ID, CLIENT_SECRET);
  return config;
}

// --- handlers -------------------------------------------------------------------------------
function check(req, res) {
  const host = String(req.headers["x-forwarded-host"] ?? "").toLowerCase().split(":")[0];
  if (!isAgentHost(host)) return send(res, 403, {}, "unknown host");
  const session = unseal(cookies(req)[SESSION_COOKIE]);
  if (!session) {
    const uri = String(req.headers["x-forwarded-uri"] ?? "/");
    const method = String(req.headers["x-forwarded-method"] ?? "GET");
    const wantsPage = method === "GET" && /text\/html/.test(String(req.headers.accept ?? ""));
    if (!wantsPage) return send(res, 401, {}, "sign in required");
    const rd = encodeURIComponent(`https://${host}${uri.startsWith("/") ? uri : "/"}`);
    return send(res, 302, { location: `https://${AUTH_HOST}/login?rd=${rd}` });
  }
  const level = grants()[host]?.[session.sub];
  const scopes = SCOPES[level];
  if (!scopes) {
    log("check.denied", { host, sub: session.sub });
    return send(res, 403, { "content-type": "text/html; charset=utf-8" },
      page("No access", `You are signed in as ${session.email ?? session.sub}, but you have not been given access to this Agent. Ask an administrator.`));
  }
  return send(res, 200, { "x-occ-identity": `${IDENTITY_PREFIX}:${session.sub}`, "x-openclaw-scopes": scopes });
}

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
    return send(res, 400, { "content-type": "text/html; charset=utf-8" }, page("Sign-in failed", "Please try again."));
  }
}

function logout(req, res) {
  return send(res, 200, {
    "content-type": "text/html; charset=utf-8",
    "set-cookie": cookie(SESSION_COOKIE, "", `Domain=.${AGENTS_DOMAIN}; Max-Age=0`),
  }, page("Signed out", "You are signed out of your Agents."));
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://local");
    if (url.pathname === "/healthz") return send(res, 200, {}, "ok");
    if (url.pathname === "/check") return check(req, res);
    // The remaining routes are served on the auth host only.
    const host = String(req.headers.host ?? "").toLowerCase().split(":")[0];
    if (host !== AUTH_HOST) return send(res, 404, {}, "not found");
    if (url.pathname === "/login" && req.method === "GET") return await login(req, res, url);
    if (url.pathname === "/callback" && req.method === "GET") return await callback(req, res, url);
    if (url.pathname === "/logout") return logout(req, res);
    return send(res, 404, {}, "not found");
  } catch (error) {
    log("request.failed", { message: error.message });
    if (!res.headersSent) send(res, 500, {}, "error");
  }
}).listen(PORT, () => log("listening", { port: PORT, authHost: AUTH_HOST, agentsDomain: AGENTS_DOMAIN }));
