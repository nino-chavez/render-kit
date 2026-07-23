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
 */
import { chromium } from 'playwright'
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { hotspotToMotion } from './hotspot-motion.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const TEMPLATE = join(HERE, '..', 'templates', 'walkthrough', 'motion.html')

// Reading-time duration per step: long captions hold longer, empty beats are brief. Clamped
// so no single step drags or flashes past legibility.
function stepDurationSec(caption) {
  if (!caption) return 2.2
  const words = caption.split(/\s+/).filter(Boolean).length
  return Math.max(2.4, Math.min(7.0, 1.4 + words * 0.32))
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

  const template = readFileSync(TEMPLATE, 'utf8')
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
      const motion = hotspotToMotion(step.hotspot, step.kind, { width: manifest.width, height: manifest.height })
      const stillUrl = pathToFileURL(join(manifest.srcDir, step.frame)).href
      const stepData = {
        frame: stillUrl,
        caption: step.caption,
        hotspot: step.hotspot,
        motion,
        width: manifest.width,
        height: manifest.height,
        canvasW,
        canvasH,
      }

      const html = template.replace(
        '</head>',
        `<script>window.RENDER_DATA = ${JSON.stringify(stepData)};</script></head>`
      )
      const tmpHtml = join(tmpDir, `step-${si}.html`)
      writeFileSync(tmpHtml, html)

      await page.goto(pathToFileURL(tmpHtml).href, { waitUntil: 'networkidle' })
      await page.evaluate(() => window.__ready)

      const totalFrames = Math.max(2, Math.round(stepDurationSec(step.caption) * fps))
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

  const seconds = (frameNo / fps).toFixed(1)
  return { out, frames: frameNo, seconds, steps: manifest.steps.length }
}

function hasFfmpeg() {
  const r = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' })
  return r.status === 0
}
