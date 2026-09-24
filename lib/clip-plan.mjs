/**
 * clip-plan — pure scene-cutting math for `render-kit clips`.
 *
 * Generalizes Minder's scripts/tour/cut-clips.py SCENES shape: a named scene anchors to a
 * manifest step's `at` (seconds into the producer's own recording), cuts `length` source
 * seconds starting `offset` seconds from that step, optionally speeds the result up/down, and
 * optionally concatenates further segments (`then`) as a jump cut — each of which may name its
 * own anchor step, defaulting to the scene's.
 *
 * Kept pure and ffmpeg-free so the frame-count math is testable without a real recording:
 * `execFileSync`/`spawnSync` calls live in clips-cmd.mjs, not here.
 */

/**
 * @param {Array<{at?:number, hotspot?:object|null}>} steps  RAW manifest steps (schema `at`
 *   survives here; `loadManifest()` strips it, so callers must read the manifest JSON directly
 *   for `at`, not the normalized shape).
 * @param {{ step:number, offset:number, length:number, speed?:number,
 *           then?:Array<{step?:number, offset:number, length:number}> }} sceneSpec
 * @param {number} fps
 * @returns {{ step:number, speed:number,
 *   segments:Array<{step:number, sourceStart:number, sourceLength:number, frames:number}>,
 *   totalFrames:number, duration:number, stepOffsetInClip:number, hotspot:object|null }}
 */
export function planScene(steps, sceneSpec, fps) {
  if (!sceneSpec || !Number.isFinite(sceneSpec.step)) {
    throw new Error('scene.step is required (1-based index into manifest.steps)')
  }
  const speed = sceneSpec.speed ?? 1

  const resolveSegment = (stepNum, offset, length) => {
    const step = steps[stepNum - 1]
    if (!step) throw new Error(`step ${stepNum} does not exist (manifest has ${steps.length} steps)`)
    if (!Number.isFinite(step.at)) {
      throw new Error(`step ${stepNum} has no "at" — required to cut clips (see CONTRACT.md)`)
    }
    const sourceStart = Math.max(0, step.at + offset)
    const sourceLength = length
    const frames = Math.max(1, Math.round((sourceLength / speed) * fps))
    return { step: stepNum, sourceStart, sourceLength, frames, anchorAt: step.at, hotspot: step.hotspot ?? null }
  }

  const primary = resolveSegment(sceneSpec.step, sceneSpec.offset, sceneSpec.length)
  const rest = (sceneSpec.then ?? []).map((seg) =>
    resolveSegment(seg.step ?? sceneSpec.step, seg.offset, seg.length)
  )
  const segments = [primary, ...rest]
  const totalFrames = segments.reduce((sum, s) => sum + s.frames, 0)
  const duration = totalFrames / fps
  const stepOffsetInClip = (primary.anchorAt - primary.sourceStart) / speed

  return {
    step: sceneSpec.step,
    speed,
    segments: segments.map(({ step, sourceStart, sourceLength, frames }) => ({ step, sourceStart, sourceLength, frames })),
    totalFrames,
    duration,
    stepOffsetInClip,
    hotspot: primary.hotspot,
  }
}

/**
 * @param {Array<object>} steps  raw manifest steps
 * @param {{scenes: Record<string, object>}} spec
 * @param {number} fps
 * @returns {Record<string, ReturnType<typeof planScene>>}
 */
export function planClips(steps, spec, fps) {
  if (!spec || typeof spec.scenes !== 'object' || !spec.scenes) {
    throw new Error('spec.scenes is required — { "scenes": { "<name>": { step, offset, length, ... } } }')
  }
  const out = {}
  for (const [name, sceneSpec] of Object.entries(spec.scenes)) {
    out[name] = planScene(steps, sceneSpec, fps)
  }
  return out
}

// node lib/clip-plan.mjs --selftest
if (process.argv[1] && process.argv[1].endsWith('clip-plan.mjs') && process.argv.includes('--selftest')) {
  const eq = (a, b, eps = 0.02) => Math.abs(a - b) < eps
  const cases = []
  const check = (name, cond) => cases.push([name, cond])

  const steps = [
    { at: 19.05 },                                    // step 1
    { at: 24.83 },                                     // step 2
    { at: 29.95, hotspot: { x: 1, y: 2, w: 3, h: 4 } }, // step 3
    { at: 31.69 },                                      // step 4
    { at: 47.13 },                                      // step 5
  ]
  const fps = 30

  // Minder's real spec: f2/f3/f4/f5 reproduced with the corrected (non-buggy) `then` shape.
  const spec = {
    scenes: {
      f2: { step: 1, offset: 0.10, length: 3.8, speed: 1 },
      f3: { step: 2, offset: -1.60, length: 3.0, speed: 1 },
      f4: { step: 3, offset: -0.40, length: 1.0, speed: 1, then: [{ offset: 2.20, length: 2.35 }] },
      f5: { step: 5, offset: -1.40, length: 7.4, speed: 1.4 },
    },
  }
  const plan = planClips(steps, spec, fps)

  check('f2 duration ~3.8s', eq(plan.f2.duration, 3.8))
  check('f2 sourceStart = 19.05+0.10', eq(plan.f2.segments[0].sourceStart, 19.15))
  check('f3 duration ~3.0s', eq(plan.f3.duration, 3.0))
  check('f4 duration ~3.35s (1.0 + 2.35, single-segment math)', eq(plan.f4.duration, 3.35))
  check('f4 has two segments (jump cut)', plan.f4.segments.length === 2)
  check('f4 second segment defaults to scene step (3)', plan.f4.segments[1].step === 3)
  check('f5 duration ~5.29s at 1.4x', eq(plan.f5.duration, 5.29, 0.05))
  check('f5 frames = round(7.4/1.4*30)', plan.f5.segments[0].frames === Math.round((7.4 / 1.4) * 30))
  check('f4 hotspot carried from anchor step', plan.f4.hotspot && plan.f4.hotspot.w === 3)

  // Offset can push sourceStart negative (a step very near the recording start); clamp to 0.
  const clampSteps = [{ at: 0.5 }]
  const clampPlan = planScene(clampSteps, { step: 1, offset: -2.0, length: 1.0 }, fps)
  check('negative offset clamps sourceStart to 0', clampPlan.segments[0].sourceStart === 0)

  // speed divisor: frames scale inversely with speed.
  const speedPlan = planScene([{ at: 0 }], { step: 1, offset: 0, length: 3.0, speed: 2 }, fps)
  check('speed=2 halves frames', speedPlan.segments[0].frames === Math.round((3.0 / 2) * fps))

  // Missing `at` on the referenced step must error clearly, not silently produce NaN.
  let threw = false
  try {
    planScene([{}], { step: 1, offset: 0, length: 1 }, fps)
  } catch (err) {
    threw = /no "at"/.test(err.message)
  }
  check('missing at throws a clear error', threw)

  const failed = cases.filter(([, ok]) => !ok)
  for (const [name, ok] of cases) console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (failed.length) {
    console.error(`\n${failed.length} check(s) failed`)
    process.exit(1)
  }
  console.log(`\nAll ${cases.length} checks passed`)
}
