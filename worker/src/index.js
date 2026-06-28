// Safelight Web Tools — Cloudflare Worker (all-in-one gallery backend).
//
// The Safelight extension talks to this Worker DIRECTLY (the app's CSP allows
// the Worker origin), so there is no local helper, folder, or wrangler step.
// Deploy once with `npm run deploy-worker`; everything else happens in the app.
//
// Storage:  KV binding DECISIONS holds everything — manifests (pj:), tokens
//           (proj:), decisions (decision:), and images (img/...). KV alone means
//           no R2 bucket and no payment method on the Cloudflare account.
// Secrets:  WRITE_KEY (the extension's upload/read key), and optional
//           RESEND_API_KEY / NOTIFY_EMAIL / NOTIFY_FROM for email.
//
// Routes:
//   PUT  /project/:id      (write key) store the project + token + meta
//   PUT  /img/:id/:photo   (write key) store an image  (?v=thumb for the thumb)
//   GET  /g/:id            serve the gallery page (?t=<token>)
//   GET  /pj/:id           sanitized public manifest (no token/catalogId)
//   GET  /img/:id/:photo   stream an image  (?v=thumb)
//   POST /submit           client decision  (per-project token)
//   GET  /decision/:id     (write key) latest decision  ← extension polls this
//   DELETE /g/:id          (write key) unpublish
//   GET  /health

import { validateDecision } from "../../shared/protocol.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
};
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json", ...CORS } });
const writeOk = (req, env) => {
  const a = req.headers.get("Authorization") || "";
  const k = a.startsWith("Bearer ") ? a.slice(7) : "";
  return env.WRITE_KEY && k && k === env.WRITE_KEY;
};

function sanitize(project) {
  return {
    schema: project.schema, projectId: project.projectId, kind: project.kind,
    title: project.title, photographer: project.photographer || "",
    client: project.client && project.client.name ? { name: project.client.name } : {},
    photos: (project.photos || []).map((p) => ({
      photoId: p.photoId, filename: p.filename, width: p.width, height: p.height, prePick: p.prePick || "none",
    })),
  };
}

