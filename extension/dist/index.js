// ../shared/protocol.js
var PROJECT_SCHEMA = "swt.project/1";
var DECISION_SCHEMA = "swt.decision/1";
var FLAGS = (
  /** @type {const} */
  ["pick", "reject", "none"]
);
function rand(n) {
  const uuid = globalThis.crypto && globalThis.crypto.randomUUID ? globalThis.crypto.randomUUID().replace(/-/g, "") : Math.random().toString(16).slice(2).padEnd(32, "0");
  return uuid.slice(0, n);
}
function newProjectId(kind = "proofing") {
  const prefix = kind === "public" ? "pub" : "prf";
  const stamp = Date.now().toString(36);
  return `${prefix}-${stamp}-${rand(4)}`;
}
function newPhotoId() {
  return `p-${rand(10)}`;
}
function newProjectToken() {
  return `${rand(16)}${rand(16)}`;
}
var isStr = (v) => typeof v === "string" && v.length > 0;
var isFlag = (v) => FLAGS.includes(v);
function validateDecision(doc) {
  const errs = [];
  if (!doc || typeof doc !== "object") return ["decision is not an object"];
  if (doc.schema !== DECISION_SCHEMA) errs.push(`schema must be "${DECISION_SCHEMA}" (got "${doc.schema}")`);
  if (!isStr(doc.projectId)) errs.push("projectId missing");
  if (!Array.isArray(doc.decisions)) errs.push("decisions[] missing");
  else {
    doc.decisions.forEach((d, i) => {
      if (!isStr(d.photoId)) errs.push(`decisions[${i}].photoId missing`);
      if (!isFlag(d.pick)) errs.push(`decisions[${i}].pick invalid`);
    });
  }
  return errs;
}
function bucketDecision(project, decision) {
  const byPhotoId = new Map(project.photos.map((p) => [p.photoId, p.catalogId]));
  const out = { pick: [], reject: [], none: [], unknown: [] };
  for (const d of decision.decisions) {
    const catalogId = byPhotoId.get(d.photoId);
    if (!catalogId) {
      out.unknown.push(d.photoId);
      continue;
    }
    out[d.pick].push(catalogId);
  }
  return out;
}
function makeProject(o) {
  return {
    schema: PROJECT_SCHEMA,
    projectId: o.projectId || newProjectId(o.kind),
    kind: o.kind,
    title: o.title || "Untitled gallery",
    photographer: o.photographer || "",
    createdAt: o.createdAt || (/* @__PURE__ */ new Date()).toISOString(),
    client: o.kind === "proofing" ? o.client || {} : void 0,
    submitUrl: o.submitUrl || void 0,
    token: o.token || void 0,
    targets: o.targets || [],
    photos: o.photos.map((p) => ({
      photoId: p.photoId,
      catalogId: p.catalogId,
      filename: p.filename,
      web: p.web,
      thumb: p.thumb,
      width: p.width,
      height: p.height,
      prePick: p.prePick || "none"
    }))
  };
}

