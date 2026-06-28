// Setup UI in Preferences ▸ Extensions ▸ Web Tools (registerSettings component).
// Cloudflare-only: paste the Worker URL + write key (from `npm run deploy-worker`
// or the manual steps in the README), plus a few gallery defaults. Native
// styling, applies as you type (text on blur) — no Save button.

import { useConnection, connColor } from "./cloud.js";

let React;
function h(...a) { return React.createElement(...a); }

const sx = {
  list: { display: "flex", flexDirection: "column", gap: "16px", fontSize: "11px", color: "var(--color-text-primary)" },
  field: { display: "flex", flexDirection: "column", gap: "6px" },
  label: { fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--color-text-secondary)" },
  hint: { fontSize: "10px", lineHeight: 1.5, color: "var(--color-text-secondary)" },
  input: { width: "100%", boxSizing: "border-box", borderRadius: "4px", background: "var(--color-surface-2)", padding: "5px 8px", fontSize: "11px", color: "var(--color-text-primary)", border: "none", outline: "none" },
  row: { display: "flex", alignItems: "center", gap: "8px" },
  dot: (color) => ({ width: "7px", height: "7px", borderRadius: "50%", flex: "0 0 auto", background: color }),
  code: { fontFamily: "var(--font-mono, monospace)", background: "var(--color-surface-2)", padding: "1px 4px", borderRadius: "3px" },
};

function Field({ label, hint, children }) {
  return h("div", { style: sx.field }, label ? h("div", { style: sx.label }, label) : null, children, hint ? h("div", { style: sx.hint }, hint) : null);
}

export function makeSetupWizard(ctx) {
  React = ctx.React;
  const { api } = ctx;
  const g = (k, f) => api.settings.get(k, f);

  return function SetupWizard() {
    const { useState, useEffect } = React;
    const [, force] = useState(0);
    useEffect(() => api.settings.onChange(() => force((t) => t + 1)), []);
    const conn = useConnection(React, api);

    const [workerUrl, setWorkerUrl] = useState(g("cloudWorkerUrl", ""));
    const [writeKey, setWriteKey] = useState(g("cloudWriteKey", ""));
    const [defaults, setDefaults] = useState({ source: g("source", "picks"), photographer: g("photographer", ""), webEdge: g("webEdge", 2048), quality: g("quality", 0.85) });
    const setDefault = (k, v) => { api.settings.set(k, v); setDefaults((d) => ({ ...d, [k]: v })); };

    return h("div", { style: sx.list },
      // Connection
      h(Field, null,
        h("div", { style: sx.row },
          h("span", { style: sx.dot(connColor(conn.state)) }),
          h("span", null, conn.message))),

      h(Field, { label: "Worker URL" },
        h("input", { style: sx.input, placeholder: "https://swt-worker.you.workers.dev", value: workerUrl,
          onChange: (e) => setWorkerUrl(e.target.value), onBlur: () => {
            // Add the scheme if it's missing and reflect it back in the field, so
            // the stored value is always an absolute https:// URL.
            let v = workerUrl.trim().replace(/\/+$/, "");
            if (v && !/^https?:\/\//i.test(v)) v = "https://" + v;
            setWorkerUrl(v);
            api.settings.set("cloudWorkerUrl", v);
          } })),

      h(Field, { label: "Write key",
        hint: h(React.Fragment, null,
          "Deploy the Worker once — run ", h("span", { style: sx.code }, "npm run deploy-worker"),
          " in the Web Tools folder (or follow the manual steps in the README), then paste the two values it prints here.") },
        h("input", { style: sx.input, type: "password", placeholder: "your WRITE_KEY", value: writeKey,
          onChange: (e) => setWriteKey(e.target.value), onBlur: () => api.settings.set("cloudWriteKey", writeKey.trim()) })),

      // Gallery defaults
      h(Field, { label: "Which photos to publish" },
        h("select", { style: sx.input, value: defaults.source, onChange: (e) => setDefault("source", e.target.value) },
          h("option", { value: "picks" }, "My picks (flagged)"),
          h("option", { value: "selected" }, "Selected photos"),
          h("option", { value: "all" }, "All (except rejects)"))),
      h(Field, { label: "Your name / studio" },
        h("input", { style: sx.input, value: defaults.photographer, placeholder: "Shown on public galleries", onChange: (e) => setDefault("photographer", e.target.value) })),
      h(Field, { label: "Image size (px) / quality" },
        h("div", { style: sx.row },
          h("input", { style: { ...sx.input, width: "90px" }, type: "number", min: 800, max: 4096, step: 64, value: defaults.webEdge, onChange: (e) => setDefault("webEdge", Number(e.target.value)) }),
          h("input", { style: { ...sx.input, width: "80px" }, type: "number", min: 0.5, max: 0.97, step: 0.01, value: defaults.quality, onChange: (e) => setDefault("quality", Number(e.target.value)) }))));
  };
}
