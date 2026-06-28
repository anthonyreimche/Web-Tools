// Social-media adapters (Phase 4) — scaffolds behind the same { login, push }
// interface as the photo services. These are intentionally stubs: the blocker
// for each is app registration + review, not the upload code. The notes capture
// exactly what each platform needs so they can be filled in when you have an app.
//
// All share the project's web/<photoId>.jpg images and the project title/caption.

const NOTES = {
  x: {
    label: "X (Twitter)",
    auth: "OAuth 2.0 PKCE (user context). Requires a paid API tier for media posting.",
    upload: "POST media to v1.1 media/upload (chunked), then POST /2/tweets with media.media_ids.",
    review: "Developer account + project/app with write scope; Basic tier or higher.",
  },
  instagram: {
    label: "Instagram",
    auth: "Instagram Graph API (Facebook Login). Business/Creator account linked to a FB Page.",
    upload: "Create a media container (image_url must be a PUBLIC URL — e.g. the deployed gallery image), then publish.",
    review: "Meta app + App Review for instagram_content_publish; weeks of lead time.",
  },
  facebook: {
    label: "Facebook",
    auth: "Facebook Graph API, Page access token.",
    upload: "POST to /{page-id}/photos with url or source.",
    review: "Meta app + pages_manage_posts permission + App Review.",
  },
  behance: {
    label: "Behance",
    auth: "Behance API.",
    upload: "Project publishing endpoints.",
    review: "Behance closed its public API to new keys; no adapter is possible without access.",
  },
};

function socialScaffold(id) {
  const n = NOTES[id];
  const msg =
    `${n.label} is scaffolded but not yet wired up.\n` +
    `  Auth:   ${n.auth}\n  Upload: ${n.upload}\n  Needs:  ${n.review}\n` +
    `  For Instagram/Facebook the image must be a public URL — publish a 'public' gallery first and point the adapter at those image URLs.`;
  return {
    id, label: n.label,
    async login() { throw new Error(msg); },
    async push() { throw new Error(msg); },
  };
}

export const SOCIAL = {
  x: socialScaffold("x"),
  instagram: socialScaffold("instagram"),
  facebook: socialScaffold("facebook"),
  behance: socialScaffold("behance"),
};
