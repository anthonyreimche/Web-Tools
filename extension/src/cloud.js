// Direct Cloudflare path — the extension talks to the gallery Worker itself
// (allowed by the app CSP), so there is NO local helper, folder, or wrangler.
//
// Publish = upload images + manifest to the Worker. Decisions = poll the Worker
// and apply flags. Config (Worker URL + write key) lives in api.settings.
//
// Galleries are tracked as a LIST in settings (key "galleries"), so several can
// be live at once — publish one folder's picks, keep editing, and each gallery's
// client decisions sync back independently on the poll.

import { newProjectId, newProjectToken, newPhotoId, makeProject, validateDecision, bucketDecision } from "../../shared/protocol.js";
import { encodeJpeg } from "./images.js";

export function cloudConfig(api) {
  // Normalize at read-time so a URL pasted without a scheme (e.g. straight from
  // the Cloudflare dashboard, "swt-worker.you.workers.dev") still resolves to the
  // Worker. Without https://, fetch() and window.open() resolve relative to the
  // app:// origin — uploads silently fail and "Open" spawns a new app window.
  let workerUrl = (api.settings.get("cloudWorkerUrl", "") || "").trim().replace(/\/+$/, "");
  if (workerUrl && !/^https?:\/\//i.test(workerUrl)) workerUrl = "https://" + workerUrl;
  return {
    workerUrl,
    writeKey: api.settings.get("cloudWriteKey", ""),
  };
}
export function cloudReady(api) {
  const c = cloudConfig(api);
  return !!(c.workerUrl && c.writeKey);
}

/**
 * Live connectivity probe — what makes the status dot mean "actually reachable
 * and authorized", not just "both fields are filled in". Uses endpoints the
 * Worker already exposes, so no redeploy is needed:
 *   - GET /health           → {ok:true} confirms the URL is a Web Tools Worker
 *   - GET /decision/<probe> → 404 when the write key is accepted, 401 when not
 * Never throws; always resolves to a {state, ok, message} object.
 */
export async function checkConnection(api, { signal } = {}) {
  const c = cloudConfig(api);
  if (!c.workerUrl || !c.writeKey) {
    return { state: "unconfigured", ok: false, message: "Needs your Worker URL + key" };
  }
  // 1. Reachable, and actually the right Worker?
  let health;
  try {
    const r = await fetch(`${c.workerUrl}/health`, { signal });
    if (!r.ok) return { state: "unreachable", ok: false, message: `Worker returned ${r.status}` };
    health = await r.json().catch(() => null);
  } catch {
    return { state: "unreachable", ok: false, message: "Can't reach the Worker URL" };
  }
  if (!health || health.ok !== true) {
    return { state: "bad-worker", ok: false, message: "That URL isn't a Web Tools Worker" };
  }
  // 2. Write key accepted? 401 = rejected; 404 (no such decision) = accepted.
  try {
    const r = await fetch(`${c.workerUrl}/decision/__conncheck__`, {
      headers: { Authorization: `Bearer ${c.writeKey}` }, signal,
    });
    if (r.status === 401) return { state: "bad-key", ok: false, message: "Write key rejected" };
  } catch {
    return { state: "unreachable", ok: false, message: "Can't reach the Worker URL" };
  }
  return { state: "ok", ok: true, message: "Connected to your Worker" };
}

/** Dot colour for a checkConnection state. Pure — safe outside React. */
export function connColor(state) {
  switch (state) {
    case "ok": return "#3fb950";
    case "checking": return "var(--color-warning, #d29922)";
    case "unconfigured": return "var(--color-text-secondary)";
    default: return "#f0506e"; // unreachable | bad-worker | bad-key
  }
}

/**
 * React hook (React injected by the host) that runs checkConnection now and
 * again whenever settings change, debounced. Stale/aborted runs are ignored so
 * the dot never flickers to a wrong state mid-check.
 */
export function useConnection(React, api) {
  const { useState, useEffect } = React;
  const [status, setStatus] = useState({ state: "checking", ok: false, message: "Checking…" });
  useEffect(() => {
    let active = true, runId = 0, controller = null, timer = null;
    const run = () => {
      const myId = ++runId;
      if (controller) controller.abort();
      controller = typeof AbortController !== "undefined" ? new AbortController() : null;
      checkConnection(api, { signal: controller ? controller.signal : undefined })
        .then((s) => { if (active && myId === runId) setStatus(s); })
        .catch(() => {});
    };
    run();
    const off = api.settings.onChange(() => { if (timer) clearTimeout(timer); timer = setTimeout(run, 400); });
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      if (controller) controller.abort();
      if (typeof off === "function") off();
    };
  }, []);
  return status;
}

export function cloudShareLink(cfg, projectId, token) {
  if (!cfg.workerUrl) return "";
  return `${cfg.workerUrl}/g/${projectId}${token ? `?t=${token}` : ""}`;
}

async function putImage(cfg, projectId, photoId, blob, thumb) {
  const url = `${cfg.workerUrl}/img/${projectId}/${photoId}${thumb ? "?v=thumb" : ""}`;
  const res = await fetch(url, { method: "PUT", headers: { Authorization: `Bearer ${cfg.writeKey}`, "Content-Type": "image/jpeg" }, body: blob });
  if (!res.ok) throw new Error(`image upload failed (${res.status})`);
}

