// Direct Cloudflare path — the extension talks to the gallery Worker itself
// (allowed by the app CSP), so there is NO local helper, folder, or wrangler.
//
// Publish = upload images + manifest to the Worker. Decisions = poll the Worker
// and apply flags. Config (Worker URL + write key) lives in api.settings.

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

/**
 * Build + upload a gallery directly to the Worker.
 * @returns the full project (with token) on success.
 */
export async function publishToCloud(api, { kind, title, client, photographer, source, webEdge, quality, getBlob, onProgress }) {
  const cfg = cloudConfig(api);
  if (!cfg.workerUrl || !cfg.writeKey) throw new Error("Set your Worker URL and key in Preferences → Web Tools.");

  const projectId = newProjectId(kind);
  const token = kind === "proofing" ? newProjectToken() : "";
  const manifestPhotos = [];

  let done = 0;
  for (const p of source) {
    const photoId = newPhotoId();
    const blob = await getBlob(p);
    let w = 0, h = 0;
    if (blob) {
      const web = await encodeJpeg(blob, webEdge, quality);
      const thumb = await encodeJpeg(blob, 512, quality);
      await putImage(cfg, projectId, photoId, web.blob, false);
      await putImage(cfg, projectId, photoId, thumb.blob, true);
      w = web.w; h = web.h;
    }
    manifestPhotos.push({ photoId, catalogId: p.id, filename: p.filename, width: w, height: h, prePick: p.flag === "pick" || p.flag === "reject" ? p.flag : "none" });
    done++;
    onProgress && onProgress(done, source.length);
  }

  const project = makeProject({ projectId, kind, title, photographer, client: kind === "proofing" ? client : undefined, token, photos: manifestPhotos });

  const res = await fetch(`${cfg.workerUrl}/project/${projectId}`, {
    method: "PUT", headers: { Authorization: `Bearer ${cfg.writeKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ project }),
  });
  if (!res.ok) throw new Error(`manifest upload failed (${res.status})`);

  // Cache photoId→catalogId for the decision apply-back, and register the
  // project as active so the poller checks it.
  api.settings.set(`project:${projectId}`, { projectId, kind, title, photos: project.photos.map((p) => ({ photoId: p.photoId, catalogId: p.catalogId })) });
  const active = api.settings.get("cloudProjects", {}) || {};
  active[projectId] = { appliedAt: "" };
  api.settings.set("cloudProjects", active);

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
  const active = api.settings.get("cloudProjects", {}) || {};
  for (const id of Object.keys(active)) {
    let decision;
    try { decision = await fetchDecision(cfg, id); } catch { continue; }
    if (!decision || validateDecision(decision).length) continue;
    if (active[id].appliedAt && active[id].appliedAt >= decision.submittedAt) continue;
    const info = await applyDecision(api, id, decision);
    active[id] = { appliedAt: decision.submittedAt };
    api.settings.set("cloudProjects", active);
    if (info && onApplied) onApplied(info);
  }
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