// src/images.js
async function encodeJpeg(srcBlob, longEdge, quality) {
  const bmp = await createImageBitmap(srcBlob);
  const scale = Math.min(1, longEdge / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h3 = Math.max(1, Math.round(bmp.height * scale));
  const canvas = new OffscreenCanvas(w, h3);
  canvas.getContext("2d").drawImage(bmp, 0, 0, w, h3);
  bmp.close && bmp.close();
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
  return { blob, w, h: h3 };
}

// src/cloud.js
function cloudConfig(api3) {
  let workerUrl = (api3.settings.get("cloudWorkerUrl", "") || "").trim().replace(/\/+$/, "");
  if (workerUrl && !/^https?:\/\//i.test(workerUrl)) workerUrl = "https://" + workerUrl;
  return {
    workerUrl,
    writeKey: api3.settings.get("cloudWriteKey", "")
  };
}
function cloudReady(api3) {
  const c = cloudConfig(api3);
  return !!(c.workerUrl && c.writeKey);
}
async function checkConnection(api3, { signal } = {}) {
  const c = cloudConfig(api3);
  if (!c.workerUrl || !c.writeKey) {
    return { state: "unconfigured", ok: false, message: "Needs your Worker URL + key" };
  }
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
  try {
    const r = await fetch(`${c.workerUrl}/decision/__conncheck__`, {
      headers: { Authorization: `Bearer ${c.writeKey}` },
      signal
    });
    if (r.status === 401) return { state: "bad-key", ok: false, message: "Write key rejected" };
  } catch {
    return { state: "unreachable", ok: false, message: "Can't reach the Worker URL" };
  }
  return { state: "ok", ok: true, message: "Connected to your Worker" };
}
function connColor(state) {
  switch (state) {
    case "ok":
      return "#3fb950";
    case "checking":
      return "var(--color-warning, #d29922)";
    case "unconfigured":
      return "var(--color-text-secondary)";
    default:
      return "#f0506e";
  }
}
function useConnection(React3, api3) {
  const { useState, useEffect } = React3;
  const [status, setStatus] = useState({ state: "checking", ok: false, message: "Checking\u2026" });
  useEffect(() => {
    let active = true, runId = 0, controller = null, timer = null;
    const run = () => {
      const myId = ++runId;
      if (controller) controller.abort();
      controller = typeof AbortController !== "undefined" ? new AbortController() : null;
      checkConnection(api3, { signal: controller ? controller.signal : void 0 }).then((s) => {
        if (active && myId === runId) setStatus(s);
      }).catch(() => {
      });
    };
    run();
    const off = api3.settings.onChange(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(run, 400);
    });
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      if (controller) controller.abort();
      if (typeof off === "function") off();
    };
  }, []);
  return status;
}
function cloudShareLink(cfg, projectId, token) {
  if (!cfg.workerUrl) return "";
  return `${cfg.workerUrl}/g/${projectId}${token ? `?t=${token}` : ""}`;
}
async function putImage(cfg, projectId, photoId, blob, thumb) {
  const url = `${cfg.workerUrl}/img/${projectId}/${photoId}${thumb ? "?v=thumb" : ""}`;
  const res = await fetch(url, { method: "PUT", headers: { Authorization: `Bearer ${cfg.writeKey}`, "Content-Type": "image/jpeg" }, body: blob });
  if (!res.ok) throw new Error(`image upload failed (${res.status})`);
}
var GKEY = "galleries";
function listGalleries(api3) {
  const v = api3.settings.get(GKEY, null);
  if (Array.isArray(v)) return v;
  const migrated = migrateLegacy(api3);
  api3.settings.set(GKEY, migrated);
  return migrated;
}
function saveGalleries(api3, galleries) {
  api3.settings.set(GKEY, galleries);
}
function addGallery(api3, rec) {
  const galleries = listGalleries(api3).filter((g) => g.projectId !== rec.projectId);
  galleries.unshift(rec);
  saveGalleries(api3, galleries);
}
function removeGallery(api3, projectId) {
  saveGalleries(api3, listGalleries(api3).filter((g) => g.projectId !== projectId));
  api3.settings.set(`project:${projectId}`, null);
}
async function unpublishGallery(api3, projectId) {
  const cfg = cloudConfig(api3);
  if (cfg.workerUrl && cfg.writeKey) {
    try {
      await fetch(`${cfg.workerUrl}/g/${projectId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${cfg.writeKey}` }
      });
    } catch {
    }
  }
  removeGallery(api3, projectId);
}
function migrateLegacy(api3) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  const push = (rec) => {
    if (rec && rec.projectId && !seen.has(rec.projectId)) {
      seen.add(rec.projectId);
      out.push(rec);
    }
  };
  const last = api3.settings.get("lastPublished", null);
  const projects = api3.settings.get("cloudProjects", {}) || {};
  for (const id of Object.keys(projects)) {
    const cache = api3.settings.get(`project:${id}`, null);
    push({
      projectId: id,
      kind: cache && cache.kind || (id.startsWith("pub") ? "public" : "proofing"),
      title: cache && cache.title || "Gallery",
      token: last && last.projectId === id ? last.token || "" : "",
      folder: "",
      count: cache && Array.isArray(cache.photos) ? cache.photos.length : 0,
      createdAt: "",
      appliedAt: projects[id] && projects[id].appliedAt || "",
      lastInfo: null
    });
  }
  if (last) {
    push({
      projectId: last.projectId,
      kind: last.kind || "proofing",
      title: last.title || "Gallery",
      token: last.token || "",
      folder: "",
      count: 0,
      createdAt: "",
      appliedAt: "",
      lastInfo: null
    });
  }
  return out;
}
async function prepareImages(api3, { kind, source, webEdge, quality, exportSettings, getBlob, onProgress }) {
  const items = source.map((p) => ({ photo: p, photoId: newPhotoId(), web: null, thumb: null, width: 0, height: 0 }));
  const total = source.length;
  let renderedById = null;
  if (kind === "public" && api3.export && exportSettings) {
    try {
      const rendered = await api3.export.renderPhotos(source, exportSettings, (p) => onProgress && onProgress(p.done, total, "render"));
      renderedById = new Map((rendered || []).map((r) => [r.photo.id, r]));
    } catch {
      renderedById = null;
    }
  }
  let done = 0;
  for (const it of items) {
    const p = it.photo;
    let webBlob = null, width = 0, height = 0;
    const r = renderedById && renderedById.get(p.id);
    if (r && r.blob) {
      webBlob = r.blob;
      width = r.width;
      height = r.height;
    } else {
      const src = await getBlob(p);
      if (src) {
        const web = await encodeJpeg(src, webEdge, quality);
        webBlob = web.blob;
        width = web.w;
        height = web.h;
      }
    }
    if (webBlob) {
      it.web = webBlob;
      it.width = width;
      it.height = height;
      const t = await encodeJpeg(webBlob, 512, quality);
      it.thumb = t.blob;
    }
    done++;
    onProgress && onProgress(done, total, "prep");
  }
  return items;
}
async function publishToCloud(api3, {
  kind,
  title,
  client,
  photographer,
  source,
  webEdge,
  quality,
  exportSettings,
  folder,
  getBlob,
  onProgress,
  onStatus
}) {
  const cfg = cloudConfig(api3);
  if (!cfg.workerUrl || !cfg.writeKey) throw new Error("Set your Worker URL and key in Preferences \u2192 Web Tools.");
  const projectId = newProjectId(kind);
  const token = kind === "proofing" ? newProjectToken() : "";
  if (kind === "public" && api3.export && exportSettings && onStatus) onStatus("Rendering high-resolution images\u2026");
  const items = await prepareImages(api3, {
    kind,
    source,
    webEdge,
    quality,
    exportSettings,
    getBlob,
    onProgress: (n, t, phase) => {
      if (phase === "render" && onStatus) onStatus(`Rendering ${n}/${t}\u2026`);
    }
  });
  if (onStatus) onStatus("Uploading\u2026");
  const manifestPhotos = [];
  let done = 0;
  for (const it of items) {
    if (it.web) {
      await putImage(cfg, projectId, it.photoId, it.web, false);
      if (it.thumb) await putImage(cfg, projectId, it.photoId, it.thumb, true);
    }
    manifestPhotos.push({
      photoId: it.photoId,
      catalogId: it.photo.id,
      filename: it.photo.filename,
      width: it.width,
      height: it.height,
      prePick: it.photo.flag === "pick" || it.photo.flag === "reject" ? it.photo.flag : "none"
    });
    done++;
    onProgress && onProgress(done, items.length);
  }
  const project = makeProject({
    projectId,
    kind,
    title,
    photographer,
    client: kind === "proofing" ? client : void 0,
    token,
    photos: manifestPhotos
  });
  const res = await fetch(`${cfg.workerUrl}/project/${projectId}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${cfg.writeKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ project })
  });
  if (!res.ok) throw new Error(`manifest upload failed (${res.status})`);
  api3.settings.set(`project:${projectId}`, { projectId, kind, title, photos: project.photos.map((p) => ({ photoId: p.photoId, catalogId: p.catalogId })) });
  addGallery(api3, {
    projectId,
    kind,
    title,
    token,
    folder: folder || "",
    count: manifestPhotos.length,
    createdAt: project.createdAt,
    appliedAt: "",
    lastInfo: null
  });
  return project;
}
async function fetchDecision(cfg, projectId) {
  const res = await fetch(`${cfg.workerUrl}/decision/${projectId}`, { headers: { Authorization: `Bearer ${cfg.writeKey}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`decision ${projectId}: ${res.status}`);
  return res.json();
}
async function applyDecision(api3, projectId, decision) {
  const cached = api3.settings.get(`project:${projectId}`, null);
  if (!cached) return null;
  const buckets = bucketDecision(cached, decision);
  const catalog = api3.stores.useCatalogStore.getState();
  if (buckets.pick.length) await catalog.applyFlag(buckets.pick, "pick");
  if (buckets.reject.length) await catalog.applyFlag(buckets.reject, "reject");
  if (buckets.none.length) await catalog.applyFlag(buckets.none, "none");
  return { projectId, title: cached.title, client: decision.client && decision.client.name, note: decision.note, counts: { pick: buckets.pick.length, reject: buckets.reject.length, none: buckets.none.length }, unknown: buckets.unknown.length };
}
async function sweep(api3, onApplied) {
  if (!cloudReady(api3)) return;
  const cfg = cloudConfig(api3);
  const galleries = listGalleries(api3);
  let changed = false;
  for (const g of galleries) {
    if (g.kind !== "proofing") continue;
    let decision;
    try {
      decision = await fetchDecision(cfg, g.projectId);
    } catch {
      continue;
    }
    if (!decision || validateDecision(decision).length) continue;
    if (g.appliedAt && g.appliedAt >= decision.submittedAt) continue;
    const info = await applyDecision(api3, g.projectId, decision);
    g.appliedAt = decision.submittedAt;
    if (info) g.lastInfo = { client: info.client || "", counts: info.counts, note: info.note || "", at: decision.submittedAt };
    changed = true;
    if (info && onApplied) onApplied(info);
  }
  if (changed) saveGalleries(api3, galleries);
}
function startCloudPoller(api3, onApplied) {
  const tick = () => sweep(api3, onApplied).catch(() => {
  });
  const t = setInterval(tick, 3e4);
  tick();
  return () => clearInterval(t);
}
function checkCloudNow(api3, onApplied) {
  return sweep(api3, onApplied);
}

