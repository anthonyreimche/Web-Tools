// Minimal OAuth 1.0a (HMAC-SHA1) helper — used by Flickr and SmugMug.
// Node built-ins only. Implements the three-legged flow with a localhost
// callback so the user never copy/pastes a verifier.

import { createHmac, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";

const enc = (s) => encodeURIComponent(s).replace(/[!*'()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

function baseString(method, url, params) {
  const norm = Object.keys(params).sort().map((k) => `${enc(k)}=${enc(params[k])}`).join("&");
  return `${method.toUpperCase()}&${enc(url)}&${enc(norm)}`;
}

function sign(method, url, params, consumerSecret, tokenSecret = "") {
  const key = `${enc(consumerSecret)}&${enc(tokenSecret)}`;
  return createHmac("sha1", key).update(baseString(method, url, params)).digest("base64");
}

/** Build the full set of signed oauth_* params for a request. */
export function signedParams(method, url, extra, { consumerKey, consumerSecret, token, tokenSecret }) {
  const oauth = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_version: "1.0",
    ...(token ? { oauth_token: token } : {}),
    ...extra,
  };
  oauth.oauth_signature = sign(method, url, oauth, consumerSecret, tokenSecret);
  return oauth;
}

/** "key=val&..." query string (encoded), sorted for stability. */
export function toQuery(params) {
  return Object.keys(params).sort().map((k) => `${enc(k)}=${enc(params[k])}`).join("&");
}

/** Authorization: OAuth ... header value. */
export function authHeader(params) {
  return "OAuth " + Object.keys(params).map((k) => `${enc(k)}="${enc(params[k])}"`).join(", ");
}

function openBrowser(url) {
  const cmd = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try { spawn(cmd, args, { stdio: "ignore", detached: true }).unref(); } catch {}
}

/** Wait for the OAuth callback on http://localhost:<port>/callback; resolve its query. */
function awaitCallback(port) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url, `http://localhost:${port}`);
      if (u.pathname !== "/callback") { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<h2>Authorized — you can close this tab and return to the terminal.</h2>");
      server.close();
      resolve(Object.fromEntries(u.searchParams.entries()));
    });
    server.on("error", reject);
    server.listen(port);
  });
}

async function form(url, method, params) {
  const res = await fetch(url, {
    method,
    headers: { Authorization: authHeader(params) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${url} → ${res.status}: ${text.slice(0, 200)}`);
  return Object.fromEntries(new URLSearchParams(text));
}

/**
 * Run the three-legged OAuth 1.0a flow.
 * @param {object} ep  { requestTokenUrl, authorizeUrl, accessTokenUrl }
 * @param {object} app { consumerKey, consumerSecret, scopePerms? }
 * @returns {{token:string, tokenSecret:string, raw:object}}
 */
export async function threeLegged(ep, app, port = 53682) {
  const callback = `http://localhost:${port}/callback`;

  // 1. Request token.
  const reqParams = signedParams("GET", ep.requestTokenUrl, { oauth_callback: callback }, app);
  const rt = await form(`${ep.requestTokenUrl}?${toQuery(reqParams)}`, "GET", reqParams);
  if (!rt.oauth_token) throw new Error("no request token returned");

  // 2. Authorize in the browser; wait for the callback.
  const authUrl = `${ep.authorizeUrl}?oauth_token=${enc(rt.oauth_token)}` + (app.scopePerms ? `&perms=${app.scopePerms}` : "");
  console.log("Opening browser to authorize…\n  " + authUrl);
  openBrowser(authUrl);
  const cb = await awaitCallback(port);
  if (!cb.oauth_verifier) throw new Error("no verifier in callback");

  // 3. Access token.
  const accParams = signedParams("GET", ep.accessTokenUrl,
    { oauth_verifier: cb.oauth_verifier },
    { ...app, token: rt.oauth_token, tokenSecret: rt.oauth_token_secret });
  const at = await form(`${ep.accessTokenUrl}?${toQuery(accParams)}`, "GET", accParams);
  if (!at.oauth_token) throw new Error("no access token returned");
  return { token: at.oauth_token, tokenSecret: at.oauth_token_secret, raw: at };
}