async function notify(env, meta, decision) {
  if (!env.RESEND_API_KEY || !env.NOTIFY_EMAIL || !env.NOTIFY_FROM) return;
  const c = decision.decisions.reduce((a, d) => ((a[d.pick] = (a[d.pick] || 0) + 1), a), {});
  const who = (decision.client && decision.client.name) || "A client";
  const title = (meta && meta.title) || decision.projectId;
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: env.NOTIFY_FROM, to: env.NOTIFY_EMAIL,
        subject: `Proofing: ${who} decided on "${title}"`,
        text: `${who} submitted their selection for "${title}".\n\nPicks: ${c.pick || 0}  Rejects: ${c.reject || 0}  Unset: ${c.none || 0}\n${decision.note ? `\nNote: ${decision.note}\n` : ""}\nProject: ${decision.projectId}\n` }),
    });
  } catch { /* best-effort */ }
}

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    const p = url.pathname.split("/").filter(Boolean);

    if (p[0] === "health") return json({ ok: true });

    // PUT /project/:id — store project, token, meta (extension, write key).
    if (req.method === "PUT" && p[0] === "project" && p[1]) {
      if (!writeOk(req, env)) return json({ error: "unauthorized" }, 401);
      let body; try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
      const project = body.project || body;
      const id = p[1];
      await env.DECISIONS.put(`pj:${id}`, JSON.stringify(sanitize(project)));
      if (project.token) await env.DECISIONS.put(`proj:${id}:token`, String(project.token));
      await env.DECISIONS.put(`proj:${id}:meta`, JSON.stringify({
        title: project.title, photographer: project.photographer || "",
        clientEmail: (project.client && project.client.email) || "",
      }));
      return json({ ok: true, projectId: id });
    }

    // PUT /img/:id/:photo[?v=thumb] — store an image in KV (extension, write key).
    if (req.method === "PUT" && p[0] === "img" && p[1] && p[2]) {
      if (!writeOk(req, env)) return json({ error: "unauthorized" }, 401);
      const variant = url.searchParams.get("v") === "thumb" ? ".thumb" : "";
      await env.DECISIONS.put(`img/${p[1]}/${p[2]}${variant}`, await req.arrayBuffer());
      return json({ ok: true });
    }

    // GET /img/:id/:photo[?v=thumb] — serve an image from KV.
    if (req.method === "GET" && p[0] === "img" && p[1] && p[2]) {
      const variant = url.searchParams.get("v") === "thumb" ? ".thumb" : "";
      const buf = await env.DECISIONS.get(`img/${p[1]}/${p[2]}${variant}`, "arrayBuffer");
      if (!buf) return new Response("not found", { status: 404, headers: CORS });
      return new Response(buf, { headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=3600", ...CORS } });
    }

    // GET /pj/:id — sanitized public manifest.
    if (req.method === "GET" && p[0] === "pj" && p[1]) {
      const raw = await env.DECISIONS.get(`pj:${p[1]}`);
      if (!raw) return json({ error: "not found" }, 404);
      return new Response(raw, { headers: { "Content-Type": "application/json", ...CORS } });
    }

    // GET /g/:id — gallery page.
    if (req.method === "GET" && p[0] === "g" && p[1]) {
      const exists = await env.DECISIONS.get(`pj:${p[1]}`);
      if (!exists) return new Response("Gallery not found.", { status: 404, headers: { "Content-Type": "text/html" } });
      return new Response(galleryHtml(p[1]), { headers: { "Content-Type": "text/html; charset=utf-8", "X-Robots-Tag": "noindex" } });
    }

    // POST /submit — client decision (per-project token).
    if (req.method === "POST" && p[0] === "submit") {
      let body; try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
      const { projectId, token } = body || {};
      if (!projectId || !token) return json({ error: "projectId and token required" }, 400);
      const expected = await env.DECISIONS.get(`proj:${projectId}:token`);
      if (!expected || token !== expected) return json({ error: "invalid token" }, 403);
      const decision = {
        schema: "swt.decision/1", projectId, submittedAt: new Date().toISOString(),
        client: body.client || {}, note: typeof body.note === "string" ? body.note.slice(0, 2000) : "",
        decisions: Array.isArray(body.decisions) ? body.decisions : [],
      };
      if (validateDecision(decision).length) return json({ error: "invalid decision" }, 400);
      await env.DECISIONS.put(`decision:${projectId}`, JSON.stringify(decision));
      const metaRaw = await env.DECISIONS.get(`proj:${projectId}:meta`);
      await notify(env, metaRaw ? JSON.parse(metaRaw) : {}, decision);
      return json({ ok: true });
    }

    // GET /decision/:id — extension polls this (write key).
    if (req.method === "GET" && p[0] === "decision" && p[1]) {
      if (!writeOk(req, env)) return json({ error: "unauthorized" }, 401);
      const raw = await env.DECISIONS.get(`decision:${p[1]}`);
      if (!raw) return json({ error: "no decision yet" }, 404);
      return new Response(raw, { headers: { "Content-Type": "application/json", ...CORS } });
    }

    // DELETE /g/:id — unpublish (write key).
    if (req.method === "DELETE" && p[0] === "g" && p[1]) {
      if (!writeOk(req, env)) return json({ error: "unauthorized" }, 401);
      const id = p[1];
      await env.DECISIONS.delete(`pj:${id}`);
      await env.DECISIONS.delete(`proj:${id}:token`);
      await env.DECISIONS.delete(`proj:${id}:meta`);
      await env.DECISIONS.delete(`decision:${id}`);
      const list = await env.DECISIONS.list({ prefix: `img/${id}/` });
      await Promise.all(list.keys.map((k) => env.DECISIONS.delete(k.name)));
      return json({ ok: true });
    }

    return json({ error: "not found" }, 404);
  },
};