// ── Gallery list (multiple live galleries) ────────────────────────────────────
// Each record: { projectId, kind, title, token, folder, count, createdAt,
//                appliedAt, lastInfo }. `token` is "" for public galleries.

const GKEY = "galleries";

export function listGalleries(api) {
  const v = api.settings.get(GKEY, null);
  if (Array.isArray(v)) return v;
  // First run on the new shape: migrate the old single-gallery state once.
  const migrated = migrateLegacy(api);
  api.settings.set(GKEY, migrated);
  return migrated;
}

function saveGalleries(api, galleries) { api.settings.set(GKEY, galleries); }

function addGallery(api, rec) {
  // Newest first; replace any existing record for the same project.
  const galleries = listGalleries(api).filter((g) => g.projectId !== rec.projectId);
  galleries.unshift(rec);
  saveGalleries(api, galleries);
}

/** Stop tracking a gallery locally (keeps it online). */
export function removeGallery(api, projectId) {
  saveGalleries(api, listGalleries(api).filter((g) => g.projectId !== projectId));
  api.settings.set(`project:${projectId}`, null); // drop the apply-back cache
}

/** Take a gallery offline (DELETE on the Worker) and stop tracking it. */
export async function unpublishGallery(api, projectId) {
  const cfg = cloudConfig(api);
  if (cfg.workerUrl && cfg.writeKey) {
    try {
      await fetch(`${cfg.workerUrl}/g/${projectId}`, {
        method: "DELETE", headers: { Authorization: `Bearer ${cfg.writeKey}` },
      });
    } catch { /* offline delete is best-effort; still drop it locally */ }
  }
  removeGallery(api, projectId);
}

// One-time migration from the pre-multi-gallery shape: a single `lastPublished`
// record plus a `cloudProjects` poll map. Client tokens were only kept for
// lastPublished, so other proofing galleries migrate view-only (no submit token).
function migrateLegacy(api) {
  const out = [];
  const seen = new Set();
  const push = (rec) => {
    if (rec && rec.projectId && !seen.has(rec.projectId)) { seen.add(rec.projectId); out.push(rec); }
  };
  const last = api.settings.get("lastPublished", null);
  const projects = api.settings.get("cloudProjects", {}) || {};
  for (const id of Object.keys(projects)) {
    const cache = api.settings.get(`project:${id}`, null);
    push({
      projectId: id,
      kind: (cache && cache.kind) || (id.startsWith("pub") ? "public" : "proofing"),
      title: (cache && cache.title) || "Gallery",
      token: last && last.projectId === id ? (last.token || "") : "",
      folder: "",
      count: cache && Array.isArray(cache.photos) ? cache.photos.length : 0,
      createdAt: "",
      appliedAt: (projects[id] && projects[id].appliedAt) || "",
      lastInfo: null,
    });
  }
  if (last) {
    push({
      projectId: last.projectId, kind: last.kind || "proofing", title: last.title || "Gallery",
      token: last.token || "", folder: "", count: 0, createdAt: "", appliedAt: "", lastInfo: null,
    });
  }
  return out;
}

// ── Image preparation ─────────────────────────────────────────────────────────

/**
 * Build the upload-ready images for every source photo, as
 * [{ photo, photoId, web, thumb, width, height }].
 *
 * PUBLIC galleries render each photo through the core export pipeline
 * (api.export.renderPhotos) at the user's export resolution/quality, so the
 * portfolio is full-resolution — not the low-res catalog preview. PROOFING
 * galleries (and any host too old to expose api.export, or photos that fail to
 * render) use the fast catalog preview, which is all a pick/reject pass needs.
 */
async function prepareImages(api, { kind, source, webEdge, quality, exportSettings, getBlob, onProgress }) {
  const items = source.map((p) => ({ photo: p, photoId: newPhotoId(), web: null, thumb: null, width: 0, height: 0 }));
  const total = source.length;

  // Full-resolution render for public portfolios (one WebGL context for the batch).
  let renderedById = null;
  if (kind === "public" && api.export && exportSettings) {
    try {
      const rendered = await api.export.renderPhotos(source, exportSettings, (p) =>
        onProgress && onProgress(p.done, total, "render"));
      renderedById = new Map((rendered || []).map((r) => [r.photo.id, r]));
    } catch {
      renderedById = null; // fall through to the preview path below
    }
  }

  let done = 0;
  for (const it of items) {
    const p = it.photo;
    let webBlob = null, width = 0, height = 0;
    const r = renderedById && renderedById.get(p.id);
    if (r && r.blob) {
      webBlob = r.blob; width = r.width; height = r.height;
    } else {
      // Preview path: downscale the catalog preview to the configured web size.
      const src = await getBlob(p);
      if (src) { const web = await encodeJpeg(src, webEdge, quality); webBlob = web.blob; width = web.w; height = web.h; }
    }
    if (webBlob) {
      it.web = webBlob; it.width = width; it.height = height;
      const t = await encodeJpeg(webBlob, 512, quality); // gallery grid thumbnail
      it.thumb = t.blob;
    }
    done++;
    onProgress && onProgress(done, total, "prep");
  }
  return items;
}

