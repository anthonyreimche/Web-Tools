#!/usr/bin/env node
// Safelight Web Tools companion CLI ("swt") — optional photo-service publishing.
//
// Galleries are published from inside Safelight to your Cloudflare Worker; this
// CLI is only for pushing a published gallery's photos on to a photo service
// (Flickr, SmugMug, …). It pulls the images from your Worker, so it needs the
// Worker URL (saved in worker/.deployed.json by `npm run deploy-worker`).

import { loadConfig, requireFields } from "./config.js";

const HELP = `swt — Safelight Web Tools (photo-service publishing)

First deploy the gallery backend once (from the Web Tools folder):
  npm run deploy-worker

Then push a published gallery's photos to a service:
  swt login <service>                                  Authorize a service (flickr, smugmug)
  swt push <projectId> --to <service> [--album "Name"]  Upload its photos
  swt help

The <projectId> is the id in the gallery link (…/g/<projectId>).
Service API keys go in cli/swt.config.local.json; the Worker URL comes from
worker/.deployed.json (or SWT_WORKER_URL).`;

async function main() {
  const argv = process.argv.slice(2);
  const [cmd, arg] = argv;
  if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") { console.log(HELP); return; }

  const cfg = await loadConfig();

  switch (cmd) {
    case "login": {
      if (!arg) die("usage: swt login <service>");
      const { login } = await import("./services/index.js");
      await login(cfg, arg);
      break;
    }

    case "push": {
      if (!arg) die("usage: swt push <projectId> --to <service> [--album \"Name\"]");
      const to = flagVal(argv, "--to");
      const album = flagVal(argv, "--album");
      if (!to) die("push: --to <service> is required (e.g. --to flickr)");
      requireFields(cfg, ["workerUrl"]);
      const { push } = await import("./services/index.js");
      await push(cfg, arg, to, { album });
      break;
    }

    default:
      console.error(`Unknown command: ${cmd}\n`);
      console.log(HELP);
      process.exit(1);
  }
}

function flagVal(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
}
function die(msg) { console.error(msg); process.exit(1); }

main().catch((e) => { console.error(e.message || e); process.exit(1); });
