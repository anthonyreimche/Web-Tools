// Safelight Web Tools — in-app extension (Cloudflare-only).
//
// Publishes proofing or public galleries from the Library straight to your
// Cloudflare Worker, and polls the Worker for the client's picks/rejects,
// applying them to the catalog. The app's CSP allows the Worker origin, so the
// extension talks to it directly — no local helper, folder, or per-gallery setup.
//
// Galleries are folder-scoped and several can be live at once: publish one
// folder's picks, switch folders and keep editing, and each gallery's decisions
// sync back independently. The "Your galleries" list shows them grouped by folder.
//
// Set up once: deploy the Worker (`npm run deploy-worker`, or the manual steps in
// the README), then paste the Worker URL + write key in Preferences → Web Tools.
//
// Built with esbuild (`npm run build`); JSX → h(...). React comes from api.react.

import {
  publishToCloud, startCloudPoller, checkCloudNow, cloudReady, cloudConfig, cloudShareLink,
  useConnection, connColor, listGalleries, unpublishGallery,
} from "./cloud.js";
import { makeSetupWizard } from "./SetupWizard.jsx";

let api = null;
let React = null;
let store = null;
let stopCloud = null;

function h(...args) { return React.createElement(...args); }

const cat = () => api.stores.useCatalogStore;
const uiStore = () => api.stores.useUIStore;

function settings() {
  const g = (k, f) => api.settings.get(k, f);
  return {
    photographer: g("photographer", ""),
    webEdge: Number(g("webEdge", 2048)) || 2048,
    quality: Math.min(0.97, Math.max(0.5, Number(g("quality", 0.85)) || 0.85)),
    source: g("source", "picks"), // picks | selected | all
  };
}

/** Best available in-catalog preview pixels for a photo, as a Blob. Used by the
 *  proofing path (and as a fallback when a full-res render isn't available). */
async function previewBlob(photo) {
  if (photo.thumbnailBlob) return photo.thumbnailBlob;
  if (photo.thumbnailUrl) {
    try { return await (await fetch(photo.thumbnailUrl)).blob(); } catch { return null; }
  }
  return null;
}

// ── Folder scoping ────────────────────────────────────────────────────────────
// Galleries are organized per folder: picks/all are scoped to the Library's
// active folder so each gallery covers one shoot. Mirrors core's inFolder()
// (visible-photos.ts) including the showSubfolderPhotos preference.

function activeFolder() { try { return uiStore().getState().activeFolder; } catch { return null; } }
function folderLabel(f) { return f == null ? "All Photos" : f === "" ? "Project root" : f; }
function showSubfolders() { try { return !!api.stores.useSettings.getState().showSubfolderPhotos; } catch { return false; } }
function inActiveFolder(p, f) {
  if (f == null) return true; // "All Photos"
  if (p.folder === f) return true;
  if (!showSubfolders()) return false;
  return f === "" || (p.folder && p.folder.startsWith(f + "/"));
}

/** Which photos to publish, per the configured source and active folder. */
function sourcePhotos() {
  const c = cat().getState();
  const all = c.photos;
  const s = settings();
  // An explicit selection is taken verbatim — folder scoping would be surprising.
  if (s.source === "selected") return all.filter((p) => c.selectedIds.has(p.id));
  const f = activeFolder();
  const base = s.source === "all" ? all.filter((p) => p.flag !== "reject") : all.filter((p) => p.flag === "pick");
  return base.filter((p) => inActiveFolder(p, f));
}

/** Export settings for a public render: honor the user's export resolution and
 *  quality (Preferences ▸ Export), but always JPEG for the web, and cap an
 *  "Original" (null) long edge to the gallery's own web-size setting so we don't
 *  push full-sensor files. Returns null when the host predates api.export. */
function buildExportSettings(s) {
  if (!api.export || typeof api.export.getDefaultSettings !== "function") return null;
  let def = null;
  try { def = api.export.getDefaultSettings(); } catch { return null; }
  if (!def) return null;
  const longEdge = def.longEdge != null ? def.longEdge : s.webEdge;
  return { ...def, format: "image/jpeg", longEdge };
}

function ensureCloudPoller() {
  if (stopCloud) return;
  stopCloud = startCloudPoller(api, (info) => store.getState()._onApplied(info));
}

