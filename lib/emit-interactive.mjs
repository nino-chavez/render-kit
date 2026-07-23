/**
 * interactive emitter — a self-hosted, self-contained click-through player.
 *
 * This is the canonical home for the click-through player; it retired forge-signal's
 * demo-reel generator (behavior-preserving — rally-hq's shipped players stay pixel-identical),
 * the only change being that it reads the shared render-kit manifest contract instead of a
 * private deck shape. No third-party at playback; regenerate whenever the UI changes.
 *
 * Each still shows a hotspot (a ring for element rects, a dot for point beats) and a caption,
 * advancing on click / arrow keys. Overlays are placed in the manifest's logical space and
 * scaled by CSS, so the player is DPI-agnostic and responsive.
 */
import { writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

/**
 * @param {ReturnType<import('./manifest.mjs').loadManifest>} manifest
 * @param {{ outDir:string, og?:{url?:string,image?:string,desc?:string,site?:string,title?:string} }} opts
 */
export function emitInteractive(manifest, { outDir, og = {} }) {
  const framesOut = join(outDir, 'frames')
  mkdirSync(framesOut, { recursive: true })

  // Copy stills next to index.html so the player is a portable, hostable folder.
  let copied = 0
  for (const step of manifest.steps) {
    const from = join(manifest.srcDir, step.frame)
    if (existsSync(from)) {
      copyFileSync(from, join(framesOut, step.frame))
      copied++
    }
  }

  const { title, width, height } = manifest

  // Open Graph / Twitter card — so a shared player link unfurls with a title + preview image.
  // Opt-in + host-agnostic: the caller passes the absolute URL and image (the hosting slug
  // differs from the capture label, so the emitter can't know them). Omitted when no og.url.
  const ogTitle = og.title || `${title} — Interactive demo`
  const ogTags = og.url
    ? `
<meta property="og:type" content="website" />${og.site ? `\n<meta property="og:site_name" content="${esc(og.site)}" />` : ''}
<meta property="og:title" content="${esc(ogTitle)}" />
<meta property="og:description" content="${esc(og.desc || '')}" />
<meta property="og:url" content="${esc(og.url)}" />
<meta property="og:image" content="${esc(og.image || '')}" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${esc(ogTitle)}" />
<meta name="twitter:description" content="${esc(og.desc || '')}" />
<meta name="twitter:image" content="${esc(og.image || '')}" />`
    : ''

  const DATA = JSON.stringify({
    width,
    height,
    title,
    steps: manifest.steps.map((s) => ({
      frame: `frames/${s.frame}`,
      kind: s.kind,
      caption: s.caption,
      hotspot: s.hotspot,
    })),
  })

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${title} — Interactive demo</title>${ogTags}
<style>
  :root { --gold:#f5b209; --ink:#111827; --paper:#0b0b0c; }
  * { box-sizing: border-box; }
  html,body { margin:0; height:100%; background:var(--paper); color:#fff;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  .wrap { min-height:100%; display:flex; align-items:center; justify-content:center; padding:24px; }
  .player { width:min(1100px, 100%); }
  /* Stage holds the still; everything is positioned in its ${width}x${height} space, scaled by CSS. */
  .stage { position:relative; width:100%; aspect-ratio:${width} / ${height};
    border-radius:14px; overflow:hidden; background:#000; cursor:pointer;
    box-shadow:0 18px 60px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.06); }
  .stage img { position:absolute; inset:0; width:100%; height:100%; object-fit:cover; display:block; }
  /* Hotspot ring — pulses to invite the click. Sized/placed from the captured rect. */
  .hotspot { position:absolute; border:2px solid var(--gold); border-radius:10px;
    box-shadow:0 0 0 4px rgba(245,178,9,.25); pointer-events:none;
    transition:all .25s cubic-bezier(.2,.7,.2,1); }
  .hotspot::after { content:""; position:absolute; inset:-6px; border-radius:12px;
    border:2px solid var(--gold); opacity:.7; animation:ping 1.4s cubic-bezier(0,0,.2,1) infinite; }
  @keyframes ping { 0%{transform:scale(.9);opacity:.8} 70%,100%{transform:scale(1.25);opacity:0} }
  .dot { position:absolute; width:18px; height:18px; margin:-9px 0 0 -9px; border-radius:50%;
    background:var(--gold); box-shadow:0 0 0 6px rgba(245,178,9,.25); pointer-events:none; }
  .dot::after { content:""; position:absolute; inset:0; border-radius:50%;
    box-shadow:0 0 0 2px var(--gold); animation:ping 1.4s cubic-bezier(0,0,.2,1) infinite; }
  /* Caption card — anchored near the hotspot, flips above/below to stay on screen. */
  .caption { position:absolute; max-width:340px; background:var(--gold); color:var(--ink);
    font-size:15px; line-height:1.4; font-weight:600; padding:12px 14px; border-radius:10px;
    box-shadow:0 8px 30px rgba(0,0,0,.4); pointer-events:none; transition:all .25s ease; }
  .controls { display:flex; align-items:center; gap:14px; margin-top:16px; }
  .bar { flex:1; height:6px; background:rgba(255,255,255,.12); border-radius:99px; overflow:hidden; }
  .bar > i { display:block; height:100%; width:0; background:var(--gold); transition:width .25s ease; }
  .btn { appearance:none; border:0; background:rgba(255,255,255,.1); color:#fff; cursor:pointer;
    font-size:14px; font-weight:600; padding:8px 14px; border-radius:8px; }
  .btn:hover { background:rgba(255,255,255,.18); }
  .btn[disabled] { opacity:.35; cursor:default; }
  .count { font-variant-numeric:tabular-nums; font-size:13px; color:#9ca3af; min-width:54px; text-align:center; }
  .title { font-size:13px; letter-spacing:.08em; text-transform:uppercase; color:#9ca3af; margin:0 0 10px; }
  .hint { text-align:center; font-size:12px; color:#6b7280; margin-top:10px; }
</style>
</head>
<body>
<div class="wrap"><div class="player">
  <p class="title">${title}</p>
  <div class="stage" id="stage">
    <img id="shot" alt="" />
    <div class="hotspot" id="ring" hidden></div>
    <div class="dot" id="dot" hidden></div>
    <div class="caption" id="cap" hidden></div>
  </div>
  <div class="controls">
    <button class="btn" id="prev">‹ Back</button>
    <div class="bar"><i id="fill"></i></div>
    <span class="count" id="count"></span>
    <button class="btn" id="next">Next ›</button>
  </div>
  <p class="hint">Click the screen to advance · ← → to step · R to replay</p>
</div></div>
<script>
const DATA = ${DATA};
const BASE_W = DATA.width, BASE_H = DATA.height;
const stage = document.getElementById('stage');
const shot = document.getElementById('shot');
const ring = document.getElementById('ring');
const dot = document.getElementById('dot');
const cap = document.getElementById('cap');
const fill = document.getElementById('fill');
const count = document.getElementById('count');
const prevBtn = document.getElementById('prev');
const nextBtn = document.getElementById('next');
const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
let i = 0;

function scale() { return stage.clientWidth / BASE_W; }

function placeOverlays() {
  const step = DATA.steps[i];
  const s = scale();
  const hs = step.hotspot;
  const hasRect = hs && hs.w > 0 && hs.h > 0;
  // Ring for element targets; a dot for coordinate/center beats.
  ring.hidden = !hasRect;
  dot.hidden = !(hs && !hasRect);
  if (hasRect) {
    const pad = 8;
    ring.style.left = ((hs.x - hs.w / 2) * s - pad) + 'px';
    ring.style.top = ((hs.y - hs.h / 2) * s - pad) + 'px';
    ring.style.width = (hs.w * s + pad * 2) + 'px';
    ring.style.height = (hs.h * s + pad * 2) + 'px';
  } else if (hs) {
    dot.style.left = (hs.x * s) + 'px';
    dot.style.top = (hs.y * s) + 'px';
  }
  // Caption: anchored near the hotspot, flipped + clamped to stay inside the stage.
  if (step.caption) {
    cap.hidden = false;
    cap.textContent = step.caption;
    const anchorX = (hs ? hs.x : BASE_W / 2) * s;
    const anchorY = (hs ? hs.y : BASE_H / 2) * s;
    const below = anchorY < stage.clientHeight * 0.5;
    requestAnimationFrame(() => {
      const ch = cap.offsetHeight, cw = cap.offsetWidth;
      const offset = hasRect ? (hs.h * s) / 2 + 16 : 22;
      cap.style.left = clamp(anchorX - 40, 12, stage.clientWidth - cw - 12) + 'px';
      cap.style.top = clamp(below ? anchorY + offset : anchorY - offset - ch, 12, stage.clientHeight - ch - 12) + 'px';
    });
  } else {
    cap.hidden = true;
  }
}

function render() {
  shot.src = DATA.steps[i].frame;
  placeOverlays();
  count.textContent = (i + 1) + ' / ' + DATA.steps.length;
  fill.style.width = (((i + 1) / DATA.steps.length) * 100) + '%';
  prevBtn.disabled = i === 0;
  nextBtn.textContent = i === DATA.steps.length - 1 ? 'Replay ↻' : 'Next ›';
}

function go(n) { i = (n + DATA.steps.length) % DATA.steps.length; render(); }
function next() { i >= DATA.steps.length - 1 ? go(0) : go(i + 1); }

stage.addEventListener('click', next);
nextBtn.addEventListener('click', next);
prevBtn.addEventListener('click', () => go(i - 1));
window.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); next(); }
  else if (e.key === 'ArrowLeft') go(i - 1);
  else if (e.key.toLowerCase() === 'r') go(0);
});
window.addEventListener('resize', placeOverlays);
shot.addEventListener('load', placeOverlays);
render();
</script>
</body>
</html>
`

  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'index.html'), html)
  return { indexPath: join(outDir, 'index.html'), steps: manifest.steps.length, copied }
}
