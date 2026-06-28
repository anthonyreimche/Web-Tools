// SmugMug adapter (OAuth 1.0a). Login is implemented via the shared OAuth1
// helper; upload is scaffolded — SmugMug uploads via an HTTP PUT to
// upload.smugmug.com with X-Smug-* headers into an album key. Fill in once you
// have an API key (smugmug.com/api).

import { threeLegged } from "./oauth1.js";
import { setTokens, getTokens } from "./tokens.js";

export const id = "smugmug";
export const label = "SmugMug";

const EP = {
  requestTokenUrl: "https://secure.smugmug.com/services/oauth/1.0a/getRequestToken",
  authorizeUrl: "https://secure.smugmug.com/services/oauth/1.0a/authorize",
  accessTokenUrl: "https://secure.smugmug.com/services/oauth/1.0a/getAccessToken",
};

function app(cfg) {
  const a = (cfg.services && cfg.services.smugmug) || {};
  if (!a.apiKey || !a.apiSecret) throw new Error("SmugMug not configured. Set services.smugmug.apiKey/apiSecret.");
  return { consumerKey: a.apiKey, consumerSecret: a.apiSecret };
}

export async function login(cfg) {
  const tokens = await threeLegged(EP, app(cfg));
  await setTokens(cfg, id, { token: tokens.token, tokenSecret: tokens.tokenSecret });
  console.log("✓ SmugMug authorized.");
}

export async function push(cfg, project, webDir, opts = {}) {
  const tokens = await getTokens(cfg, id);
  if (!tokens) throw new Error("Not logged in to SmugMug. Run: swt login smugmug");
  // TODO: create/resolve an album, then PUT each web image to upload.smugmug.com
  // with headers: X-Smug-AlbumUri, X-Smug-FileName, Authorization (OAuth1 PUT).
  throw new Error("SmugMug upload not implemented yet — login works; wire up the PUT-to-album step.");
}
