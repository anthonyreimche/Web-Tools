// Flickr adapter (OAuth 1.0a). Needs a Flickr app key/secret in config:
//   cfg.services.flickr = { apiKey, apiSecret }   (get one at flickr.com/services/apps/create)
//
// NOTE: implemented to Flickr's documented API but not exercised against the
// live service here — verify with a real app key. Upload signs only the oauth_*
// params (the photo binary is excluded from the OAuth base string, per Flickr).

import { readFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { signedParams, toQuery } from "./oauth1.js";
import { getTokens, setTokens } from "./tokens.js";

const EP = {
  requestTokenUrl: "https://www.flickr.com/services/oauth/request_token",
  authorizeUrl: "https://www.flickr.com/services/oauth/authorize",
  accessTokenUrl: "https://www.flickr.com/services/oauth/access_token",
};
const UPLOAD = "https://up.flickr.com/services/upload/";
const REST = "https://api.flickr.com/services/rest";

export const id = "flickr";
export const label = "Flickr";

function app(cfg) {
  const a = (cfg.services && cfg.services.flickr) || {};
  if (!a.apiKey || !a.apiSecret) {
    throw new Error("Flickr not configured. Set services.flickr.apiKey/apiSecret in swt.config.local.json.");
  }
  return { consumerKey: a.apiKey, consumerSecret: a.apiSecret, scopePerms: "write" };
}

export async function login(cfg) {
  const { threeLegged } = await import("./oauth1.js");
  const tokens = await threeLegged(EP, app(cfg));
  await setTokens(cfg, id, { token: tokens.token, tokenSecret: tokens.tokenSecret, user: tokens.raw.user_nsid });
  console.log(`✓ Flickr authorized as ${tokens.raw.username || tokens.raw.user_nsid}`);
}

async function rest(cfg, tokens, method, extra = {}) {
  const a = app(cfg);
  const params = signedParams("POST", REST,
    { method, format: "json", nojsoncallback: "1", ...extra },
    { consumerKey: a.consumerKey, consumerSecret: a.consumerSecret, token: tokens.token, tokenSecret: tokens.tokenSecret });
  const res = await fetch(REST, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: toQuery(params),
  });
  const j = await res.json();
  if (j.stat !== "ok") throw new Error(`flickr ${method}: ${j.message || JSON.stringify(j)}`);
  return j;
}

async function uploadOne(cfg, tokens, filePath, title) {
  const a = app(cfg);
  // Sign only the oauth params (no photo) for the upload endpoint.
  const params = signedParams("POST", UPLOAD, { title: title || "" },
    { consumerKey: a.consumerKey, consumerSecret: a.consumerSecret, token: tokens.token, tokenSecret: tokens.tokenSecret });

  const fd = new FormData();
  for (const [k, v] of Object.entries(params)) fd.append(k, v);
  const bytes = await readFile(filePath);
  fd.append("photo", new Blob([bytes], { type: "image/jpeg" }), basename(filePath));

  const res = await fetch(UPLOAD, { method: "POST", body: fd });
  const xml = await res.text();
  const m = xml.match(/<photoid[^>]*>(\d+)<\/photoid>/);
  if (!m) throw new Error("flickr upload failed: " + xml.slice(0, 200));
  return m[1];
}

/** Upload a project's web images; optionally collect them into an album. */
export async function push(cfg, project, webDir, opts = {}) {
  const tokens = await getTokens(cfg, id);
  if (!tokens) throw new Error("Not logged in to Flickr. Run: swt login flickr");

  const uploaded = [];
  for (const p of project.photos) {
    const file = join(webDir, basename(p.web));
    process.stdout.write(`  Flickr ↑ ${p.filename}… `);
    const photoId = await uploadOne(cfg, tokens, file, p.filename);
    uploaded.push({ photoId: p.photoId, flickrId: photoId, url: `https://www.flickr.com/photos/${tokens.user}/${photoId}` });
    console.log("ok");
  }

  let albumUrl = null;
  if (opts.album && uploaded.length) {
    const created = await rest(cfg, tokens, "flickr.photosets.create",
      { title: opts.album, primary_photo_id: uploaded[0].flickrId });
    const setId = created.photoset.id;
    for (const u of uploaded.slice(1)) {
      await rest(cfg, tokens, "flickr.photosets.addPhoto", { photoset_id: setId, photo_id: u.flickrId });
    }
    albumUrl = `https://www.flickr.com/photos/${tokens.user}/albums/${setId}`;
    console.log(`  Album: ${albumUrl}`);
  }
  return { service: id, uploaded, albumUrl };
}
