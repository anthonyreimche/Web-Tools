// Safelight Web Tools — in-app extension (Cloudflare-only).
//
// Publishes a proofing or public gallery from the Library straight to your
// Cloudflare Worker, and polls the Worker for the client's picks/rejects,
// applying them to the catalog. The app's CSP allows the Worker origin, so the
// extension talks to it directly — no local helper, folder, or per-gallery setup.
//
// Set up once: deploy the Worker (`npm run deploy-worker`, or the manual steps in
// the README), then paste the Worker URL + write key in Preferences → Web Tools.
//
// Built with esbuild (`npm run build`); JSX → h(...). React comes from api.react.

import {
  publishToCloud, startCloudPoller, checkCloudNow, cloudReady, cloudConfig, cloudShareLink,
  useConnection, connColor,
} from "./cloud.js";
import { makeSetupWizard } from "./SetupWizard.jsx";

let api = null;
let React = null;
let store = null;
let stopCloud = null;

function h(...args) { return React.createElement(...args); }

const cat = () => api.stores.useCatalogStore;

function settings() {
  const g = (k, f) => api.settings.get(k, f);
  return {
    photographer: g("photographer", ""),
    webEdge: Number(g("webEdge", 2048)) || 2048,
    quality: Math.min(0.97, Math.max(0.5, Number(g("quality", 0.85)) || 0.85)),
    source: g("source", "picks"), // picks | selected | all
  };
}

/** Best available in-catalog preview pixels for a photo, as a Blob. */
async function previewBlob(photo) {
  if (photo.thumbnailBlob) return photo.thumbnailBlob;
  if (photo.thumbnailUrl) {
    try { return await (await fetch(photo.thumbnailUrl)).blob(); } catch { return null; }
  }
  return null;
}

/** Which photos to publish, per the configured source. */
function sourcePhotos() {
  const c = cat().getState();
  const all = c.photos;
  const s = settings();
  if (s.source === "selected") return all.filter((p) => c.selectedIds.has(p.id));
  if (s.source === "all") return all.filter((p) => p.flag !== "reject");
  return all.filter((p) => p.flag === "pick"); // default: picks
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
    lastApplied: null,                                   // info from the poller
    lastPublished: api.settings.get("lastPublished", null), // { projectId, token, title, kind }

    setStatusMsg(status) { set({ status }); },

    async publish(meta) {
      if (get().busy) return;
      const kind = meta.kind === "public" ? "public" : "proofing";
      const photos = sourcePhotos();
      if (!photos.length) { set({ status: "No photos match the selected source." }); return; }
      if (!cloudReady(api)) { set({ status: "Add your Worker URL and key in Preferences → Web Tools." }); return; }

      set({ busy: true, status: "Preparing images…", progress: { done: 0, total: photos.length } });
      try {
        const s = settings();
        const project = await publishToCloud(api, {
          kind, title: meta.title, client: meta.client, photographer: s.photographer,
          source: photos, webEdge: s.webEdge, quality: s.quality,
          getBlob: previewBlob, onProgress: (done, total) => set({ progress: { done, total } }),
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
        status: `Applied ${info.client || "client"}'s decision to "${info.title}": ${c.pick} pick, ${c.reject} reject, ${c.none} unset${info.unknown ? `, ${info.unknown} unmatched` : ""}.`,
      });
    },
  }));
}

// ── UI ──────────────────────────────────────────────────────────────────────
const S = {
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
  shareUrl: { fontSize: "11px", color: "var(--color-accent)", wordBreak: "break-all", userSelect: "all" },
};
const btnPrimary = { ...S.btn, background: "var(--color-accent)", border: "1px solid var(--color-accent)", color: "#fff" };
const dis = (s) => ({ ...s, opacity: 0.45, cursor: "default" });

