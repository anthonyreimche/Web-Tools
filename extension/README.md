# Web Tools

Publish **proofing** and **public** photo galleries to the web, and pull the
client's picks/rejects back into Safelight.

Flag your selects, click **Publish**, and send the client a link. They review the
gallery — your picks already chosen — change whatever they like, and submit.
Their decision flows back into your Library as pick/reject flags, with an optional
email the moment they're done.

## Setup

Galleries live on **your own Cloudflare Worker** (free, no credit card). Deploy it
once — `npm run deploy-worker` in the Web Tools folder, or the manual dashboard
steps in the repo README — then in **Preferences → Web Tools** paste the **Worker
URL** and **Write key**. The status dot turns green and you're ready.

## Using it

1. Flag your picks (press **P**).
2. **Web Tools** panel → **Proofing** or **Public** → title (+ client) → **Publish**.
3. **Open** to preview or **Copy link** to send.
4. Client picks/rejects and submits; the flags update in your Library automatically.

## Settings (Preferences → Web Tools)

- **Worker URL / Write key** — from your deployed Worker.
- **Which photos** — your picks, the current selection, or all non-rejected.
- **Your name / studio** — shown on public galleries.
- **Image size / quality** — gallery image dimensions.

MIT licensed. Requires a deployed Cloudflare Worker (included in the repo).
