/**
 * video timeline — the per-step timing the video emitter renders, as data.
 *
 * Pure and unit-tested so the emitter, `--plan`, and the `timeline.json` sidecar all read one
 * source: the sidecar describes exactly the frames that were rendered, never a re-estimate.
 * Times are frame-derived (frame / fps), so a downstream composition placing sound or captions
 * against them lands on a real frame boundary.
 */

// Reading-time duration per step: long captions hold longer, empty beats are brief. Clamped
// so no single step drags or flashes past legibility.
export function stepDurationSec(caption) {
  if (!caption) return 2.2
  const words = caption.split(/\s+/).filter(Boolean).length
  return Math.max(2.4, Math.min(7.0, 1.4 + words * 0.32))
}

/**
 * @param {Array<{kind:string, caption:string}>} steps  normalized manifest steps
 * @param {number} fps
 * @returns {{ fps:number, frames:number, duration:number, steps:Array<{
 *   step:number, kind:string, caption:string,
 *   startFrame:number, frames:number, start:number, duration:number, end:number }>}}
 */
export function planTimeline(steps, fps) {
  let cursor = 0
  const out = steps.map((s, i) => {
    const frames = Math.max(2, Math.round(stepDurationSec(s.caption) * fps))
    const startFrame = cursor
    cursor += frames
    return {
      step: i + 1,
      kind: s.kind,
      caption: s.caption,
      startFrame,
      frames,
      start: round3(startFrame / fps),
      duration: round3(frames / fps),
      end: round3(cursor / fps),
    }
  })
  return { fps, frames: cursor, duration: round3(cursor / fps), steps: out }
}

/** Fixed-width table for `--plan`: one row per step, captions truncated to fit a terminal. */
export function formatTimeline(timeline) {
  const rows = timeline.steps.map((s) => [
    String(s.step),
    s.start.toFixed(2),
    s.duration.toFixed(2),
    String(s.frames),
    s.kind,
    s.caption.length > 48 ? s.caption.slice(0, 47) + '…' : s.caption,
  ])
  const head = ['#', 'start', 'dur', 'frames', 'kind', 'caption']
  const widths = head.map((h, c) => Math.max(h.length, ...rows.map((r) => r[c].length)))
  const line = (r) => r.map((v, c) => (c < 4 ? v.padStart(widths[c]) : v.padEnd(widths[c]))).join('  ').trimEnd()
  return [line(head), ...rows.map(line),
    `total ${timeline.duration.toFixed(2)}s · ${timeline.frames} frames @ ${timeline.fps}fps`].join('\n')
}

function round3(n) {
  return Math.round(n * 1000) / 1000
}

// node lib/video-timeline.mjs --selftest
if (process.argv[1] && process.argv[1].endsWith('video-timeline.mjs') && process.argv.includes('--selftest')) {
  const cases = []
  const check = (name, cond) => cases.push([name, cond])

  check('empty caption holds 2.2s', stepDurationSec('') === 2.2)
  check('short caption floors at 2.4s', stepDurationSec('Tap save') === 2.4)
  check('long caption caps at 7.0s', stepDurationSec('word '.repeat(40)) === 7.0)
  check('mid caption = 1.4 + 0.32/word', Math.abs(stepDurationSec('a b c d e f') - (1.4 + 6 * 0.32)) < 1e-9)

  const steps = [
    { kind: 'click', caption: 'Open the event' },          // 3 words → 2.4s → 72 frames
    { kind: 'type', caption: '' },                          // 2.2s → 66 frames
    { kind: 'annotate', caption: 'a b c d e f g h i j' },   // 10 words → 4.6s → 138 frames
  ]
  const t = planTimeline(steps, 30)
  check('frame counts match emitter rounding', t.steps.map((s) => s.frames).join() === '72,66,138')
  check('steps are contiguous (start = previous end)', t.steps[1].start === t.steps[0].end && t.steps[2].start === t.steps[1].end)
  check('startFrame accumulates', t.steps[2].startFrame === 138)
  check('total frames = sum of step frames', t.frames === 276)
  check('total duration = frames / fps', t.duration === 9.2)
  check('step numbers are 1-based', t.steps[0].step === 1 && t.steps[2].step === 3)

  // A tiny fps must still give each step its 2-frame floor (the emitter seeks p over ≥2 frames).
  check('2-frame floor at low fps', planTimeline([{ kind: 'click', caption: '' }], 0.1).steps[0].frames === 2)

  // Fractional fps: times stay frame-derived, so start*fps recovers the integer frame.
  const t24 = planTimeline(steps, 24)
  check('times are frame-derived at 24fps', t24.steps.every((s) => Math.abs(s.start * 24 - s.startFrame) < 0.05))

  const table = formatTimeline(t)
  check('table has header + one row per step + total', table.split('\n').length === steps.length + 2)
  check('table states the total', /total 9\.20s · 276 frames @ 30fps/.test(table))

  const failed = cases.filter(([, ok]) => !ok)
  for (const [name, ok] of cases) console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (failed.length) {
    console.error(`\n${failed.length} check(s) failed`)
    process.exit(1)
  }
  console.log(`\nAll ${cases.length} checks passed`)
}