function WebToolsPanel() {
  const { useState, useEffect } = React;
  const selectedIds = cat()((s) => s.selectedIds);
  cat()((s) => s.photos); // re-render when the catalog changes

  const busy = store((s) => s.busy);
  const progress = store((s) => s.progress);
  const status = store((s) => s.status);
  const lastApplied = store((s) => s.lastApplied);
  const lastPublished = store((s) => s.lastPublished);
  const st = store.getState();

  const [, setTick] = useState(0);
  useEffect(() => api.settings.onChange(() => setTick((t) => t + 1)), []);
  const conn = useConnection(React, api);
  const s = settings();

  const cloudOk = cloudReady(api);
  const shareUrl = lastPublished ? cloudShareLink(cloudConfig(api), lastPublished.projectId, lastPublished.token) : "";
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
  const pct = progress && progress.total ? Math.round((100 * progress.done) / progress.total) : 0;

  return (
    <div style={S.wrap}>
      {/* Status */}
      <div style={S.sec}>
        <div style={S.secHead}>
          <span style={{ flex: 1 }}>Status</span>
          <button style={{ ...S.btn, padding: "2px 6px", fontSize: "10px" }} onClick={openSetup}>Set up</button>
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
        <div style={S.seg}>
          {[["proofing", "Proofing"], ["public", "Public"]].map(([m, label], i) => (
            <button key={m}
              style={{ ...S.segBtn, ...(i === 0 ? {} : { borderRight: "none" }), ...(mode === m ? S.segOn : null) }}
              onClick={() => setMode(m)}
              title={m === "proofing" ? "Client picks/rejects come back to you" : "A public portfolio gallery (no client review)"}>
              {label}
            </button>
          ))}
        </div>
        <input style={S.field} placeholder="Gallery title" value={title} onChange={(e) => setTitle(e.target.value)} />
        {mode === "proofing" && (
          <React.Fragment>
            <input style={S.field} placeholder="Client name" value={clientName} onChange={(e) => setClientName(e.target.value)} />
            <input style={S.field} placeholder="Client email (optional)" value={clientEmail} onChange={(e) => setClientEmail(e.target.value)} />
          </React.Fragment>
        )}
        <div style={{ color: "var(--color-text-secondary)" }}>
          Source: <b>{s.source === "selected" ? "selected photos" : s.source === "all" ? "all (non-rejected)" : "your picks"}</b> — {count} photo{count === 1 ? "" : "s"}
          {s.source === "selected" ? ` (${selectedIds.size} selected)` : ""}
        </div>
        <button
          style={busy || !cloudOk || !count ? dis(btnPrimary) : btnPrimary}
          disabled={busy || !cloudOk || !count}
          onClick={() => st.publish({ kind: mode, title: title || "Untitled gallery", client: { name: clientName, email: clientEmail } })}
        >
          {busy && progress ? `Uploading ${progress.done}/${progress.total}…` : `Publish ${mode === "public" ? "portfolio" : "proofing"} · ${count} photo${count === 1 ? "" : "s"}`}
        </button>
        {busy && progress && <div style={S.bar}><div style={{ height: "100%", width: pct + "%", background: "var(--color-accent)" }} /></div>}

        {lastPublished && (
          <div style={S.share}>
            <div style={{ fontSize: "10px", color: "var(--color-text-secondary)" }}>
              {lastPublished.kind === "public" ? "Public gallery link" : "Send this link to your client"}:
            </div>
            {shareUrl ? (
              <React.Fragment>
                <div style={S.shareUrl} title={shareUrl}>{shareUrl}</div>
                <div style={S.row}>
                  <button style={btnPrimary} onClick={() => openUrl(shareUrl)}>Open</button>
                  <button style={S.btn} onClick={() => copy(shareUrl)}>Copy link</button>
                </div>
              </React.Fragment>
            ) : (
              <div style={{ fontSize: "11px", color: "var(--color-warning, #d29922)" }}>
                Add your Worker URL + key in Preferences to get the link.
              </div>
            )}
          </div>
        )}
      </div>

      {/* Client decisions */}
      <div style={S.sec}>
        <div style={S.secHead}>Client decisions</div>
        <div style={S.row}>
          <button style={cloudOk ? S.btn : dis(S.btn)} disabled={!cloudOk} onClick={() => st.checkNow()}>Check now</button>
          <span style={{ flex: 1, color: "var(--color-text-secondary)", fontSize: "10px" }}>Auto-checks for replies</span>
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
