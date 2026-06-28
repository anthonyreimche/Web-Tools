// Minimal config for the photo-service CLI.
//   - Worker URL: from worker/.deployed.json (written by `npm run deploy-worker`)
//     or SWT_WORKER_URL. Used to pull a published gallery's images.
//   - Service API keys: from cli/swt.config.local.json (gitignored).

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = join(here, "..");
const repoRoot = join(cliRoot, "..");

async function readJsonMaybe(path) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; }
}

export async function loadConfig() {
  const local = (await readJsonMaybe(join(cliRoot, "swt.config.local.json"))) || {};
  const deployed = (await readJsonMaybe(join(repoRoot, "worker", ".deployed.json"))) || {};

  const cfg = {
    workerUrl: (process.env.SWT_WORKER_URL || local.workerUrl || deployed.workerUrl || "").replace(/\/+$/, ""),
    services: local.services || {},
    cliRoot,
    repoRoot,
  };
  return cfg;
}

export function requireFields(cfg, fields) {
  const missing = fields.filter((f) => !cfg[f]);
  if (missing.length) {
    if (missing.includes("workerUrl")) {
      console.error("No Worker URL found. Run `npm run deploy-worker` first, or set SWT_WORKER_URL.");
    } else {
      console.error("Missing config: " + missing.join(", "));
    }
    process.exit(1);
  }
}
