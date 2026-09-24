/**
 * `render-kit clips <manifest.json> --master <recording.mp4> --spec <scenes.json> --out-dir <dir>`
 *
 * Cuts short scenes out of a producer's screen recording, anchored to the manifest's step
 * `at` times, for the hype/sizzle HyperFrames lane (see CONTRACT.md). The frame-count math is
 * in clip-plan.mjs (pure, unit-tested); this file owns the ffmpeg invocations.
 */
import { readFileSync, writeFileSync, mkdirSync, statSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { planClips } from './clip-plan.mjs'

function parseClipsArgs(args) {
  const opts = { manifest: null, master: null, spec: null, outDir: null, fps: 30 }
  let i = 0
  while (i < args.length) {
    const a = args[i]
    if (!a.startsWith('-')) { opts.manifest = a; i++; continue }
    switch (a) {
      case '--master': opts.master = args[++i]; i++; break
      case '--spec': opts.spec = args[++i]; i++; break
      case '--out-dir': opts.outDir = args[++i]; i++; break
      case '--fps': opts.fps = parseInt(args[++i], 10); i++; break
      default: console.error(`Unknown clips option: ${a}`); process.exit(1)
    }
  }
  return opts
}

export function printClipsHelp() {
  console.log(`
render-kit clips — cut short scenes from a screen recording for the hype/sizzle lane

Usage:
  render-kit clips <manifest.json> --master <recording.mp4> --spec <scenes.json> --out-dir <dir> [--fps 30]

<manifest.json> is the same walkthrough manifest CONTRACT.md describes; its steps' "at" fields
(seconds into <recording.mp4>) anchor each scene.

<scenes.json>:
  { "scenes": { "f4": { "step": 3, "offset": -0.4, "length": 1.0, "speed": 1,
                          "then": [{ "step": 4, "offset": 0.46, "length": 2.35 }] } } }
  step is 1-based into manifest.steps and requires that step to have "at". offset/length are
  source seconds relative to the step's "at". speed defaults to 1. "then" is an optional array
  of extra segments (a jump cut), each defaulting its own "step" to the scene's.

Writes <out-dir>/<name>.mp4 per scene (H.264, yuv420p, no audio, faststart) and
<out-dir>/clips.json (duration, segments, anchor step, and hotspot per scene).

Options:
  --master <file.mp4>   source recording (required)
  --spec <file.json>    scene spec (required)
  --out-dir <dir>       output folder (required)
  --fps <N>             output frame rate (default: 30)
`)
}

function hasFfmpeg() {
  const r = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' })
  return r.status === 0
}

// The constant-fps master is expensive to build (a full re-encode), so it's reused across a
// clips run as long as it's newer than the source recording (gotcha 1 in CONTRACT.md).
function ensureConstantFps(master, outDir, fps) {
  const cfr = join(outDir, `.master-cfr-${fps}.mp4`)
  const masterMtime = statSync(master).mtimeMs
  if (existsSync(cfr) && statSync(cfr).mtimeMs >= masterMtime) return cfr
  mkdirSync(outDir, { recursive: true })
  execFileSync('ffmpeg', [
    '-v', 'error', '-y', '-i', master,
    '-vf', `fps=${fps},format=yuv420p`, '-c:v', 'libx264', '-crf', '14', '-preset', 'fast', '-an', cfr,
  ], { stdio: ['ignore', 'ignore', 'inherit'] })
  return cfr
}

// Cut + speed + concat one scene's segments off the constant-fps master into a single mp4.
// Reads sourceLength (+ margin, in SOURCE seconds, not divided by speed) of input per segment —
// speed is applied by setpts AFTER the read, so the read duration must be long enough to cover
// the sped-up output; reading sourceLength/speed instead (as if the margin were output-time)
// starves the trim target for speed > 1 and silently short-cuts the clip.
function cutScene(cfr, plan, fps, outPath) {
  const inputs = []
  const chains = []
  plan.segments.forEach((seg, i) => {
    const readSeconds = seg.sourceLength + 0.5
    inputs.push('-ss', seg.sourceStart.toFixed(3), '-t', readSeconds.toFixed(3), '-i', cfr)
    chains.push(
      `[${i}:v]setpts=PTS/${plan.speed},fps=${fps},trim=end_frame=${seg.frames},setpts=PTS-STARTPTS[v${i}]`
    )
  })
  const graph =
    chains.join(';') + ';' + plan.segments.map((_, i) => `[v${i}]`).join('') +
    `concat=n=${plan.segments.length}:v=1:a=0[out]`
  execFileSync('ffmpeg', [
    '-v', 'error', '-y', ...inputs, '-filter_complex', graph, '-map', '[out]', '-an',
    '-c:v', 'libx264', '-crf', '16', '-preset', 'slow', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', outPath,
  ], { stdio: ['ignore', 'ignore', 'inherit'] })
}

export async function runClips(args) {
  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    printClipsHelp()
    process.exit(0)
  }
  const opts = parseClipsArgs(args)
  if (!opts.manifest) { console.error('Error: manifest.json is required'); process.exit(1) }
  if (!opts.master) { console.error('Error: --master <recording.mp4> is required'); process.exit(1) }
  if (!opts.spec) { console.error('Error: --spec <scenes.json> is required'); process.exit(1) }
  if (!opts.outDir) { console.error('Error: --out-dir <dir> is required'); process.exit(1) }
  if (!hasFfmpeg()) {
    console.error('Error: ffmpeg not found on PATH — required to cut clips (brew install ffmpeg)')
    process.exit(1)
  }

  // Raw steps, not loadManifest()'s normalized shape — loadManifest() strips "at" (an
  // interactive/video-only field before this command existed), and clips needs it.
  const raw = JSON.parse(readFileSync(opts.manifest, 'utf8'))
  const steps = raw.steps
  if (!Array.isArray(steps) || steps.length === 0) {
    console.error('Error: manifest.steps must be a non-empty array')
    process.exit(1)
  }
  const spec = JSON.parse(readFileSync(opts.spec, 'utf8'))

  let plans
  try {
    plans = planClips(steps, spec, opts.fps)
  } catch (err) {
    console.error(`Error: ${err.message}`)
    process.exit(1)
  }

  mkdirSync(opts.outDir, { recursive: true })
  const cfr = ensureConstantFps(opts.master, opts.outDir, opts.fps)

  const record = { logical: [raw.width, raw.height], clips: {} }
  for (const [name, plan] of Object.entries(plans)) {
    const outPath = join(opts.outDir, `${name}.mp4`)
    cutScene(cfr, plan, opts.fps, outPath)
    record.clips[name] = {
      source_start: round3(plan.segments[0].sourceStart),
      duration: round3(plan.duration),
      step: plan.step,
      step_offset_in_clip: round3(plan.stepOffsetInClip),
      hotspot: plan.hotspot,
      segments: plan.segments.map((s) => ({
        step: s.step, source_start: round3(s.sourceStart), source_length: round3(s.sourceLength), frames: s.frames,
      })),
    }
    console.log(`${name}: ${plan.duration.toFixed(2)}s from ${plan.segments[0].sourceStart.toFixed(2)}s; step ${plan.step} at +${plan.stepOffsetInClip.toFixed(2)}s`)
  }
  writeFileSync(join(opts.outDir, 'clips.json'), JSON.stringify(record, null, 2))
  console.log(`\n✓ ${Object.keys(plans).length} clip(s) → ${opts.outDir}`)
}

function round3(n) {
  return Math.round(n * 1000) / 1000
}
