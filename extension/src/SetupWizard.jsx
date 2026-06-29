// Setup UI in Preferences ▸ Extensions ▸ Web Tools (registerSettings component).
// Cloudflare-only: paste the Worker URL + write key (from `npm run deploy-worker`
// or the manual steps in the README), plus a few gallery defaults. Native
// styling, applies as you type (text on blur) — no Save button.

import { useConnection, connColor } from "./cloud.js";

let React;
let api;
function h(...a) { return React.createElement(...a); }

// Generic controls (fields, inputs, select, number inputs) come from the shared
// core UI kit (api.ui) so they match the app exactly. Only the domain-specific
// bits below — the connection status dot, the inline code chip, and the masked
// write-key field (the kit's TextInput has no password mode) — stay hand-rolled.
const sx = {
  list: { display: "flex", flexDirection: "column", gap: "16px", fontSize: "11px", color: "var(--color-text-primary)" },
  row: { display: "flex", alignItems: "center", gap: "8px" },
  dot: (color) => ({ width: "7px", height: "7px", borderRadius: "50%", flex: "0 0 auto", background: color }),
  code: { fontFamily: "var(--font-mono, monospace)", background: "var(--color-surface-2)", padding: "1px 4px", borderRadius: "3px" },
  // Mirrors the core TextInput so the masked write-key field stays visually uniform.
  pw: { width: "100%", boxSizing: "border-box", borderRadius: "4px", background: "var(--color-surface-2)", padding: "5px 8px", fontSize: "11px", color: "var(--color-text-primary)", border: "1px solid var(--color-border)", outline: "none" },
};

/** Shown when the host core predates the api.ui kit this panel relies on. */
function uiUnavailable() {
  return h("div", { style: { padding: "10px", fontSize: "11px", color: "var(--color-text-muted)" } }, "Update Safelight to use this panel.");
}

export function makeSetupWizard(ctx) {
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
    const setDefault = (k, v) => { api.settings.set(k, v); setDefaults((d) => ({ ...d, [k]: v })); };

    // Persist the Worker URL as typed. cloudConfig() normalizes at read time
    // (adds https:// if missing, strips trailing slashes), so we keep the raw
    // text in the field instead of rewriting it mid-keystroke.
    const commitWorkerUrl = (raw) => {
      setWorkerUrl(raw);
      api.settings.set("cloudWorkerUrl", raw);
    };

    return h("div", { style: sx.list },
      // Connection
      h(Field, null,
        h("div", { style: sx.row },
          h("span", { style: sx.dot(connColor(conn.state)) }),
          h("span", null, conn.message))),

      h(Field, { label: "Worker URL" },
        h(TextInput, { placeholder: "https://swt-worker.you.workers.dev", value: workerUrl,
          onChange: commitWorkerUrl })),

      h(Field, { label: "Write key",
        hint: h(React.Fragment, null,
          "Deploy the Worker once — run ", h("span", { style: sx.code }, "npm run deploy-worker"),
          " in the Web Tools folder (or follow the manual steps in the README), then paste the two values it prints here.") },
        h("input", { style: sx.pw, type: "password", placeholder: "your WRITE_KEY", value: writeKey,
          onChange: (e) => { setWriteKey(e.target.value); api.settings.set("cloudWriteKey", e.target.value.trim()); } })),

      // Gallery defaults
      h(Field, { label: "Which photos to publish" },
        h(Select, { value: defaults.source, onChange: (v) => setDefault("source", v),
          options: [
            { value: "picks", label: "My picks (flagged)" },
            { value: "selected", label: "Selected photos" },
            { value: "all", label: "All (except rejects)" },
          ] })),
      h(Field, { label: "Your name / studio" },
        h(TextInput, { value: defaults.photographer, placeholder: "Shown on public galleries", onChange: (v) => setDefault("photographer", v) })),
      h(Field, { label: "Image size (px) / quality" },
        h("div", { style: sx.row },
          h(NumberInput, { min: 800, max: 4096, step: 64, value: defaults.webEdge, width: 90, onChange: (n) => setDefault("webEdge", n) }),
          h(NumberInput, { min: 0.5, max: 0.97, step: 0.01, value: defaults.quality, width: 80, onChange: (n) => setDefault("quality", n) }))));
  };
}