/**
 * Build + upload a gallery directly to the Worker.
 * @returns the full project (with token) on success.
 */
export async function publishToCloud(api, {
  kind, title, client, photographer, source, webEdge, quality, exportSettings, folder,
  getBlob, onProgress, onStatus,
}) {
  const cfg = cloudConfig(api);
  if (!cfg.workerUrl || !cfg.writeKey) throw new Error("Set your Worker URL and key in Preferences → Web Tools.");

  const projectId = newProjectId(kind);
  const token = kind === "proofing" ? newProjectToken() : "";

  // 1) Build the images. Public renders full-res (slow, hence the status update).
  if (kind === "public" && api.export && exportSettings && onStatus) onStatus("Rendering high-resolution images…");
  const items = await prepareImages(api, {
    kind, source, webEdge, quality, exportSettings, getBlob,
    onProgress: (n, t, phase) => { if (phase === "render" && onStatus) onStatus(`Rendering ${n}/${t}…`); },
  });

  // 2) Upload the images.
  if (onStatus) onStatus("Uploading…");
  const manifestPhotos = [];
  let done = 0;
  for (const it of items) {
    if (it.web) {
      await putImage(cfg, projectId, it.photoId, it.web, false);
      if (it.thumb) await putImage(cfg, projectId, it.photoId, it.thumb, true);
    }
    manifestPhotos.push({
      photoId: it.photoId, catalogId: it.photo.id, filename: it.photo.filename,
      width: it.width, height: it.height,
      prePick: it.photo.flag === "pick" || it.photo.flag === "reject" ? it.photo.flag : "none",
    });
    done++;
    onProgress && onProgress(done, items.length);
  }

  // 3) Upload the manifest.
  const project = makeProject({
    projectId, kind, title, photographer,
    client: kind === "proofing" ? client : undefined, token, photos: manifestPhotos,
  });
  const res = await fetch(`${cfg.workerUrl}/project/${projectId}`, {
    method: "PUT", headers: { Authorization: `Bearer ${cfg.writeKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ project }),
  });
  if (!res.ok) throw new Error(`manifest upload failed (${res.status})`);

  // 4) Persist: the photoId→catalogId apply-back cache, and the gallery record
  // (which both the panel list and the decision poller read).
  api.settings.set(`project:${projectId}`, { projectId, kind, title, photos: project.photos.map((p) => ({ photoId: p.photoId, catalogId: p.catalogId })) });
  addGallery(api, {
    projectId, kind, title, token, folder: folder || "",
    count: manifestPhotos.length, createdAt: project.createdAt, appliedAt: "", lastInfo: null,
  });

  return project;
}

async function fetchDecision(cfg, projectId) {
  const res = await fetch(`${cfg.workerUrl}/decision/${projectId}`, { headers: { Authorization: `Bearer ${cfg.writeKey}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`decision ${projectId}: ${res.status}`);
  return res.json();
}

async function applyDecision(api, projectId, decision) {
  const cached = api.settings.get(`project:${projectId}`, null);
  if (!cached) return null;
  const buckets = bucketDecision(cached, decision);
  const catalog = api.stores.useCatalogStore.getState();
  if (buckets.pick.length) await catalog.applyFlag(buckets.pick, "pick");
  if (buckets.reject.length) await catalog.applyFlag(buckets.reject, "reject");
  if (buckets.none.length) await catalog.applyFlag(buckets.none, "none");
  return { projectId, title: cached.title, client: decision.client && decision.client.name, note: decision.note, counts: { pick: buckets.pick.length, reject: buckets.reject.length, none: buckets.none.length }, unknown: buckets.unknown.length };
}

async function sweep(api, onApplied) {
  if (!cloudReady(api)) return;
  const cfg = cloudConfig(api);
  const galleries = listGalleries(api);
  let changed = false;
  for (const g of galleries) {
    if (g.kind !== "proofing") continue; // public galleries have no decision loop
    let decision;
    try { decision = await fetchDecision(cfg, g.projectId); } catch { continue; }
    if (!decision || validateDecision(decision).length) continue;
    if (g.appliedAt && g.appliedAt >= decision.submittedAt) continue;
    const info = await applyDecision(api, g.projectId, decision);
    g.appliedAt = decision.submittedAt;
    if (info) g.lastInfo = { client: info.client || "", counts: info.counts, note: info.note || "", at: decision.submittedAt };
    changed = true;
    if (info && onApplied) onApplied(info);
  }
  if (changed) saveGalleries(api, galleries);
}

/** Start polling the Worker for client decisions (Cloudflare backend). */
export function startCloudPoller(api, onApplied) {
  const tick = () => sweep(api, onApplied).catch(() => {});
  const t = setInterval(tick, 30000);
  tick();
  return () => clearInterval(t);
}

export function checkCloudNow(api, onApplied) {
  return sweep(api, onApplied);
}
