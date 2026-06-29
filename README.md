# Web Tools

A Safelight extension that publishes **proofing** and **public** photo galleries
to the web (on Cloudflare), and pulls the client's picks/rejects back into your
Library.

```
Library ─▶ extension ─▶ Cloudflare Worker (gallery on the web)
                                   │
 Safelight grid ◀─ extension ◀─ client picks/rejects   (+ optional email)
 (applyFlag)
```

Once set up, the loop is: flag photos → **Publish** → copy the link → send it.
The client reviews on any device; their choices flow straight back into Safelight.

## How it works

The extension talks to **your own Cloudflare Worker** directly (the app's CSP
allows the Worker origin). The Worker stores the gallery (images + data in KV)
and serves the gallery page. There's no local server, helper, or folder — just
the app and your Worker.

You deploy that Worker **once** (it's your backend; someone has to host the
galleries). After that, zero setup per gallery.

---

## 1. Install the extension

Needs [Node.js](https://nodejs.org). In this folder:

```
npm install
npm run build:extension
```

Copy the `extension` folder into Safelight's plugins directory and rename it
`web-tools`, then restart Safelight — a **Web Tools** panel appears in the Library.

- **Windows:** `%APPDATA%\Safelight\plugins`
- **macOS:** `~/Library/Application Support/Safelight/plugins`
- **Linux:** `~/.config/Safelight/plugins`

## 2. Set up the Worker (once)

You need a free [Cloudflare account](https://dash.cloudflare.com/sign-up) — no
credit card (this uses KV only, not R2). Pick **one** of the two ways:

### Option A — one command (easiest)

```
npm run deploy-worker
```

It opens a browser to log you in the first time, creates the storage, deploys,
and prints two values:

```
Worker URL: https://swt-worker.you.workers.dev
Write key:  3f9c…
```

(Re-running it is safe — it keeps the same URL + key.)

### Option B — the Cloudflare dashboard (no terminal for the deploy)

1. **Sign in** at [dash.cloudflare.com](https://dash.cloudflare.com).
2. **Create storage:** Storage & Databases → **KV** → *Create a namespace* →
   name it `DECISIONS` → Add.
3. **Create the Worker:** Workers & Pages → *Create* → *Create Worker* → name it
   `swt-worker` → **Deploy**.
4. **Paste the code:** open the Worker → *Edit code* → delete the sample, paste
   the entire contents of [`worker/dist/worker.js`](worker/dist/worker.js) →
   **Deploy**.
5. **Bind the storage:** Worker → *Settings* → *Bindings* → *Add* → **KV
   namespace** → Variable name `DECISIONS`, namespace `DECISIONS` → Save.
6. **Add the key:** *Settings* → *Variables and Secrets* → *Add* → **Secret**,
   name `WRITE_KEY`, value = any long random string you make up → Save.
7. **Copy the Worker URL** (shown on the Worker's page, like
   `https://swt-worker.you.workers.dev`).

> Regenerate `worker/dist/worker.js` after changing the Worker source with
> `npm run bundle --workspace worker`.

## 3. Connect Safelight to it

In Safelight → **Preferences → Web Tools**: paste the **Worker URL** and the
**Write key**. The dot turns green ("Connected"). Optionally set your studio name
and which photos a gallery includes. Done.

---

## Using it

1. Flag your keepers in the Library (press **P**).
2. Open the **Web Tools** panel → choose **Proofing** or **Public**, type a title
   (+ client name for proofing) → **Publish**. A gallery covers the folder you're
   viewing, so each one maps to a single shoot.
3. Every gallery you publish is listed under **Your galleries**, grouped by
   folder, each with its **share link** — **Open** to preview, **Copy** to send,
   **Remove** to take it offline. Publish as many as you like; they stay live in
   parallel, so you can keep editing other folders while a client reviews.
4. The client picks/rejects and submits.
5. Their choices sync back into your Library automatically — each gallery is
   polled on its own, so decisions land whenever the client finishes, even hours
   later. The panel shows a per-gallery summary; the flags update.

**Image quality.** **Public** (portfolio) galleries are rendered through the full
develop pipeline at your **Export** resolution and quality (Preferences ▸ Export),
so they're full-resolution — not the low-res grid preview. **Proofing** galleries
use the fast catalog preview, which is all a pick/reject pass needs.

## Optional: email when a client decides

Add these to the Worker (Option A: `cd worker && npx wrangler secret put NAME`;
Option B: dashboard → Variables and Secrets): `RESEND_API_KEY`, `NOTIFY_EMAIL`,
`NOTIFY_FROM` (a verified [Resend](https://resend.com) sender).

## Optional: push to photo services (CLI)

A small CLI can push a published gallery's photos on to a photo service:

```
# put your Flickr API key/secret in cli/swt.config.local.json first
node cli/src/index.js login flickr
node cli/src/index.js push <projectId> --to flickr --album "Smith Wedding"
```

`<projectId>` is the id in the share link (`…/g/<projectId>`). The CLI pulls the
images from your Worker. Flickr is implemented; SmugMug/social are scaffolds.

## Privacy

Galleries are unlisted; proofing galleries also require a per-project token
(carried in the share link's `?t=`). The public gallery data never contains your
catalog ids or the token. Pages are `noindex`.

## Components

- **`extension/`** — the in-app extension (Cloudflare-only).
- **`worker/`** — the Cloudflare Worker (KV storage + gallery serving + submit/
  decision endpoints). `dist/worker.js` is the bundled single file for dashboard paste.
- **`scripts/deploy-worker.mjs`** — the one-command deploy (`npm run deploy-worker`).
- **`cli/`** — the optional photo-service push.
- **`shared/protocol.js`** — the `project` / `decision` schemas.