// Self-contained gallery page. Fetches /pj/:id, renders a grid + lightbox, and
// (proofing) tri-state pick/reject toggles pre-set from prePick. Submits to
// /submit (same origin). Images come from /img/:id/:photoId.
function galleryHtml(id) {
  return `<!doctype html><html lang=en><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1"><meta name=robots content="noindex">
<title>Gallery</title><style>
:root{--bg:#14161a;--s:#1d2026;--s2:#262a32;--b:#343a44;--t:#e8eaed;--m:#9aa3af;--pick:#3fb950;--rej:#f0506e;--a:#4d8dff}
*{box-sizing:border-box}body{margin:0;font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--t);padding-bottom:120px}
.top{position:sticky;top:0;z-index:5;display:flex;justify-content:space-between;align-items:center;gap:16px;padding:14px 20px;background:rgba(20,22,26,.92);border-bottom:1px solid var(--b)}
.top h1{font-size:18px;margin:0}.muted{color:var(--m)}.counts{display:flex;gap:14px;white-space:nowrap}.counts b{font-variant-numeric:tabular-nums}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px;padding:18px 20px}
.card{background:var(--s);border:2px solid var(--b);border-radius:8px;overflow:hidden}.card.pick{border-color:var(--pick)}.card.reject{border-color:var(--rej);opacity:.7}
.card img{width:100%;aspect-ratio:3/2;object-fit:contain;display:block;background:var(--s2);cursor:zoom-in}
.acts{display:flex}.acts button{flex:1;padding:9px;border:none;cursor:pointer;background:var(--s2);color:var(--m);font-weight:600;border-top:1px solid var(--b)}
.acts button+button{border-left:1px solid var(--b)}.acts .p.on{background:var(--pick);color:#06210f}.acts .r.on{background:var(--rej);color:#2c0710}
.bar{position:fixed;bottom:0;left:0;right:0;z-index:6;display:flex;flex-direction:column;gap:8px;padding:12px 20px;background:rgba(20,22,26,.96);border-top:1px solid var(--b)}
.bar textarea{width:100%;background:var(--s);color:var(--t);border:1px solid var(--b);border-radius:6px;padding:8px;font:inherit}
.brow{display:flex;justify-content:flex-end;align-items:center;gap:14px}button.go{background:var(--a);color:#fff;border:none;border-radius:6px;padding:10px 20px;font-weight:600;cursor:pointer}button.go:disabled{opacity:.5}
.lb{position:fixed;inset:0;z-index:20;background:rgba(8,10,13,.92);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);overscroll-behavior:contain;touch-action:none}.lb.hide{display:none}
.lbstage{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;overflow:hidden}
.lb img{max-width:94vw;max-height:86vh;object-fit:contain;border-radius:8px;box-shadow:0 16px 50px rgba(0,0,0,.55);will-change:transform,opacity;user-select:none;-webkit-user-drag:none}.lb.proof img{max-height:70vh}
.lbtop{position:absolute;top:0;left:0;right:0;display:flex;align-items:center;gap:12px;padding:14px 16px;z-index:24;background:linear-gradient(rgba(0,0,0,.5),transparent)}
.lbtop .cnt{font-variant-numeric:tabular-nums;font-size:13px;font-weight:600;color:#fff}.lbtop .fn{flex:1;font-size:12px;color:rgba(255,255,255,.6);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.lb button{color:#fff;border:none;cursor:pointer;background:none}
.iconbtn{width:40px;height:40px;border-radius:50%;background:rgba(255,255,255,.14);display:flex;align-items:center;justify-content:center;font-size:18px;line-height:1;transition:background .15s,transform .12s}.iconbtn:hover{background:rgba(255,255,255,.26)}.iconbtn:active{transform:scale(.9)}
.nav{position:absolute;top:50%;transform:translateY(-50%);width:46px;height:46px;border-radius:50%;background:rgba(0,0,0,.45);color:#fff;display:flex;align-items:center;justify-content:center;font-size:26px;z-index:23;text-shadow:0 1px 3px rgba(0,0,0,.6);transition:background .15s,opacity .2s}.nav:hover{background:rgba(0,0,0,.65)}.pv{left:14px}.nx{right:14px}
.lb.touch .nav{display:none}
.cue{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%) scale(.9);display:flex;flex-direction:column;align-items:center;gap:4px;min-width:128px;padding:20px;border-radius:20px;font-size:16px;font-weight:700;letter-spacing:.04em;opacity:0;pointer-events:none;z-index:25;box-shadow:0 10px 36px rgba(0,0,0,.45);transition:opacity .12s ease,transform .12s ease}
.cue .ic{font-size:42px;line-height:1}.cue.pick{color:#06210f;background:var(--pick)}.cue.reject{color:#2c0710;background:var(--rej)}
.lbbtm{position:absolute;left:0;right:0;bottom:0;z-index:24;display:none;flex-direction:column;align-items:center;gap:12px;padding:16px 16px calc(18px + env(safe-area-inset-bottom));background:linear-gradient(transparent,rgba(0,0,0,.55))}.lb.proof .lbbtm,.lb.touch .lbbtm{display:flex}
.lhint{font-size:12px;color:rgba(255,255,255,.6);pointer-events:none;display:none}.lb.touch .lhint{display:block}
.lacts{display:none;gap:12px}.lb.proof .lacts{display:flex}
.lacts button{display:flex;align-items:center;gap:7px;padding:12px 26px;border-radius:30px;font-size:15px;font-weight:600;color:#fff;background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.22);transition:transform .12s,background .15s,border-color .15s}.lacts button:active{transform:scale(.93)}
.lacts .lp.on{background:var(--pick);color:#06210f;border-color:var(--pick)}.lacts .lr.on{background:var(--rej);color:#2c0710;border-color:var(--rej)}
@media (max-width:600px){.grid{grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;padding:12px}.top{padding:12px 14px;flex-wrap:wrap;gap:4px 12px}.top>div:first-child{flex:1 1 100%}.top h1{font-size:16px}.counts{font-size:12px;gap:10px}.acts button{padding:12px 8px}.bar{padding:10px 14px}.lb img{max-width:90vw}.lacts button{padding:13px 30px}}
</style></head><body>
<div class=top><div><h1 id=title>Gallery</h1><p id=sub class=muted></p></div><div class=counts id=counts></div></div>
<div class=grid id=grid></div>
<div class=bar id=bar><textarea id=note rows=2 placeholder="Notes for the photographer (optional)…"></textarea><div class=brow><span id=status class=muted></span><button class=go id=go>Submit my selection</button></div></div>
<div class="lb hide" id=lb><div class=lbtop><span class=cnt id=lcnt></span><span class=fn id=lfn></span><button class=iconbtn id=x aria-label=Close>✕</button></div><div class=lbstage id=lstage><button class="nav pv" id=pv aria-label=Previous>‹</button><img id=lbi alt=""><button class="nav nx" id=nx aria-label=Next>›</button><div class="cue pick" id=cuePick><span class=ic>✓</span>Pick</div><div class="cue reject" id=cueReject><span class=ic>✗</span>Reject</div></div><div class=lbbtm><div class=lhint id=lhint>Swipe ↑ Pick · ↓ Reject · ← → Browse</div><div class=lacts id=lacts><button class=lp id=lp><span>✓</span> Pick</button><button class=lr id=lr><span>✗</span> Reject</button></div></div></div>
<script>
var ID=${JSON.stringify(id)},T=new URLSearchParams(location.search).get("t")||"";
var P=null,pub=false,ch={},li=-1,$=function(i){return document.getElementById(i)};
var TOUCH=("ontouchstart" in window)||navigator.maxTouchPoints>0;
function img(pid,v){return "/img/"+ID+"/"+pid+(v?"?v=thumb":"")}
fetch("/pj/"+ID).then(function(r){return r.json()}).then(function(p){P=p;pub=p.kind==="public";
 document.title=p.title||"Gallery";$("title").textContent=p.title||"Gallery";$("sub").textContent=p.photographer?"by "+p.photographer:"";
 if(pub){$("bar").style.display="none";document.body.style.paddingBottom="20px"}else{$("lb").classList.add("proof")}
 if(TOUCH)$("lb").classList.add("touch");
 $("lhint").textContent=pub?"Swipe ← → to browse":"Swipe ↑ Pick · ↓ Reject · ← → Browse";
 var sv=null;try{sv=JSON.parse(localStorage.getItem("swt:"+ID)||"null")}catch(e){}
 p.photos.forEach(function(ph){ch[ph.photoId]=(sv&&sv[ph.photoId])||ph.prePick||"none"});render()});
function persist(){try{localStorage.setItem("swt:"+ID,JSON.stringify(ch))}catch(e){}}
function set(pid,v){ch[pid]=ch[pid]===v?"none":v;persist();card(pid);counts();if(li>=0&&P.photos[li].photoId===pid)lba()}
function card(pid){var c=document.querySelector('[data-c="'+pid+'"]');if(!c||pub)return;var v=ch[pid];c.className="card"+(v==="pick"?" pick":v==="reject"?" reject":"");c.querySelector(".p").classList.toggle("on",v==="pick");c.querySelector(".r").classList.toggle("on",v==="reject")}
function counts(){if(pub){$("counts").innerHTML='<span class=muted>'+P.photos.length+" photos</span>";return}var pk=0,rj=0;Object.keys(ch).forEach(function(k){if(ch[k]==="pick")pk++;else if(ch[k]==="reject")rj++});$("counts").innerHTML='<span style="color:var(--pick)">Picks <b>'+pk+'</b></span><span style="color:var(--rej)">Rejects <b>'+rj+'</b></span><span class=muted>of '+P.photos.length+"</span>"}
function btn(cl,tx,pid,v){var b=document.createElement("button");b.className=cl;b.textContent=tx;b.onclick=function(){set(pid,v)};return b}
function render(){var g=$("grid");g.innerHTML="";P.photos.forEach(function(ph,i){var c=document.createElement("div");c.setAttribute("data-c",ph.photoId);var im=document.createElement("img");im.loading="lazy";im.src=img(ph.photoId,1);im.onclick=function(){open(i)};c.appendChild(im);if(!pub){var a=document.createElement("div");a.className="acts";a.appendChild(btn("p","✓ Pick",ph.photoId,"pick"));a.appendChild(btn("r","✗ Reject",ph.photoId,"reject"));c.appendChild(a)}g.appendChild(c);card(ph.photoId)});counts()}
var img0,stage,SX=0,SY=0,dx=0,dy=0,axis=null,drag=false;
var DEAD=10,HT=70,VT=90; // deadzone, horizontal/vertical commit thresholds (px)
function setLbInfo(){$("lcnt").textContent=(li+1)+" / "+P.photos.length;$("lfn").textContent=P.photos[li].filename||""}
function setT(x,y,t){img0.style.transition=t?"transform .25s cubic-bezier(.2,.7,.3,1),opacity .25s ease":"none";img0.style.transform="translate("+x+"px,"+y+"px)"}
function resetCues(){$("cuePick").style.opacity=0;$("cueReject").style.opacity=0;$("pv").style.opacity="";$("nx").style.opacity=""}
function dragCues(){if(!pub&&axis==="v"){$("cuePick").style.opacity=Math.min(1,Math.max(0,-dy)/VT);$("cueReject").style.opacity=Math.min(1,Math.max(0,dy)/VT)}if(axis==="h"){$("pv").style.opacity=dx>0?String(.4+Math.min(.6,dx/HT)):"";$("nx").style.opacity=dx<0?String(.4+Math.min(.6,-dx/HT)):""}}
function flashCue(kind){var el=$(kind==="pick"?"cuePick":"cueReject");el.style.opacity="1";el.style.transform="translate(-50%,-50%) scale(1.12)";setTimeout(function(){el.style.opacity="0";el.style.transform="translate(-50%,-50%) scale(.9)"},300);setT(0,0,true)}
function commitNav(dir){var w=window.innerWidth;img0.style.transition="transform .16s ease,opacity .16s ease";img0.style.transform="translate("+(dir==="nx"?-w*0.4:w*0.4)+"px,0)";img0.style.opacity="0";setTimeout(function(){if(dir==="nx")$("nx").onclick();else $("pv").onclick()},150)}
function open(i){li=i;img0=img0||$("lbi");setT(0,0,false);img0.style.opacity="0";img0.onload=function(){img0.style.transition="opacity .22s ease";img0.style.opacity="1"};img0.src=img(P.photos[i].photoId);if(img0.complete)img0.style.opacity="1";resetCues();$("lb").classList.remove("hide");document.body.style.overflow="hidden";setLbInfo();lba()}
function closeLb(){li=-1;$("lb").classList.add("hide");document.body.style.overflow="";resetCues()}
function lba(){if(pub||li<0)return;var v=ch[P.photos[li].photoId];$("lp").classList.toggle("on",v==="pick");$("lr").classList.toggle("on",v==="reject")}
function decide(pid,v){ch[pid]=v;persist();card(pid);counts();if(li>=0&&P.photos[li].photoId===pid)lba()}
$("x").onclick=closeLb;
$("pv").onclick=function(){if(li>=0)open((li-1+P.photos.length)%P.photos.length)};
$("nx").onclick=function(){if(li>=0)open((li+1)%P.photos.length)};
$("lp").onclick=function(){if(li>=0)set(P.photos[li].photoId,"pick")};
$("lr").onclick=function(){if(li>=0)set(P.photos[li].photoId,"reject")};
// Interactive lightbox drag: one finger moves the photo — horizontal browses,
// vertical picks/rejects (proofing). Cues fade in live; past the threshold the
// action commits, otherwise the photo springs back. Two-finger gestures are left
// alone so pinch-zoom still works.
stage=$("lstage");
stage.addEventListener("touchstart",function(e){if(li<0||e.touches.length!==1)return;drag=true;axis=null;dx=dy=0;SX=e.touches[0].clientX;SY=e.touches[0].clientY},{passive:true});
stage.addEventListener("touchmove",function(e){if(!drag||e.touches.length!==1)return;dx=e.touches[0].clientX-SX;dy=e.touches[0].clientY-SY;if(!axis){if(Math.abs(dx)>DEAD||Math.abs(dy)>DEAD)axis=Math.abs(dx)>Math.abs(dy)?"h":"v";else return}e.preventDefault();setT(axis==="h"?dx:0,axis==="v"&&!pub?dy:0,false);dragCues()},{passive:false});
stage.addEventListener("touchend",function(){if(!drag)return;drag=false;var done=false;if(axis==="h"){if(dx<=-HT){commitNav("nx");done=true}else if(dx>=HT){commitNav("pv");done=true}}else if(axis==="v"&&!pub){if(dy<=-VT){flashCue("pick");decide(P.photos[li].photoId,"pick");done=true}else if(dy>=VT){flashCue("reject");decide(P.photos[li].photoId,"reject");done=true}}if(!done){resetCues();setT(0,0,true)}axis=null},{passive:true});
document.onkeydown=function(e){if($("lb").classList.contains("hide"))return;if(e.key==="Escape")closeLb();else if(e.key==="ArrowLeft")$("pv").onclick();else if(e.key==="ArrowRight")$("nx").onclick();else if(!pub&&e.key==="ArrowUp"){e.preventDefault();flashCue("pick");decide(P.photos[li].photoId,"pick")}else if(!pub&&e.key==="ArrowDown"){e.preventDefault();flashCue("reject");decide(P.photos[li].photoId,"reject")}};
$("go").onclick=function(){if(!T){$("status").textContent="Missing access token in the link.";return}var b=$("go");b.disabled=true;$("status").textContent="Submitting…";
 fetch("/submit",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({projectId:ID,token:T,note:$("note").value||"",client:P.client||{},decisions:P.photos.map(function(ph){return{photoId:ph.photoId,pick:ch[ph.photoId]||"none"}})})}).then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j}})}).then(function(x){if(x.ok&&x.j.ok){document.body.innerHTML='<div style="max-width:520px;margin:18vh auto;text-align:center;padding:0 20px"><h1>Thank you!</h1><p class=muted>Your selection was sent. You can revisit this link to change it and resubmit.</p></div>'}else{$("status").textContent="Could not submit: "+((x.j&&x.j.error)||"error");b.disabled=false}}).catch(function(){$("status").textContent="Network error.";b.disabled=false})};
</script></body></html>`;
}
