// Safelight Web Tools — shared wire protocol.
//
// Single source of truth for the two documents exchanged with the Cloudflare
// Worker:
//   project.json   (extension → Worker → gallery)   schema "swt.project/1"
//   decision.json  (Worker → extension)             schema "swt.decision/1"
//
// Plain dependency-free ESM so every component can import it as-is: the
// extension bundles it (esbuild), the CLI imports it (Node), the gallery loads
// it in the browser, and the Worker bundles it. Keep it free of Node/DOM globals.

export const PROJECT_SCHEMA = "swt.project/1";
export const DECISION_SCHEMA = "swt.decision/1";

/** Tri-state pick flag — mirrors Safelight's catalog FlagStatus exactly. */
export const FLAGS = /** @type {const} */ (["pick", "reject", "none"]);

/** Project kinds. "proofing" has a client + decision loop; "public" is a
 *  one-way portfolio gallery with no client fields. */
export const KINDS = /** @type {const} */ (["proofing", "public"]);

// ── ID generation ────────────────────────────────────────────────────────────
// crypto.randomUUID exists in modern browsers and Node ≥ 16. We keep ids short,
// URL-safe, and sortable-ish by prefixing a base36 millisecond stamp.

function rand(n) {
  // n hex-ish chars from a UUID (no dashes), lowercased.
  const uuid =
    (globalThis.crypto && globalThis.crypto.randomUUID)
      ? globalThis.crypto.randomUUID().replace(/-/g, "")
      : Math.random().toString(16).slice(2).padEnd(32, "0");
  return uuid.slice(0, n);
}

/** A project id like "prf-lq3k7t-9f2a" (kind prefix + time + entropy). */
export function newProjectId(kind = "proofing") {
  const prefix = kind === "public" ? "pub" : "prf";
  const stamp = Date.now().toString(36);
  return `${prefix}-${stamp}-${rand(4)}`;
}

/** A publish-local photo id — never the catalog id, so the catalog id never
 *  leaks to the public web and one catalog photo can appear in many projects. */
export function newPhotoId() {
  return `p-${rand(10)}`;
}

/** A per-project client access token (low-trust, embedded in the share link). */
export function newProjectToken() {
  return `${rand(16)}${rand(16)}`;
}

// ── Validation ───────────────────────────────────────────────────────────────
// Deliberately lightweight: enough to refuse a version/shape mismatch and to
// stop a malformed decision from silently misapplying flags. Returns an array
// of human-readable problems ([] === valid).

const isStr = (v) => typeof v === "string" && v.length > 0;
const isFlag = (v) => FLAGS.includes(v);

export function validateProject(doc) {
  const errs = [];
  if (!doc || typeof doc !== "object") return ["project is not an object"];
  if (doc.schema !== PROJECT_SCHEMA) errs.push(`schema must be "${PROJECT_SCHEMA}" (got "${doc.schema}")`);
  if (!isStr(doc.projectId)) errs.push("projectId missing");
  if (!KINDS.includes(doc.kind)) errs.push(`kind must be one of ${KINDS.join("|")}`);
  if (!Array.isArray(doc.photos) || doc.photos.length === 0) errs.push("photos[] missing or empty");
  else {
    doc.photos.forEach((p, i) => {
      if (!isStr(p.photoId)) errs.push(`photos[${i}].photoId missing`);
      if (doc.kind === "proofing" && !isStr(p.catalogId)) errs.push(`photos[${i}].catalogId missing`);
      if (p.prePick != null && !isFlag(p.prePick)) errs.push(`photos[${i}].prePick invalid`);
    });
  }
  return errs;
}

export function validateDecision(doc) {
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

// ── Apply-back helper ────────────────────────────────────────────────────────

/**
 * Map a decision back onto catalog ids and bucket by final flag state.
 * @param {object} project  a validated swt.project/1 doc
 * @param {object} decision a validated swt.decision/1 doc
 * @returns {{pick:string[], reject:string[], none:string[], unknown:string[]}}
 *   catalog ids per bucket; `unknown` holds decision photoIds with no match.
 */
export function bucketDecision(project, decision) {
  const byPhotoId = new Map(project.photos.map((p) => [p.photoId, p.catalogId]));
  const out = { pick: [], reject: [], none: [], unknown: [] };
  for (const d of decision.decisions) {
    const catalogId = byPhotoId.get(d.photoId);
    if (!catalogId) { out.unknown.push(d.photoId); continue; }
    out[d.pick].push(catalogId);
  }
  return out;
}

// ── Document factories ───────────────────────────────────────────────────────

/**
 * Build a project.json document.
 * @param {object} o
 * @param {"proofing"|"public"} o.kind
 * @param {string} o.title
 * @param {{name?:string,email?:string}} [o.client]
 * @param {string} [o.submitUrl]  the Worker /submit endpoint (proofing only)
 * @param {string} [o.token]      per-project client token (proofing only)
 * @param {string[]} [o.targets]  platform push targets (phase 3/4)
 * @param {Array} o.photos        [{photoId,catalogId,filename,web,thumb,width,height,prePick}]
 * @param {string} [o.createdAt]  ISO; defaults to now
 * @param {string} [o.projectId]  defaults to a fresh id
 */
export function makeProject(o) {
  return {
    schema: PROJECT_SCHEMA,
    projectId: o.projectId || newProjectId(o.kind),
    kind: o.kind,
    title: o.title || "Untitled gallery",
    photographer: o.photographer || "",
    createdAt: o.createdAt || new Date().toISOString(),
    client: o.kind === "proofing" ? (o.client || {}) : undefined,
    submitUrl: o.submitUrl || undefined,
    token: o.token || undefined,
    targets: o.targets || [],
    photos: o.photos.map((p) => ({
      photoId: p.photoId,
      catalogId: p.catalogId,
      filename: p.filename,
      web: p.web,
      thumb: p.thumb,
      width: p.width,
      height: p.height,
      prePick: p.prePick || "none",
    })),
  };
}

/** Build a decision.json document (used by the gallery/worker side). */
export function makeDecision(o) {
  return {
    schema: DECISION_SCHEMA,
    projectId: o.projectId,
    submittedAt: o.submittedAt || new Date().toISOString(),
    client: o.client || {},
    note: o.note || "",
    decisions: (o.decisions || []).map((d) => ({ photoId: d.photoId, pick: d.pick })),
  };
}
