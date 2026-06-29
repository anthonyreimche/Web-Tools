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
   A gallery covers the folder you're viewing, so each maps to one shoot.
3. Each gallery appears under **Your galleries** (grouped by folder) with its link —
   **Open** to preview, **Copy** to send, **Remove** to take it offline. Several can
   be live at once, so keep editing other folders while a client reviews.
4. Client picks/rejects and submits; the flags update in your Library automatically,
   per gallery, whenever they finish.

**Public** galleries are rendered at your Export resolution/quality (Preferences ▸
Export); **proofing** galleries use the fast catalog preview.

## Settings (Preferences → Web Tools)

- **Worker URL / Write key** — from your deployed Worker.
- **Which photos** — your picks, the current selection, or all non-rejected.
- **Your name / studio** — shown on public galleries.
- **Image size / quality** — the proofing image size, and the cap for a public
  gallery when Export is set to "Original".

MIT licensed. Requires a deployed Cloudflare Worker (included in the repo).
