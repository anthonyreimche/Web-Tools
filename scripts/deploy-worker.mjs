// One-command Cloudflare setup: `npm run deploy-worker`.
//
// Does everything so you don't have to know Cloudflare:
//   1. logs you in (opens a browser) if needed
//   2. creates the KV namespace and writes its id into wrangler.toml
//   3. generates a WRITE_KEY and stores it as a Worker secret
//   4. deploys the Worker and prints its URL
//   5. prints the two values to paste into Safelight → Preferences → Web Tools
//
// Re-runnable: it reuses the same KV id + WRITE_KEY on later runs.

import { spawn } from "node:child_process";
import { readFile, writeFile, access } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const workerDir = join(here, "..", "worker");
const tomlPath = join(workerDir, "wrangler.toml");
const stampPath = join(workerDir, ".deployed.json");
const isWin = process.platform === "win32";

// Run wrangler. captureOut tees stdout to the console AND returns it. input (if
// set) is piped to stdin; otherwise stdin is inherited so prompts work.
function wrangler(args, { captureOut = false, input = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(isWin ? "npx.cmd" : "npx", ["--yes", "wrangler", ...args], {
      cwd: workerDir, shell: isWin,
      stdio: [input != null ? "pipe" : "inherit", captureOut ? "pipe" : "inherit", "inherit"],
    });
    let out = "";
    if (captureOut && child.stdout) child.stdout.on("data", (d) => { out += d; process.stdout.write(d); });
    if (input != null && child.stdin) { child.stdin.write(input); child.stdin.end(); }
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`wrangler ${args[0]} exited ${code}`))));
  });
}

async function exists(p) { try { await access(p); return true; } catch { return false; } }

async function main() {
  console.log("Safelight Web Tools — Cloudflare setup\n");

  // 0. Reuse a saved key if we've deployed before.
  let stamp = {};
  if (await exists(stampPath)) { try { stamp = JSON.parse(await readFile(stampPath, "utf8")); } catch {} }

  // 1. Login if needed.
  let who = "";
  try { who = await wrangler(["whoami"], { captureOut: true }); } catch {}
  if (!/@|Account ID|account/i.test(who)) {
    console.log("\nOpening Cloudflare login in your browser… approve it, then come back here.\n");
    await wrangler(["login"]);
  }

  // 2. KV namespace → wrangler.toml.
  let toml = await readFile(tomlPath, "utf8");
  if (toml.includes("REPLACE_WITH_KV_NAMESPACE_ID")) {
    console.log("\nCreating storage (KV namespace)…");
    const out = await wrangler(["kv", "namespace", "create", "DECISIONS"], { captureOut: true });
    const m = out.match(/id\s*=\s*"([0-9a-f]+)"/i);
    if (!m) throw new Error("Could not read the KV namespace id from wrangler output.");
    toml = toml.replace("REPLACE_WITH_KV_NAMESPACE_ID", m[1]);
    await writeFile(tomlPath, toml);
    console.log("  Storage ready.");
  } else {
    console.log("\nStorage already configured.");
  }

  // 3. WRITE_KEY secret (stable across runs).
  const writeKey = stamp.writeKey || randomBytes(24).toString("hex");
  console.log("Setting the upload key…");
  await wrangler(["secret", "put", "WRITE_KEY"], { input: writeKey + "\n" });

  // 4. Deploy.
  console.log("\nDeploying the Worker…");
  const deployOut = await wrangler(["deploy"], { captureOut: true });
  const urlMatch = deployOut.match(/https:\/\/[^\s]+\.workers\.dev/);
  const workerUrl = urlMatch ? urlMatch[0] : stamp.workerUrl || "";

  await writeFile(stampPath, JSON.stringify({ workerUrl, writeKey }, null, 2));

  // 5. The two values to paste.
  console.log("\n========================================================");
  console.log(" Done. Paste these into Safelight → Preferences → Web Tools:");
  console.log("   Backend:    Cloudflare");
  console.log(`   Worker URL: ${workerUrl || "(check the deploy output above)"}`);
  console.log(`   Write key:  ${writeKey}`);
  console.log("========================================================\n");
  console.log("(Saved to worker/.deployed.json for reference. Optional email alerts:");
  console.log(" cd worker && npx wrangler secret put RESEND_API_KEY / NOTIFY_EMAIL / NOTIFY_FROM)\n");
}

main().catch((e) => {
  console.error("\nSetup stopped: " + (e.message || e));
  console.error("You can re-run `npm run deploy-worker` — it picks up where it left off.");
  process.exit(1);
});
