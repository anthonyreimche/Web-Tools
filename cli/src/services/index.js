// Service registry + login/push dispatch.
//
// Real adapter: Flickr. Login-only / scaffolded: SmugMug. Documented scaffolds:
// 500px, Pixieset, and the social platforms (see ./social.js). Each adapter
// exposes { id, label, login(cfg), push(cfg, project, webDir, opts) }.
//
// Images are pulled from the published gallery on your Cloudflare Worker
// (GET /pj/:id for the manifest, GET /img/:id/:photo for each image) into a temp
// folder, so adapters keep their simple file-based interface.

import { writeFile, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as flickr from "./flickr.js";
import * as smugmug from "./smugmug.js";
import { SOCIAL } from "./social.js";

function scaffold(id, label, note) {
  return {
    id, label,
    async login() { throw new Error(`${label}: ${note}`); },
    async push() { throw new Error(`${label}: ${note}`); },
  };
}

const ADAPTERS = {
  flickr,
  smugmug,
  "500px": scaffold("500px", "500px", "the public upload API is restricted; no adapter yet."),
  pixieset: scaffold("pixieset", "Pixieset", "no public API; export + manual upload for now."),
  ...SOCIAL,
};

function get(service) {
  const a = ADAPTERS[service];
  if (!a) {
    throw new Error(`Unknown service "${service}". Known: ${Object.keys(ADAPTERS).join(", ")}`);
  }
  return a;
}

export async function login(cfg, service) {
  await get(service).login(cfg);
}

/** Fetch the published gallery's manifest + images from the Worker into a temp
 *  folder, and return { project, webDir } shaped like the adapters expect. */
async function fetchFromWorker(cfg, projectId) {
  const base = cfg.workerUrl;
  const res = await fetch(`${base}/pj/${projectId}`);
  if (!res.ok) throw new Error(`gallery ${projectId} not found on the Worker (${res.status}). Check the id from the share link.`);
  const project = await res.json();

  const webDir = await mkdtemp(join(tmpdir(), "swt-"));
  await mkdir(webDir, { recursive: true });
  for (const p of project.photos) {
    const imgRes = await fetch(`${base}/img/${projectId}/${p.photoId}`);
    if (!imgRes.ok) throw new Error(`image ${p.photoId} missing (${imgRes.status})`);
    await writeFile(join(webDir, `${p.photoId}.jpg`), Buffer.from(await imgRes.arrayBuffer()));
    p.web = `${p.photoId}.jpg`; // adapters read basename(p.web) from webDir
  }
  return { project, webDir };
}

export async function push(cfg, projectId, service, opts = {}) {
  console.log(`Fetching "${projectId}" from your Worker…`);
  const { project, webDir } = await fetchFromWorker(cfg, projectId);

  console.log(`\nPushing "${project.title}" (${project.photos.length} photos) → ${service}`);
  const result = await get(service).push(cfg, project, webDir, opts);
  console.log(`\n✓ Pushed to ${service}.`);
  return [result];
}

export function listServices() {
  return Object.values(ADAPTERS).map((a) => ({ id: a.id, label: a.label }));
}