// src/SetupWizard.jsx
var React;
var api;
function h(...a) {
  return React.createElement(...a);
}
var sx = {
  list: { display: "flex", flexDirection: "column", gap: "16px", fontSize: "11px", color: "var(--color-text-primary)" },
  row: { display: "flex", alignItems: "center", gap: "8px" },
  dot: (color) => ({ width: "7px", height: "7px", borderRadius: "50%", flex: "0 0 auto", background: color }),
  code: { fontFamily: "var(--font-mono, monospace)", background: "var(--color-surface-2)", padding: "1px 4px", borderRadius: "3px" },
  // Mirrors the core TextInput so the masked write-key field stays visually uniform.
  pw: { width: "100%", boxSizing: "border-box", borderRadius: "4px", background: "var(--color-surface-2)", padding: "5px 8px", fontSize: "11px", color: "var(--color-text-primary)", border: "1px solid var(--color-border)", outline: "none" }
};
function uiUnavailable() {
  return h("div", { style: { padding: "10px", fontSize: "11px", color: "var(--color-text-muted)" } }, "Update Safelight to use this panel.");
}
function makeSetupWizard(ctx) {
  React = ctx.React;
  api = ctx.api;
  const g = (k, f) => api.settings.get(k, f);
  return function SetupWizard() {
    if (!api.ui) return uiUnavailable();
    const { Field, TextInput, Select, NumberInput } = api.ui;
    const { useState, useEffect } = React;
    const [, force] = useState(0);
    useEffect(() => api.settings.onChange(() => force((t) => t + 1)), []);
    const conn = useConnection(React, api);
    const [workerUrl, setWorkerUrl] = useState(g("cloudWorkerUrl", ""));
    const [writeKey, setWriteKey] = useState(g("cloudWriteKey", ""));
    const [defaults, setDefaults] = useState({ source: g("source", "picks"), photographer: g("photographer", ""), webEdge: g("webEdge", 2048), quality: g("quality", 0.85) });
    const setDefault = (k, v) => {
      api.settings.set(k, v);
      setDefaults((d) => ({ ...d, [k]: v }));
    };
    const commitWorkerUrl = (raw) => {
      setWorkerUrl(raw);
      api.settings.set("cloudWorkerUrl", raw);
    };
    return h(
      "div",
      { style: sx.list },
      // Connection
      h(
        Field,
        null,
        h(
          "div",
          { style: sx.row },
          h("span", { style: sx.dot(connColor(conn.state)) }),
          h("span", null, conn.message)
        )
      ),
      h(
        Field,
        { label: "Worker URL" },
        h(TextInput, {
          placeholder: "https://swt-worker.you.workers.dev",
          value: workerUrl,
          onChange: commitWorkerUrl
        })
      ),
      h(
        Field,
        {
          label: "Write key",
          hint: h(
            React.Fragment,
            null,
            "Deploy the Worker once \u2014 run ",
            h("span", { style: sx.code }, "npm run deploy-worker"),
            " in the Web Tools folder (or follow the manual steps in the README), then paste the two values it prints here."
          )
        },
        h("input", {
          style: sx.pw,
          type: "password",
          placeholder: "your WRITE_KEY",
          value: writeKey,
          onChange: (e) => {
            setWriteKey(e.target.value);
            api.settings.set("cloudWriteKey", e.target.value.trim());
          }
        })
      ),
      // Gallery defaults
      h(
        Field,
        { label: "Which photos to publish" },
        h(Select, {
          value: defaults.source,
          onChange: (v) => setDefault("source", v),
          options: [
            { value: "picks", label: "My picks (flagged)" },
            { value: "selected", label: "Selected photos" },
            { value: "all", label: "All (except rejects)" }
          ]
        })
      ),
      h(
        Field,
        { label: "Your name / studio" },
        h(TextInput, { value: defaults.photographer, placeholder: "Shown on public galleries", onChange: (v) => setDefault("photographer", v) })
      ),
      h(
        Field,
        { label: "Image size (px) / quality" },
        h(
          "div",
          { style: sx.row },
          h(NumberInput, { min: 800, max: 4096, step: 64, value: defaults.webEdge, width: 90, onChange: (n) => setDefault("webEdge", n) }),
          h(NumberInput, { min: 0.5, max: 0.97, step: 0.01, value: defaults.quality, width: 80, onChange: (n) => setDefault("quality", n) })
        )
      )
    );
  };
}

