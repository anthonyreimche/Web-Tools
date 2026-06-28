// Per-service token store: a plain JSON file at cli/.swt-tokens.json (gitignored).
//
// NOTE: tokens are stored in cleartext. That's fine for a single-user desktop
// tool, but don't commit the file or share it. A keychain backend (keytar) can
// be slotted in later behind this same get/set interface.

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

function file(cfg) { return join(cfg.cliRoot, ".swt-tokens.json"); }

async function all(cfg) {
  try { return JSON.parse(await readFile(file(cfg), "utf8")); } catch { return {}; }
}

export async function getTokens(cfg, service) {
  return (await all(cfg))[service] || null;
}

export async function setTokens(cfg, service, tokens) {
  const data = await all(cfg);
  data[service] = tokens;
  await writeFile(file(cfg), JSON.stringify(data, null, 2));
}
