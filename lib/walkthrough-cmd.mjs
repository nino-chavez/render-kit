/**
 * `render-kit walkthrough <manifest.json> --emit <interactive|video>` — the multi-output
 * command. ONE manifest, pluggable emitters: the interactive click-through player, the motion
 * video, and (as more land) thumbnails — all from the same captured stills, so they can't drift.
 */
import { loadManifest, STEP_KINDS } from './manifest.mjs'
import { emitInteractive } from './emit-interactive.mjs'
import { emitVideo } from './emit-video.mjs'

function parseWalkthroughArgs(args) {
  const opts = {
    manifest: null,
    emit: 'interactive',
    out: null,
    outDir: null,
    fps: 30,
    scale: 1,
    canvasW: null,
    canvasH: null,
    og: {},
  }
  let i = 0
  while (i < args.length) {
    const a = args[i]
    if (!a.startsWith('-')) { opts.manifest = a; i++; continue }
    switch (a) {
      case '--emit': opts.emit = args[++i]; i++; break
      case '--out': opts.out = args[++i]; i++; break
      case '--out-dir': opts.outDir = args[++i]; i++; break
      case '--fps': opts.fps = parseInt(args[++i], 10); i++; break
      case '--scale': opts.scale = parseFloat(args[++i]); i++; break
      case '--canvas': {
        const m = String(args[++i]).match(/^(\d+)x(\d+)$/)
        if (!m) { console.error('Error: --canvas expects WxH, e.g. 1920x1080'); process.exit(1) }
        opts.canvasW = parseInt(m[1], 10); opts.canvasH = parseInt(m[2], 10); i++; break
      }
      case '--og-url': opts.og.url = args[++i]; i++; break
      case '--og-image': opts.og.image = args[++i]; i++; break
      case '--og-desc': opts.og.desc = args[++i]; i++; break
      case '--og-site': opts.og.site = args[++i]; i++; break
      case '--og-title': opts.og.title = args[++i]; i++; break
      default: console.error(`Unknown walkthrough option: ${a}`); process.exit(1)
    }
  }
  return opts
}

export function printWalkthroughHelp() {
  console.log(`
render-kit walkthrough — one manifest, many outputs

Usage:
  render-kit walkthrough <manifest.json> --emit interactive --out-dir <dir>
  render-kit walkthrough <manifest.json> --emit video --out <file.mp4> [--canvas 1920x1080]

The manifest is the shared contract a capture harness produces (see templates/walkthrough/CONTRACT.md):
  { label, title?, width, height, steps:[{ frame, kind, caption, hotspot }] }
  kind ∈ ${STEP_KINDS.join(' | ')};  hotspot = {x,y,w,h} rect | point | null
  Stills live in a sibling folder named <label>/.

Emitters:
  interactive   self-contained click-through player (index.html + copied stills)
  video         motion over the stills → mp4 (Ken-Burns + spotlight + captions), silent

Options:
  --emit <name>        interactive (default) | video
  --out-dir <dir>      output folder            (interactive)
  --out <file.mp4>     output file              (video)
  --canvas <WxH>       video canvas size        (default: manifest width×height)
  --fps <N>            video frame rate         (default: 30)
  --scale <N>          device scale factor      (default: 1; use 1 with a 3× capture)
  --og-url/-image/-desc/-site/-title   Open Graph tags for a shared interactive link
`)
}

export async function runWalkthrough(args) {
  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    printWalkthroughHelp()
    process.exit(0)
  }
  const opts = parseWalkthroughArgs(args)
  if (!opts.manifest) { console.error('Error: manifest.json is required'); process.exit(1) }

  const manifest = loadManifest(opts.manifest)

  if (opts.emit === 'interactive') {
    if (!opts.outDir) { console.error('Error: --out-dir is required for --emit interactive'); process.exit(1) }
    const r = emitInteractive(manifest, { outDir: opts.outDir, og: opts.og })
    console.log(`\n✓ ${r.indexPath}`)
    console.log(`  ${r.steps} steps · ${r.copied} stills · self-contained folder (host or open directly)`)
  } else if (opts.emit === 'video') {
    if (!opts.out) { console.error('Error: --out <file.mp4> is required for --emit video'); process.exit(1) }
    console.log(`Rendering ${manifest.steps.length} steps → video...\n`)
    const r = await emitVideo(manifest, {
      out: opts.out, fps: opts.fps, scale: opts.scale, canvasW: opts.canvasW, canvasH: opts.canvasH,
    })
    console.log(`\n✓ ${r.out}`)
    console.log(`  ${r.frames} frames · ${r.seconds}s · ${r.steps} steps`)
  } else {
    console.error(`Error: unknown --emit "${opts.emit}" (expected interactive | video)`)
    process.exit(1)
  }
}
