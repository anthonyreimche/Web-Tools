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
function cloudConfig(api2) {
  let workerUrl = (api2.settings.get("cloudWorkerUrl", "") || "").trim().replace(/\/+$/, "");
  if (workerUrl && !/^https?:\/\//i.test(workerUrl)) workerUrl = "https://" + workerUrl;
  return {
    workerUrl,
    writeKey: api2.settings.get("cloudWriteKey", "")
  };
}
function cloudReady(api2) {
  const c = cloudConfig(api2);
  return !!(c.workerUrl && c.writeKey);
}
async function checkConnection(api2, { signal } = {}) {
  const c = cloudConfig(api2);
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
function useConnection(React3, api2) {
  const { useState, useEffect } = React3;
  const [status, setStatus] = useState({ state: "checking", ok: false, message: "Checking\u2026" });
  useEffect(() => {
    let active = true, runId = 0, controller = null, timer = null;
    const run = () => {
      const myId = ++runId;
      if (controller) controller.abort();
      controller = typeof AbortController !== "undefined" ? new AbortController() : null;
      checkConnection(api2, { signal: controller ? controller.signal : void 0 }).then((s) => {
        if (active && myId === runId) setStatus(s);
      }).catch(() => {
      });
    };
    run();
    const off = api2.settings.onChange(() => {
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
async function publishToCloud(api2, { kind, title, client, photographer, source, webEdge, quality, getBlob, onProgress }) {
  const cfg = cloudConfig(api2);
  if (!cfg.workerUrl || !cfg.writeKey) throw new Error("Set your Worker URL and key in Preferences \u2192 Web Tools.");
  const projectId = newProjectId(kind);
  const token = kind === "proofing" ? newProjectToken() : "";
  const manifestPhotos = [];
  let done = 0;
  for (const p of source) {
    const photoId = newPhotoId();
    const blob = await getBlob(p);
    let w = 0, h3 = 0;
    if (blob) {
      const web = await encodeJpeg(blob, webEdge, quality);
      const thumb = await encodeJpeg(blob, 512, quality);
      await putImage(cfg, projectId, photoId, web.blob, false);
      await putImage(cfg, projectId, photoId, thumb.blob, true);
      w = web.w;
      h3 = web.h;
    }
    manifestPhotos.push({ photoId, catalogId: p.id, filename: p.filename, width: w, height: h3, prePick: p.flag === "pick" || p.flag === "reject" ? p.flag : "none" });
    done++;
    onProgress && onProgress(done, source.length);
  }
  const project = makeProject({ projectId, kind, title, photographer, client: kind === "proofing" ? client : void 0, token, photos: manifestPhotos });
  const res = await fetch(`${cfg.workerUrl}/project/${projectId}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${cfg.writeKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ project })
  });
  if (!res.ok) throw new Error(`manifest upload failed (${res.status})`);
  api2.settings.set(`project:${projectId}`, { projectId, kind, title, photos: project.photos.map((p) => ({ photoId: p.photoId, catalogId: p.catalogId })) });
  const active = api2.settings.get("cloudProjects", {}) || {};
  active[projectId] = { appliedAt: "" };
  api2.settings.set("cloudProjects", active);
  return project;
}
async function fetchDecision(cfg, projectId) {
  const res = await fetch(`${cfg.workerUrl}/decision/${projectId}`, { headers: { Authorization: `Bearer ${cfg.writeKey}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`decision ${projectId}: ${res.status}`);
  return res.json();
}
async function applyDecision(api2, projectId, decision) {
  const cached = api2.settings.get(`project:${projectId}`, null);
  if (!cached) return null;
  const buckets = bucketDecision(cached, decision);
  const catalog = api2.stores.useCatalogStore.getState();
  if (buckets.pick.length) await catalog.applyFlag(buckets.pick, "pick");
  if (buckets.reject.length) await catalog.applyFlag(buckets.reject, "reject");
  if (buckets.none.length) await catalog.applyFlag(buckets.none, "none");
  return { projectId, title: cached.title, client: decision.client && decision.client.name, note: decision.note, counts: { pick: buckets.pick.length, reject: buckets.reject.length, none: buckets.none.length }, unknown: buckets.unknown.length };
}
async function sweep(api2, onApplied) {
  if (!cloudReady(api2)) return;
  const cfg = cloudConfig(api2);
  const active = api2.settings.get("cloudProjects", {}) || {};
  for (const id of Object.keys(active)) {
    let decision;
    try {
      decision = await fetchDecision(cfg, id);
    } catch {
      continue;
    }
    if (!decision || validateDecision(decision).length) continue;
    if (active[id].appliedAt && active[id].appliedAt >= decision.submittedAt) continue;
    const info = await applyDecision(api2, id, decision);
    active[id] = { appliedAt: decision.submittedAt };
    api2.settings.set("cloudProjects", active);
    if (info && onApplied) onApplied(info);
  }
}
function startCloudPoller(api2, onApplied) {
  const tick = () => sweep(api2, onApplied).catch(() => {
  });
  const t = setInterval(tick, 3e4);
  tick();
  return () => clearInterval(t);
}
function checkCloudNow(api2, onApplied) {
  return sweep(api2, onApplied);
}

// src/SetupWizard.jsx
var React;
function h(...a) {
  return React.createElement(...a);
}
var sx = {
  list: { display: "flex", flexDirection: "column", gap: "16px", fontSize: "11px", color: "var(--color-text-primary)" },
  field: { display: "flex", flexDirection: "column", gap: "6px" },
  label: { fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--color-text-secondary)" },
  hint: { fontSize: "10px", lineHeight: 1.5, color: "var(--color-text-secondary)" },
  input: { width: "100%", boxSizing: "border-box", borderRadius: "4px", background: "var(--color-surface-2)", padding: "5px 8px", fontSize: "11px", color: "var(--color-text-primary)", border: "none", outline: "none" },
  row: { display: "flex", alignItems: "center", gap: "8px" },
  dot: (color) => ({ width: "7px", height: "7px", borderRadius: "50%", flex: "0 0 auto", background: color }),
  code: { fontFamily: "var(--font-mono, monospace)", background: "var(--color-surface-2)", padding: "1px 4px", borderRadius: "3px" }
};
function Field({ label, hint, children }) {
  return h("div", { style: sx.field }, label ? h("div", { style: sx.label }, label) : null, children, hint ? h("div", { style: sx.hint }, hint) : null);
}
function makeSetupWizard(ctx) {
  React = ctx.React;
  const { api: api2 } = ctx;
  const g = (k, f) => api2.settings.get(k, f);
  return function SetupWizard() {
    const { useState, useEffect } = React;
    const [, force] = useState(0);
    useEffect(() => api2.settings.onChange(() => force((t) => t + 1)), []);
    const conn = useConnection(React, api2);
    const [workerUrl, setWorkerUrl] = useState(g("cloudWorkerUrl", ""));
    const [writeKey, setWriteKey] = useState(g("cloudWriteKey", ""));
    const [defaults, setDefaults] = useState({ source: g("source", "picks"), photographer: g("photographer", ""), webEdge: g("webEdge", 2048), quality: g("quality", 0.85) });
    const setDefault = (k, v) => {
      api2.settings.set(k, v);
      setDefaults((d) => ({ ...d, [k]: v }));
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
        h("input", {
          style: sx.input,
          placeholder: "https://swt-worker.you.workers.dev",
          value: workerUrl,
          onChange: (e) => setWorkerUrl(e.target.value),
          onBlur: () => {
            let v = workerUrl.trim().replace(/\/+$/, "");
            if (v && !/^https?:\/\//i.test(v)) v = "https://" + v;
            setWorkerUrl(v);
            api2.settings.set("cloudWorkerUrl", v);
          }
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
          style: sx.input,
          type: "password",
          placeholder: "your WRITE_KEY",
          value: writeKey,
          onChange: (e) => setWriteKey(e.target.value),
          onBlur: () => api2.settings.set("cloudWriteKey", writeKey.trim())
        })
      ),
      // Gallery defaults
      h(
        Field,
        { label: "Which photos to publish" },
        h(
          "select",
          { style: sx.input, value: defaults.source, onChange: (e) => setDefault("source", e.target.value) },
          h("option", { value: "picks" }, "My picks (flagged)"),
          h("option", { value: "selected" }, "Selected photos"),
          h("option", { value: "all" }, "All (except rejects)")
        )
      ),
      h(
        Field,
        { label: "Your name / studio" },
        h("input", { style: sx.input, value: defaults.photographer, placeholder: "Shown on public galleries", onChange: (e) => setDefault("photographer", e.target.value) })
      ),
      h(
        Field,
        { label: "Image size (px) / quality" },
        h(
          "div",
          { style: sx.row },
          h("input", { style: { ...sx.input, width: "90px" }, type: "number", min: 800, max: 4096, step: 64, value: defaults.webEdge, onChange: (e) => setDefault("webEdge", Number(e.target.value)) }),
          h("input", { style: { ...sx.input, width: "80px" }, type: "number", min: 0.5, max: 0.97, step: 0.01, value: defaults.quality, onChange: (e) => setDefault("quality", Number(e.target.value)) })
        )
      )
    );
  };
}

// src/index.jsx
var api = null;
var React2 = null;
var store = null;
var stopCloud = null;
function h2(...args) {
  return React2.createElement(...args);
}
var cat = () => api.stores.useCatalogStore;
function settings() {
  const g = (k, f) => api.settings.get(k, f);
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
function sourcePhotos() {
  const c = cat().getState();
  const all = c.photos;
  const s = settings();
  if (s.source === "selected") return all.filter((p) => c.selectedIds.has(p.id));
  if (s.source === "all") return all.filter((p) => p.flag !== "reject");
  return all.filter((p) => p.flag === "pick");
}
function ensureCloudPoller() {
  if (stopCloud) return;
  stopCloud = startCloudPoller(api, (info) => store.getState()._onApplied(info));
}
function makeStore() {
  return api.stores.create((set, get) => ({
    busy: false,
    progress: null,
    status: "",
    lastApplied: null,
    // info from the poller
    lastPublished: api.settings.get("lastPublished", null),
    // { projectId, token, title, kind }
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
      if (!cloudReady(api)) {
        set({ status: "Add your Worker URL and key in Preferences \u2192 Web Tools." });
        return;
      }
      set({ busy: true, status: "Preparing images\u2026", progress: { done: 0, total: photos.length } });
      try {
        const s = settings();
        const project = await publishToCloud(api, {
          kind,
          title: meta.title,
          client: meta.client,
          photographer: s.photographer,
          source: photos,
          webEdge: s.webEdge,
          quality: s.quality,
          getBlob: previewBlob,
          onProgress: (done, total) => set({ progress: { done, total } })
        });
        const published = { projectId: project.projectId, token: project.token, title: project.title, kind };
        api.settings.set("lastPublished", published);
        ensureCloudPoller();
        set({ lastPublished: published, status: `Published "${project.title}".` });
      } catch (e) {
        set({ status: "Publish failed: " + (e && e.message ? e.message : String(e)) });
      } finally {
        set({ busy: false, progress: null });
      }
    },
    async checkNow() {
      await checkCloudNow(api, (info) => get()._onApplied(info));
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
  field: { background: "var(--color-surface-2)", border: "1px solid var(--color-border)", borderRadius: "3px", color: "var(--color-text-primary)", font: "inherit", padding: "4px 5px", width: "100%", boxSizing: "border-box" },
  row: { display: "flex", gap: "6px", alignItems: "center" },
  btn: { padding: "6px 8px", background: "var(--color-surface-3)", border: "1px solid var(--color-border)", borderRadius: "3px", color: "var(--color-text-primary)", cursor: "pointer", font: "inherit" },
  status: { color: "var(--color-text-secondary)", minHeight: "26px", lineHeight: 1.4 },
  bar: { height: "3px", background: "var(--color-surface-3)", borderRadius: "2px", overflow: "hidden" },
  dot: (color) => ({ width: "7px", height: "7px", borderRadius: "50%", background: color, flex: "0 0 auto" }),
  seg: { display: "flex", border: "1px solid var(--color-border)", borderRadius: "3px", overflow: "hidden" },
  segBtn: { flex: 1, padding: "5px 6px", background: "var(--color-surface-2)", border: "none", borderRight: "1px solid var(--color-border)", color: "var(--color-text-secondary)", cursor: "pointer", font: "inherit" },
  segOn: { background: "var(--color-accent)", color: "#fff" },
  share: { display: "flex", flexDirection: "column", gap: "6px", padding: "8px", border: "1px solid var(--color-accent)", borderRadius: "4px", background: "var(--color-surface-2)" },
  shareUrl: { fontSize: "11px", color: "var(--color-accent)", wordBreak: "break-all", userSelect: "all" }
};
var btnPrimary = { ...S.btn, background: "var(--color-accent)", border: "1px solid var(--color-accent)", color: "#fff" };
var dis = (s) => ({ ...s, opacity: 0.45, cursor: "default" });
function WebToolsPanel() {
  const { useState, useEffect } = React2;
  const selectedIds = cat()((s2) => s2.selectedIds);
  cat()((s2) => s2.photos);
  const busy = store((s2) => s2.busy);
  const progress = store((s2) => s2.progress);
  const status = store((s2) => s2.status);
  const lastApplied = store((s2) => s2.lastApplied);
  const lastPublished = store((s2) => s2.lastPublished);
  const st = store.getState();
  const [, setTick] = useState(0);
  useEffect(() => api.settings.onChange(() => setTick((t) => t + 1)), []);
  const conn = useConnection(React2, api);
  const s = settings();
  const cloudOk = cloudReady(api);
  const shareUrl = lastPublished ? cloudShareLink(cloudConfig(api), lastPublished.projectId, lastPublished.token) : "";
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
      api.preferences && api.preferences.open && api.preferences.open("web-tools");
    } catch {
    }
  };
  const [mode, setMode] = useState("proofing");
  const [title, setTitle] = useState("");
  const [clientName, setClientName] = useState("");
  const [clientEmail, setClientEmail] = useState("");
  const count = sourcePhotos().length;
  const pct = progress && progress.total ? Math.round(100 * progress.done / progress.total) : 0;
  return /* @__PURE__ */ h2("div", { style: S.wrap }, /* @__PURE__ */ h2("div", { style: S.sec }, /* @__PURE__ */ h2("div", { style: S.secHead }, /* @__PURE__ */ h2("span", { style: { flex: 1 } }, "Status"), /* @__PURE__ */ h2("button", { style: { ...S.btn, padding: "2px 6px", fontSize: "10px" }, onClick: openSetup }, "Set up")), /* @__PURE__ */ h2("div", { style: S.row }, /* @__PURE__ */ h2("span", { style: S.dot(connColor(conn.state)) }), /* @__PURE__ */ h2("span", { style: { flex: 1, color: "var(--color-text-secondary)" } }, conn.ok ? "Ready to publish" : conn.message)), conn.state === "unconfigured" && /* @__PURE__ */ h2("div", { style: { color: "var(--color-warning, #d29922)", fontSize: "10px" } }, "Deploy the Worker once (", /* @__PURE__ */ h2("code", null, "npm run deploy-worker"), "), then paste its URL + key under ", /* @__PURE__ */ h2("b", null, "Set up"), "."), !conn.ok && conn.state !== "unconfigured" && conn.state !== "checking" && /* @__PURE__ */ h2("div", { style: { color: "#f0506e", fontSize: "10px" } }, conn.message, " \u2014 check the URL + key under ", /* @__PURE__ */ h2("b", null, "Set up"), ".")), /* @__PURE__ */ h2("div", { style: S.sec }, /* @__PURE__ */ h2("div", { style: S.secHead }, "New gallery"), /* @__PURE__ */ h2("div", { style: S.seg }, [["proofing", "Proofing"], ["public", "Public"]].map(([m, label], i) => /* @__PURE__ */ h2(
    "button",
    {
      key: m,
      style: { ...S.segBtn, ...i === 0 ? {} : { borderRight: "none" }, ...mode === m ? S.segOn : null },
      onClick: () => setMode(m),
      title: m === "proofing" ? "Client picks/rejects come back to you" : "A public portfolio gallery (no client review)"
    },
    label
  ))), /* @__PURE__ */ h2("input", { style: S.field, placeholder: "Gallery title", value: title, onChange: (e) => setTitle(e.target.value) }), mode === "proofing" && /* @__PURE__ */ h2(React2.Fragment, null, /* @__PURE__ */ h2("input", { style: S.field, placeholder: "Client name", value: clientName, onChange: (e) => setClientName(e.target.value) }), /* @__PURE__ */ h2("input", { style: S.field, placeholder: "Client email (optional)", value: clientEmail, onChange: (e) => setClientEmail(e.target.value) })), /* @__PURE__ */ h2("div", { style: { color: "var(--color-text-secondary)" } }, "Source: ", /* @__PURE__ */ h2("b", null, s.source === "selected" ? "selected photos" : s.source === "all" ? "all (non-rejected)" : "your picks"), " \u2014 ", count, " photo", count === 1 ? "" : "s", s.source === "selected" ? ` (${selectedIds.size} selected)` : ""), /* @__PURE__ */ h2(
    "button",
    {
      style: busy || !cloudOk || !count ? dis(btnPrimary) : btnPrimary,
      disabled: busy || !cloudOk || !count,
      onClick: () => st.publish({ kind: mode, title: title || "Untitled gallery", client: { name: clientName, email: clientEmail } })
    },
    busy && progress ? `Uploading ${progress.done}/${progress.total}\u2026` : `Publish ${mode === "public" ? "portfolio" : "proofing"} \xB7 ${count} photo${count === 1 ? "" : "s"}`
  ), busy && progress && /* @__PURE__ */ h2("div", { style: S.bar }, /* @__PURE__ */ h2("div", { style: { height: "100%", width: pct + "%", background: "var(--color-accent)" } })), lastPublished && /* @__PURE__ */ h2("div", { style: S.share }, /* @__PURE__ */ h2("div", { style: { fontSize: "10px", color: "var(--color-text-secondary)" } }, lastPublished.kind === "public" ? "Public gallery link" : "Send this link to your client", ":"), shareUrl ? /* @__PURE__ */ h2(React2.Fragment, null, /* @__PURE__ */ h2("div", { style: S.shareUrl, title: shareUrl }, shareUrl), /* @__PURE__ */ h2("div", { style: S.row }, /* @__PURE__ */ h2("button", { style: btnPrimary, onClick: () => openUrl(shareUrl) }, "Open"), /* @__PURE__ */ h2("button", { style: S.btn, onClick: () => copy(shareUrl) }, "Copy link"))) : /* @__PURE__ */ h2("div", { style: { fontSize: "11px", color: "var(--color-warning, #d29922)" } }, "Add your Worker URL + key in Preferences to get the link."))), /* @__PURE__ */ h2("div", { style: S.sec }, /* @__PURE__ */ h2("div", { style: S.secHead }, "Client decisions"), /* @__PURE__ */ h2("div", { style: S.row }, /* @__PURE__ */ h2("button", { style: cloudOk ? S.btn : dis(S.btn), disabled: !cloudOk, onClick: () => st.checkNow() }, "Check now"), /* @__PURE__ */ h2("span", { style: { flex: 1, color: "var(--color-text-secondary)", fontSize: "10px" } }, "Auto-checks for replies")), lastApplied && /* @__PURE__ */ h2("div", { style: { color: "var(--color-text-secondary)" } }, "Last: ", lastApplied.client || "client", " \u2192 \u201C", lastApplied.title, "\u201D", lastApplied.note ? /* @__PURE__ */ h2("div", { style: { fontStyle: "italic", marginTop: "3px" } }, "\u201C", lastApplied.note, "\u201D") : null)), /* @__PURE__ */ h2("div", { style: S.status }, status));
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
  api = _api;
  React2 = api.react;
  store = makeStore();
  api.registerPanel({
    id: "web-tools.panel",
    title: "Web Tools",
    component: withBoundary(WebToolsPanel, "panel"),
    defaultDock: { module: "library", direction: "right", order: 3, width: 300, height: 380 }
  });
  api.registerSettings({
    title: "Web Tools",
    fields: [],
    keywords: ["gallery", "proofing", "publish", "client", "cloudflare", "worker"],
    component: withBoundary(makeSetupWizard({ React: React2, store, api }), "settings")
  });
  ensureCloudPoller();
}
function deactivate() {
  if (stopCloud) {
    stopCloud();
    stopCloud = null;
  }
  api = null;
  React2 = null;
  store = null;
}
export {
  activate,
  deactivate
};
