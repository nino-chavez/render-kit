/**
 * video emitter — motion over the captured stills, no live app, no HyperFrames.
 *
 * The mechanism is the same one HyperFrames uses and that any deterministic renderer can:
 * author a composition whose timeline is a pure function of a normalized progress `p`, then
 * a real headless browser SEEKS that timeline to N points per second and screenshots each —
 * so every frame is an exact, reproducible state, never a live recording. The frames are
 * ffmpeg-encoded into an mp4.
 *
 * One clip per step (hard cuts, matching the demo-reel pipeline this supersedes); the motion
 * WITHIN each step — a legible push toward the target, a spotlight dim, a caption reveal, a
 * click ripple — is what carries it. Silent by design: narration is the marketing-video lane.
 *
 * Writes `<name>.timeline.json` beside the mp4: each step's start, duration and frame range.
 */
import { chromium } from 'playwright'
import { pathToFileURL } from 'node:url'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { hotspotToMotion, hotspotToCanvas, motionForCanvas } from './hotspot-motion.mjs'
import { planTimeline } from './video-timeline.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const TEMPLATE = join(HERE, '..', 'templates', 'walkthrough', 'motion.html')
const PORTRAIT_TEMPLATE = join(HERE, '..', 'templates', 'walkthrough', 'motion-portrait.html')
const TOKEN_PLACEHOLDER = '/*WALKTHROUGH-TOKENS*/'

// --tokens accepts a JSON object of bare custom-property names ({"wt-accent": "#4d465f"}) or a
// raw CSS declaration list ("--wt-accent: #4d465f;"). Either way it's inserted at
// TOKEN_PLACEHOLDER, in a :root block that comes AFTER the template's own defaults, so the
// later declaration wins the cascade without editing the template's default block.
function readTokens(tokensPath) {
  const raw = readFileSync(tokensPath, 'utf8')
  const trimmed = raw.trim()
  if (trimmed.startsWith('{')) {
    const obj = JSON.parse(trimmed)
    return Object.entries(obj)
      .map(([k, v]) => `--${k.replace(/^--/, '')}: ${v};`)
      .join(' ')
  }
  return trimmed
}

/** `out/name.mp4` → `out/name.timeline.json`, beside the video it describes. */
export function timelinePathFor(out) {
  return out.replace(/\.[^./\\]+$/, '') + '.timeline.json'
}

/**
 * @param {ReturnType<import('./manifest.mjs').loadManifest>} manifest
 * @param {{ out:string, fps?:number, scale?:number, canvasW?:number, canvasH?:number }} opts
 */