// src/index.jsx
var api2 = null;
var React2 = null;
var store = null;
var stopCloud = null;
function h2(...args) {
  return React2.createElement(...args);
}
var cat = () => api2.stores.useCatalogStore;
var uiStore = () => api2.stores.useUIStore;
function settings() {
  const g = (k, f) => api2.settings.get(k, f);
  return {
    photographer: g("photographer", ""),
    webEdge: Number(g("webEdge", 2048)) || 2048,
    quality: Math.min(0.97, Math.max(0.5, Number(g("quality", 0.85)) || 0.85)),
    source: g("source", "picks")
    // picks | selected | all
  };
}
async function previewBlob(photo) {
  if (photo.thumbnailBlob) return photo.thumbnailBlob;
  if (photo.thumbnailUrl) {
    try {
      return await (await fetch(photo.thumbnailUrl)).blob();
    } catch {
      return null;
    }
  }
  return null;
}
function activeFolder() {
  try {
    return uiStore().getState().activeFolder;
  } catch {
    return null;
  }
}
function folderLabel(f) {
  return f == null ? "All Photos" : f === "" ? "Project root" : f;
}
function showSubfolders() {
  try {
    return !!api2.stores.useSettings.getState().showSubfolderPhotos;
  } catch {
    return false;
  }
}
function inActiveFolder(p, f) {
  if (f == null) return true;
  if (p.folder === f) return true;
  if (!showSubfolders()) return false;
  return f === "" || p.folder && p.folder.startsWith(f + "/");
}
function sourcePhotos() {
  const c = cat().getState();
  const all = c.photos;
  const s = settings();
  if (s.source === "selected") return all.filter((p) => c.selectedIds.has(p.id));
  const f = activeFolder();
  const base = s.source === "all" ? all.filter((p) => p.flag !== "reject") : all.filter((p) => p.flag === "pick");
  return base.filter((p) => inActiveFolder(p, f));
}
function buildExportSettings(s) {
  if (!api2.export || typeof api2.export.getDefaultSettings !== "function") return null;
  let def = null;
  try {
    def = api2.export.getDefaultSettings();
  } catch {
    return null;
  }
  if (!def) return null;
  const longEdge = def.longEdge != null ? def.longEdge : s.webEdge;
  return { ...def, format: "image/jpeg", longEdge };
}
function ensureCloudPoller() {
  if (stopCloud) return;
  stopCloud = startCloudPoller(api2, (info) => store.getState()._onApplied(info));
}
function makeStore() {
  return api2.stores.create((set, get) => ({
    busy: false,
    progress: null,
    status: "",
    lastApplied: null,
    // info from the poller (most recent applied decision)
    setStatusMsg(status) {
      set({ status });
    },
    async publish(meta) {
      if (get().busy) return;
      const kind = meta.kind === "public" ? "public" : "proofing";
      const photos = sourcePhotos();
      if (!photos.length) {
        set({ status: "No photos match the selected source." });
        return;
      }
      if (!cloudReady(api2)) {
        set({ status: "Add your Worker URL and key in Preferences \u2192 Web Tools." });
        return;
      }
      set({ busy: true, status: "Preparing images\u2026", progress: null });
      try {
        const s = settings();
        const exportSettings = kind === "public" ? buildExportSettings(s) : null;
        const folder = folderLabel(activeFolder());
        const project = await publishToCloud(api2, {
          kind,
          title: meta.title,
          client: meta.client,
          photographer: s.photographer,
          source: photos,
          webEdge: s.webEdge,
          quality: s.quality,
          exportSettings,
          folder,
          getBlob: previewBlob,
          onProgress: (done, total) => set({ progress: { done, total } }),
          onStatus: (msg) => set({ status: msg })
        });
        ensureCloudPoller();
        set({ status: `Published "${project.title}".` });
      } catch (e) {
        set({ status: "Publish failed: " + (e && e.message ? e.message : String(e)) });
      } finally {
        set({ busy: false, progress: null });
      }
    },
    async unpublish(projectId) {
      try {
        await unpublishGallery(api2, projectId);
        set({ status: "Gallery removed." });
      } catch (e) {
        set({ status: "Couldn't remove the gallery: " + (e && e.message ? e.message : String(e)) });
      }
    },
    async checkNow() {
      await checkCloudNow(api2, (info) => get()._onApplied(info));
      if (!get().lastApplied) set({ status: "No new client decisions yet." });
    },
    _onApplied(info) {
      const c = info.counts;
      set({
        lastApplied: info,
        status: `Applied ${info.client || "client"}'s decision to "${info.title}": ${c.pick} pick, ${c.reject} reject, ${c.none} unset${info.unknown ? `, ${info.unknown} unmatched` : ""}.`
      });
    }
  }));
}
var S = {
  wrap: { padding: "10px", display: "flex", flexDirection: "column", gap: "10px", fontSize: "11px", color: "var(--color-text-primary)" },
  sec: { display: "flex", flexDirection: "column", gap: "6px" },
  secHead: { display: "flex", alignItems: "center", fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--color-text-secondary)", borderBottom: "1px solid var(--color-border)", paddingBottom: "3px" },
  row: { display: "flex", gap: "6px", alignItems: "center" },
  status: { color: "var(--color-text-secondary)", minHeight: "26px", lineHeight: 1.4 },
  dot: (color) => ({ width: "7px", height: "7px", borderRadius: "50%", background: color, flex: "0 0 auto" }),
  share: { display: "flex", flexDirection: "column", gap: "6px", padding: "8px", border: "1px solid var(--color-accent)", borderRadius: "4px", background: "var(--color-surface-2)" },
  shareUrl: { fontSize: "11px", color: "var(--color-accent)", wordBreak: "break-all", userSelect: "all" },
  folderHead: { fontSize: "10px", color: "var(--color-text-muted)", display: "flex", alignItems: "center", gap: "4px", marginTop: "2px" }
};
function uiUnavailable2() {
  return h2("div", { style: { padding: "10px", fontSize: "11px", color: "var(--color-text-muted)" } }, "Update Safelight to use this panel.");
}
function WebToolsPanel() {
  if (!api2.ui) return uiUnavailable2();
  const { Button, TextInput, SegmentedControl, ProgressBar } = api2.ui;
  const Badge = api2.ui.Badge || (({ children }) => h2("span", { style: { fontSize: "9px", color: "var(--color-text-secondary)" } }, children));
  const { useState, useEffect } = React2;
  const selectedIds = cat()((s2) => s2.selectedIds);
  cat()((s2) => s2.photos);
  const curFolder = uiStore()((s2) => s2.activeFolder);
  const busy = store((s2) => s2.busy);
  const progress = store((s2) => s2.progress);
  const status = store((s2) => s2.status);
  const lastApplied = store((s2) => s2.lastApplied);
  const st = store.getState();
  const [, setTick] = useState(0);
  useEffect(() => api2.settings.onChange(() => setTick((t) => t + 1)), []);
  const conn = useConnection(React2, api2);
  const s = settings();
  const cloudOk = cloudReady(api2);
  const cfg = cloudConfig(api2);
  const copy = (text) => {
    try {
      navigator.clipboard.writeText(text);
      st.setStatusMsg("Link copied.");
    } catch {
    }
  };
  const openUrl = (u) => {
    try {
      if (/^https?:\/\//i.test(u)) window.open(u, "_blank", "noopener");
    } catch {
    }
  };
  const openSetup = () => {
    try {
      api2.preferences && api2.preferences.open && api2.preferences.open("web-tools");
    } catch {
    }
  };
  const [mode, setMode] = useState("proofing");
  const [title, setTitle] = useState("");
  const [clientName, setClientName] = useState("");
  const [clientEmail, setClientEmail] = useState("");
  const count = sourcePhotos().length;
  const sourceLabel = s.source === "selected" ? "selected photos" : s.source === "all" ? "all (non-rejected)" : "your picks";
  const galleries = listGalleries(api2);
  const groups = [];
  const byFolder = /* @__PURE__ */ new Map();
  for (const g of galleries) {
    const key = g.folder || "All Photos";
    if (!byFolder.has(key)) {
      byFolder.set(key, []);
      groups.push(key);
    }
    byFolder.get(key).push(g);
  }
  const renderGallery = (g) => {
    const url = cloudShareLink(cfg, g.projectId, g.token);
    const decision = g.lastInfo ? `${g.lastInfo.client || "Client"}: ${g.lastInfo.counts.pick} pick \xB7 ${g.lastInfo.counts.reject} reject${g.lastInfo.note ? ` \u2014 \u201C${g.lastInfo.note}\u201D` : ""}` : "Awaiting client decision\u2026";
    return h2(
      "div",
      { key: g.projectId, style: S.share },
      h2(
        "div",
        { style: S.row },
        h2("span", { style: { flex: 1, fontWeight: 600, wordBreak: "break-word" } }, g.title),
        h2(Badge, null, g.kind === "public" ? "Public" : "Proofing")
      ),
      h2("div", { style: { fontSize: "10px", color: "var(--color-text-secondary)" } }, `${g.count} photo${g.count === 1 ? "" : "s"}`),
      url ? h2(
        React2.Fragment,
        null,
        h2("div", { style: S.shareUrl, title: url }, url),
        h2(
          "div",
          { style: S.row },
          h2(Button, { variant: "primary", size: "sm", onClick: () => openUrl(url) }, "Open"),
          h2(Button, { size: "sm", onClick: () => copy(url) }, "Copy"),
          h2("span", { style: { flex: 1 } }),
          h2(Button, { variant: "ghost", size: "sm", onClick: () => st.unpublish(g.projectId) }, "Remove")
        )
      ) : h2("div", { style: { fontSize: "10px", color: "var(--color-warning, #d29922)" } }, "Add your Worker URL + key to get the link."),
      g.kind === "proofing" ? h2("div", { style: { fontSize: "10px", color: "var(--color-text-secondary)" } }, decision) : null
    );
  };
  return /* @__PURE__ */ h2("div", { style: S.wrap }, /* @__PURE__ */ h2("div", { style: S.sec }, /* @__PURE__ */ h2("div", { style: S.secHead }, /* @__PURE__ */ h2("span", { style: { flex: 1 } }, "Status"), /* @__PURE__ */ h2(Button, { variant: "ghost", size: "sm", onClick: openSetup }, "Set up")), /* @__PURE__ */ h2("div", { style: S.row }, /* @__PURE__ */ h2("span", { style: S.dot(connColor(conn.state)) }), /* @__PURE__ */ h2("span", { style: { flex: 1, color: "var(--color-text-secondary)" } }, conn.ok ? "Ready to publish" : conn.message)), conn.state === "unconfigured" && /* @__PURE__ */ h2("div", { style: { color: "var(--color-warning, #d29922)", fontSize: "10px" } }, "Deploy the Worker once (", /* @__PURE__ */ h2("code", null, "npm run deploy-worker"), "), then paste its URL + key under ", /* @__PURE__ */ h2("b", null, "Set up"), "."), !conn.ok && conn.state !== "unconfigured" && conn.state !== "checking" && /* @__PURE__ */ h2("div", { style: { color: "#f0506e", fontSize: "10px" } }, conn.message, " \u2014 check the URL + key under ", /* @__PURE__ */ h2("b", null, "Set up"), ".")), /* @__PURE__ */ h2("div", { style: S.sec }, /* @__PURE__ */ h2("div", { style: S.secHead }, "New gallery"), /* @__PURE__ */ h2(
    SegmentedControl,
    {
      value: mode,
      onChange: setMode,
      size: "sm",
      options: [
        { value: "proofing", label: "Proofing", title: "Client picks/rejects come back to you" },
        { value: "public", label: "Public", title: "A public portfolio gallery (no client review)" }
      ]
    }
  ), /* @__PURE__ */ h2(TextInput, { placeholder: "Gallery title", value: title, onChange: setTitle }), mode === "proofing" && /* @__PURE__ */ h2(React2.Fragment, null, /* @__PURE__ */ h2(TextInput, { placeholder: "Client name", value: clientName, onChange: setClientName }), /* @__PURE__ */ h2(TextInput, { placeholder: "Client email (optional)", value: clientEmail, onChange: setClientEmail })), /* @__PURE__ */ h2("div", { style: { color: "var(--color-text-secondary)" } }, "Source: ", /* @__PURE__ */ h2("b", null, sourceLabel), s.source !== "selected" && /* @__PURE__ */ h2(React2.Fragment, null, " in ", /* @__PURE__ */ h2("b", null, folderLabel(curFolder))), " ", "\u2014 ", count, " photo", count === 1 ? "" : "s", s.source === "selected" ? ` (${selectedIds.size} selected)` : ""), mode === "public" && /* @__PURE__ */ h2("div", { style: { fontSize: "10px", color: "var(--color-text-muted)" } }, "Rendered at your export resolution/quality (Preferences \u25B8 Export)."), /* @__PURE__ */ h2(
    Button,
    {
      variant: "primary",
      full: true,
      disabled: busy || !cloudOk || !count,
      onClick: () => st.publish({ kind: mode, title: title || "Untitled gallery", client: { name: clientName, email: clientEmail } })
    },
    busy ? progress ? `Uploading ${progress.done}/${progress.total}\u2026` : "Working\u2026" : `Publish ${mode === "public" ? "portfolio" : "proofing"} \xB7 ${count} photo${count === 1 ? "" : "s"}`
  ), busy && progress && /* @__PURE__ */ h2(ProgressBar, { value: progress.total ? progress.done / progress.total : 0 })), galleries.length > 0 && /* @__PURE__ */ h2("div", { style: S.sec }, /* @__PURE__ */ h2("div", { style: S.secHead }, "Your galleries"), groups.map((folder) => /* @__PURE__ */ h2(React2.Fragment, { key: folder }, /* @__PURE__ */ h2("div", { style: S.folderHead }, folder), byFolder.get(folder).map(renderGallery)))), /* @__PURE__ */ h2("div", { style: S.sec }, /* @__PURE__ */ h2("div", { style: S.secHead }, "Client decisions"), /* @__PURE__ */ h2("div", { style: S.row }, /* @__PURE__ */ h2(Button, { size: "sm", disabled: !cloudOk, onClick: () => st.checkNow() }, "Check now"), /* @__PURE__ */ h2("span", { style: { flex: 1, color: "var(--color-text-secondary)", fontSize: "10px" } }, "Auto-checks every gallery for replies")), lastApplied && /* @__PURE__ */ h2("div", { style: { color: "var(--color-text-secondary)" } }, "Last: ", lastApplied.client || "client", " \u2192 \u201C", lastApplied.title, "\u201D", lastApplied.note ? /* @__PURE__ */ h2("div", { style: { fontStyle: "italic", marginTop: "3px" } }, "\u201C", lastApplied.note, "\u201D") : null)), /* @__PURE__ */ h2("div", { style: S.status }, status));
}
function withBoundary(Comp, label) {
  return class extends React2.Component {
    constructor(p) {
      super(p);
      this.state = { err: null };
    }
    static getDerivedStateFromError(err) {
      return { err };
    }
    render() {
      if (!this.state.err) return React2.createElement(Comp, this.props);
      return React2.createElement(
        "div",
        { style: { padding: "10px", fontSize: "11px", color: "var(--color-text-primary)" } },
        React2.createElement("div", { style: { color: "#f0506e", marginBottom: "6px" } }, `Web Tools ${label} error \u2014 please report this:`),
        React2.createElement(
          "pre",
          { style: { whiteSpace: "pre-wrap", fontSize: "10px", color: "var(--color-text-secondary)" } },
          String(this.state.err && this.state.err.message || this.state.err)
        )
      );
    }
  };
}
function activate(_api) {
  api2 = _api;
  React2 = api2.react;
  store = makeStore();
  api2.registerPanel({
    id: "web-tools.panel",
    title: "Web Tools",
    component: withBoundary(WebToolsPanel, "panel"),
    defaultDock: { module: "library", direction: "right", order: 3, width: 300, height: 380 }
  });
  api2.registerSettings({
    title: "Web Tools",
    fields: [],
    keywords: ["gallery", "proofing", "publish", "client", "cloudflare", "worker"],
    component: withBoundary(makeSetupWizard({ React: React2, store, api: api2 }), "settings")
  });
  ensureCloudPoller();
}
function deactivate() {
  if (stopCloud) {
    stopCloud();
    stopCloud = null;
  }
  api2 = null;
  React2 = null;
  store = null;
}
export {
  activate,
  deactivate
};