// ── Store ─────────────────────────────────────────────────────────────────────
function makeStore() {
  return api.stores.create((set, get) => ({
    busy: false,
    progress: null,
    status: "",
    lastApplied: null, // info from the poller (most recent applied decision)

    setStatusMsg(status) { set({ status }); },

    async publish(meta) {
      if (get().busy) return;
      const kind = meta.kind === "public" ? "public" : "proofing";
      const photos = sourcePhotos();
      if (!photos.length) { set({ status: "No photos match the selected source." }); return; }
      if (!cloudReady(api)) { set({ status: "Add your Worker URL and key in Preferences → Web Tools." }); return; }

      // progress stays null until the upload phase drives the bar; the render
      // phase (public) reports through onStatus instead, so the button/bar don't
      // claim "Uploading" while images are still rendering.
      set({ busy: true, status: "Preparing images…", progress: null });
      try {
        const s = settings();
        const exportSettings = kind === "public" ? buildExportSettings(s) : null;
        const folder = folderLabel(activeFolder());
        const project = await publishToCloud(api, {
          kind, title: meta.title, client: meta.client, photographer: s.photographer,
          source: photos, webEdge: s.webEdge, quality: s.quality, exportSettings, folder,
          getBlob: previewBlob,
          onProgress: (done, total) => set({ progress: { done, total } }),
          onStatus: (msg) => set({ status: msg }),
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
        await unpublishGallery(api, projectId);
        set({ status: "Gallery removed." });
      } catch (e) {
        set({ status: "Couldn't remove the gallery: " + (e && e.message ? e.message : String(e)) });
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
        status: `Applied ${info.client || "client"}'s decision to "${info.title}": ${c.pick} pick, ${c.reject} reject, ${c.none} unset${info.unknown ? `, ${info.unknown} unmatched` : ""}.`,
      });
    },
  }));
}

// ── UI ──────────────────────────────────────────────────────────────────────
// Generic controls (buttons, inputs, segmented control, progress bar) come from
// the shared core UI kit (api.ui) so they match the app exactly. Only the
// domain-specific bits below — the status dot, share box, etc. — stay hand-rolled.
const S = {
  wrap: { padding: "10px", display: "flex", flexDirection: "column", gap: "10px", fontSize: "11px", color: "var(--color-text-primary)" },
  sec: { display: "flex", flexDirection: "column", gap: "6px" },
  secHead: { display: "flex", alignItems: "center", fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--color-text-secondary)", borderBottom: "1px solid var(--color-border)", paddingBottom: "3px" },
  row: { display: "flex", gap: "6px", alignItems: "center" },
  status: { color: "var(--color-text-secondary)", minHeight: "26px", lineHeight: 1.4 },
  dot: (color) => ({ width: "7px", height: "7px", borderRadius: "50%", background: color, flex: "0 0 auto" }),
  share: { display: "flex", flexDirection: "column", gap: "6px", padding: "8px", border: "1px solid var(--color-accent)", borderRadius: "4px", background: "var(--color-surface-2)" },
  shareUrl: { fontSize: "11px", color: "var(--color-accent)", wordBreak: "break-all", userSelect: "all" },
  folderHead: { fontSize: "10px", color: "var(--color-text-muted)", display: "flex", alignItems: "center", gap: "4px", marginTop: "2px" },
};

/** Shown when the host core predates the api.ui kit this panel relies on. */
function uiUnavailable() {
  return h("div", { style: { padding: "10px", fontSize: "11px", color: "var(--color-text-muted)" } }, "Update Safelight to use this panel.");
}

function WebToolsPanel() {
  if (!api.ui) return uiUnavailable();
  const { Button, TextInput, SegmentedControl, ProgressBar } = api.ui;
  const Badge = api.ui.Badge || (({ children }) => h("span", { style: { fontSize: "9px", color: "var(--color-text-secondary)" } }, children));
  const { useState, useEffect } = React;
  const selectedIds = cat()((s) => s.selectedIds);
  cat()((s) => s.photos); // re-render when the catalog changes
  const curFolder = uiStore()((s) => s.activeFolder); // re-render when the folder changes

  const busy = store((s) => s.busy);
  const progress = store((s) => s.progress);
  const status = store((s) => s.status);
  const lastApplied = store((s) => s.lastApplied);
  const st = store.getState();

  const [, setTick] = useState(0);
  useEffect(() => api.settings.onChange(() => setTick((t) => t + 1)), []);
  const conn = useConnection(React, api);
  const s = settings();

  const cloudOk = cloudReady(api);
  const cfg = cloudConfig(api);
  const copy = (text) => { try { navigator.clipboard.writeText(text); st.setStatusMsg("Link copied."); } catch {} };
  // Only open absolute http(s) links — a schemeless URL would resolve against the
  // app:// origin and open a new app window instead of the system browser.
  const openUrl = (u) => { try { if (/^https?:\/\//i.test(u)) window.open(u, "_blank", "noopener"); } catch {} };
  const openSetup = () => { try { api.preferences && api.preferences.open && api.preferences.open("web-tools"); } catch {} };

  const [mode, setMode] = useState("proofing"); // proofing | public
  const [title, setTitle] = useState("");
  const [clientName, setClientName] = useState("");
  const [clientEmail, setClientEmail] = useState("");

  const count = sourcePhotos().length;
  const sourceLabel = s.source === "selected" ? "selected photos" : s.source === "all" ? "all (non-rejected)" : "your picks";

  // Galleries grouped by folder, newest first within each group (list is already
  // newest-first). Reads from settings; re-renders via the onChange tick above.
  const galleries = listGalleries(api);
  const groups = [];
  const byFolder = new Map();
  for (const g of galleries) {
    const key = g.folder || "All Photos";
    if (!byFolder.has(key)) { byFolder.set(key, []); groups.push(key); }
    byFolder.get(key).push(g);
  }

  const renderGallery = (g) => {
    const url = cloudShareLink(cfg, g.projectId, g.token);
    const decision = g.lastInfo
      ? `${g.lastInfo.client || "Client"}: ${g.lastInfo.counts.pick} pick · ${g.lastInfo.counts.reject} reject${g.lastInfo.note ? ` — “${g.lastInfo.note}”` : ""}`
      : "Awaiting client decision…";
    return h("div", { key: g.projectId, style: S.share },
      h("div", { style: S.row },
        h("span", { style: { flex: 1, fontWeight: 600, wordBreak: "break-word" } }, g.title),
        h(Badge, null, g.kind === "public" ? "Public" : "Proofing")),
      h("div", { style: { fontSize: "10px", color: "var(--color-text-secondary)" } }, `${g.count} photo${g.count === 1 ? "" : "s"}`),
      url
        ? h(React.Fragment, null,
            h("div", { style: S.shareUrl, title: url }, url),
            h("div", { style: S.row },
              h(Button, { variant: "primary", size: "sm", onClick: () => openUrl(url) }, "Open"),
              h(Button, { size: "sm", onClick: () => copy(url) }, "Copy"),
              h("span", { style: { flex: 1 } }),
              h(Button, { variant: "ghost", size: "sm", onClick: () => st.unpublish(g.projectId) }, "Remove")))
        : h("div", { style: { fontSize: "10px", color: "var(--color-warning, #d29922)" } }, "Add your Worker URL + key to get the link."),
      g.kind === "proofing"
        ? h("div", { style: { fontSize: "10px", color: "var(--color-text-secondary)" } }, decision)
        : null);
  };

  return (
    <div style={S.wrap}>
      {/* Status */}
      <div style={S.sec}>
        <div style={S.secHead}>
          <span style={{ flex: 1 }}>Status</span>
          <Button variant="ghost" size="sm" onClick={openSetup}>Set up</Button>
        </div>
        <div style={S.row}>
          <span style={S.dot(connColor(conn.state))} />
          <span style={{ flex: 1, color: "var(--color-text-secondary)" }}>
            {conn.ok ? "Ready to publish" : conn.message}
          </span>
        </div>
        {conn.state === "unconfigured" && (
          <div style={{ color: "var(--color-warning, #d29922)", fontSize: "10px" }}>
            Deploy the Worker once (<code>npm run deploy-worker</code>), then paste its URL + key under <b>Set up</b>.
          </div>
        )}
        {!conn.ok && conn.state !== "unconfigured" && conn.state !== "checking" && (
          <div style={{ color: "#f0506e", fontSize: "10px" }}>
            {conn.message} — check the URL + key under <b>Set up</b>.
          </div>
        )}
      </div>

      {/* New gallery */}
      <div style={S.sec}>
        <div style={S.secHead}>New gallery</div>
        <SegmentedControl
          value={mode}
          onChange={setMode}
          size="sm"
          options={[
            { value: "proofing", label: "Proofing", title: "Client picks/rejects come back to you" },
            { value: "public", label: "Public", title: "A public portfolio gallery (no client review)" },
          ]}
        />
        <TextInput placeholder="Gallery title" value={title} onChange={setTitle} />
        {mode === "proofing" && (
          <React.Fragment>
            <TextInput placeholder="Client name" value={clientName} onChange={setClientName} />
            <TextInput placeholder="Client email (optional)" value={clientEmail} onChange={setClientEmail} />
          </React.Fragment>
        )}
        <div style={{ color: "var(--color-text-secondary)" }}>
          Source: <b>{sourceLabel}</b>
          {s.source !== "selected" && <React.Fragment> in <b>{folderLabel(curFolder)}</b></React.Fragment>}
          {" "}— {count} photo{count === 1 ? "" : "s"}
          {s.source === "selected" ? ` (${selectedIds.size} selected)` : ""}
        </div>
        {mode === "public" && (
          <div style={{ fontSize: "10px", color: "var(--color-text-muted)" }}>
            Rendered at your export resolution/quality (Preferences ▸ Export).
          </div>
        )}
        <Button
          variant="primary"
          full
          disabled={busy || !cloudOk || !count}
          onClick={() => st.publish({ kind: mode, title: title || "Untitled gallery", client: { name: clientName, email: clientEmail } })}
        >
          {busy ? (progress ? `Uploading ${progress.done}/${progress.total}…` : "Working…") : `Publish ${mode === "public" ? "portfolio" : "proofing"} · ${count} photo${count === 1 ? "" : "s"}`}
        </Button>
        {busy && progress && <ProgressBar value={progress.total ? progress.done / progress.total : 0} />}
      </div>

      {/* Your galleries */}
      {galleries.length > 0 && (
        <div style={S.sec}>
          <div style={S.secHead}>Your galleries</div>
          {groups.map((folder) => (
            <React.Fragment key={folder}>
              <div style={S.folderHead}>{folder}</div>
              {byFolder.get(folder).map(renderGallery)}
            </React.Fragment>
          ))}
        </div>
      )}

      {/* Client decisions */}
      <div style={S.sec}>
        <div style={S.secHead}>Client decisions</div>
        <div style={S.row}>
          <Button size="sm" disabled={!cloudOk} onClick={() => st.checkNow()}>Check now</Button>
          <span style={{ flex: 1, color: "var(--color-text-secondary)", fontSize: "10px" }}>Auto-checks every gallery for replies</span>
        </div>
        {lastApplied && (
          <div style={{ color: "var(--color-text-secondary)" }}>
            Last: {lastApplied.client || "client"} → “{lastApplied.title}”
            {lastApplied.note ? <div style={{ fontStyle: "italic", marginTop: "3px" }}>“{lastApplied.note}”</div> : null}
          </div>
        )}
      </div>

      <div style={S.status}>{status}</div>
    </div>
  );
}

// Wrap a component so a render error shows inline instead of breaking the host UI.
function withBoundary(Comp, label) {
  return class extends React.Component {
    constructor(p) { super(p); this.state = { err: null }; }
    static getDerivedStateFromError(err) { return { err }; }
    render() {
      if (!this.state.err) return React.createElement(Comp, this.props);
      return React.createElement("div", { style: { padding: "10px", fontSize: "11px", color: "var(--color-text-primary)" } },
        React.createElement("div", { style: { color: "#f0506e", marginBottom: "6px" } }, `Web Tools ${label} error — please report this:`),
        React.createElement("pre", { style: { whiteSpace: "pre-wrap", fontSize: "10px", color: "var(--color-text-secondary)" } },
          String((this.state.err && this.state.err.message) || this.state.err)));
    }
  };
}

// ── Activation ────────────────────────────────────────────────────────────────
export function activate(_api) {
  api = _api;
  React = api.react;
  store = makeStore();

  api.registerPanel({
    id: "web-tools.panel",
    title: "Web Tools",
    component: withBoundary(WebToolsPanel, "panel"),
    defaultDock: { module: "library", direction: "right", order: 3, width: 300, height: 380 },
  });

  // Setup wizard (Worker URL + key + gallery defaults) as the Preferences UI.
  // `fields: []` is required even with a custom component — the host indexes
  // c.fields unconditionally for settings search (PreferencesDialog).
  api.registerSettings({
    title: "Web Tools",
    fields: [],
    keywords: ["gallery", "proofing", "publish", "client", "cloudflare", "worker"],
    component: withBoundary(makeSetupWizard({ React, store, api }), "settings"),
  });

  ensureCloudPoller();
}

export function deactivate() {
  if (stopCloud) { stopCloud(); stopCloud = null; }
  api = null; React = null; store = null;
}