export async function emitVideo(manifest, opts) {
  const out = opts.out
  const fps = opts.fps || 30
  const scale = opts.scale || 1
  const canvasW = opts.canvasW || manifest.width
  const canvasH = opts.canvasH || manifest.height

  if (!hasFfmpeg()) {
    throw new Error('ffmpeg not found on PATH — required to encode the video (brew install ffmpeg)')
  }

  // An app may supply its own motion template (brand type, caption layout) as long as it
  // keeps the same seek interface: reads window.RENDER_DATA, exposes window.__seek(p) and
  // window.__ready. Default is the shared templates/walkthrough/motion.html.
  // `--template portrait` selects the stock phone-tutorial look by name; anything else is
  // still treated as a path, so the default (no --template, no --tokens) code path is
  // byte-for-byte unchanged.
  const templatePath = opts.template === 'portrait' ? PORTRAIT_TEMPLATE : (opts.template || TEMPLATE)
  let template = readFileSync(templatePath, 'utf8')
  if (opts.tokens) {
    if (!template.includes(TOKEN_PLACEHOLDER)) {
      throw new Error(
        `--tokens was given but ${templatePath} has no ${TOKEN_PLACEHOLDER} placeholder to fill — ` +
        `tokens would silently do nothing (the stock templates/walkthrough/motion.html has none)`
      )
    }
    template = template.replace(TOKEN_PLACEHOLDER, readTokens(opts.tokens))
  }
  // Timing is planned once, up front: the frame loop renders it and the sidecar records it.
  const timeline = planTimeline(manifest.steps, fps)
  const tmpDir = join(dirname(out), `_rk_video_tmp_${manifest.label}`)
  const framesDir = join(tmpDir, 'frames')
  mkdirSync(framesDir, { recursive: true })

  const browser = await chromium.launch()
  let frameNo = 0
  try {
    const page = await browser.newPage({
      viewport: { width: canvasW, height: canvasH },
      deviceScaleFactor: scale,
    })

    for (let si = 0; si < manifest.steps.length; si++) {
      const step = manifest.steps[si]
      const frameSize = { width: manifest.width, height: manifest.height }
      const canvasSize = { width: canvasW, height: canvasH }
      // `motion` stays in logical percent: right for a template that fits the still into a box of
      // the still's own aspect (motion-portrait.html) and for existing custom templates.
      // `coverMotion` / `hotspotCanvas` are for a template whose still fills the whole canvas with
      // object-fit: cover (motion.html), where a differing aspect crops and shifts the target.
      const motion = hotspotToMotion(step.hotspot, step.kind, frameSize)
      const coverMotion = motionForCanvas(step.hotspot, step.kind, frameSize, canvasSize)
      const hotspotCanvas = hotspotToCanvas(step.hotspot, frameSize, canvasSize)
      const stillUrl = pathToFileURL(join(manifest.srcDir, step.frame)).href
      const stepData = {
        frame: stillUrl,
        caption: step.caption,
        hotspot: step.hotspot,
        motion,
        coverMotion,
        hotspotCanvas,
        width: manifest.width,
        height: manifest.height,
        canvasW,
        canvasH,
        // For templates that show progress or a title; the default template ignores them.
        stepIndex: si,
        stepCount: manifest.steps.length,
        title: manifest.title,
      }

      const html = template.replace(
        '</head>',
        `<script>window.RENDER_DATA = ${JSON.stringify(stepData)};</script></head>`
      )
      const tmpHtml = join(tmpDir, `step-${si}.html`)
      writeFileSync(tmpHtml, html)

      await page.goto(pathToFileURL(tmpHtml).href, { waitUntil: 'networkidle' })
      await page.evaluate(() => window.__ready)

      const totalFrames = timeline.steps[si].frames
      for (let f = 0; f < totalFrames; f++) {
        const p = totalFrames === 1 ? 1 : f / (totalFrames - 1)
        await page.evaluate((prog) => window.__seek(prog), p)
        await page.screenshot({
          path: join(framesDir, String(frameNo).padStart(6, '0') + '.png'),
          clip: { x: 0, y: 0, width: canvasW, height: canvasH },
        })
        frameNo++
      }
      // eslint-disable-next-line no-console
      console.log(`  step ${si + 1}/${manifest.steps.length} — ${totalFrames} frames (${step.kind})`)
    }
    await page.close()
  } finally {
    await browser.close()
  }

  mkdirSync(dirname(out), { recursive: true })
  execFileSync(
    'ffmpeg',
    ['-y', '-framerate', String(fps), '-i', join(framesDir, '%06d.png'),
     '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out],
    { stdio: ['ignore', 'ignore', 'inherit'] }
  )
  rmSync(tmpDir, { recursive: true, force: true })

  if (frameNo !== timeline.frames) {
    throw new Error(`rendered ${frameNo} frames but the timeline planned ${timeline.frames} — sidecar would be wrong`)
  }
  // Sidecar: where each step starts and ends in the mp4, so a downstream composition can place
  // sound or captions against real step boundaries instead of re-deriving them (clips.json is
  // the same idea for cut clips).
  const timelinePath = timelinePathFor(out)
  writeFileSync(timelinePath, JSON.stringify({
    label: manifest.label,
    title: manifest.title,
    video: basename(out),
    canvas: { width: canvasW, height: canvasH },
    ...timeline,
  }, null, 2) + '\n')

  const seconds = (frameNo / fps).toFixed(1)
  return { out, timeline: timelinePath, frames: frameNo, seconds, steps: manifest.steps.length }
}

function hasFfmpeg() {
  const r = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' })
  return r.status === 0
}
