/**
 * Pose blocking layout — the single owner of the geometry, and its checks.
 *
 * Layout runs here in Node, not in the page. Two reasons, one of them forced:
 * Chromium refuses ES module imports over file://, so a template loaded from
 * disk cannot share a module with anything; and geometry this deterministic is
 * verifiable without a browser, which means the checks below run in
 * milliseconds and cover the exact numbers that get drawn.
 *
 *   node lib/pose-layout.mjs --selftest
 *   node lib/pose-layout.mjs build <spec.json> <variants.json>
 */

import { readFileSync, writeFileSync } from 'node:fs'
import process from 'node:process'

export const STAGE = { width: 1000, height: 430 }

/** Ordered tallest to shortest. A diagram must never contradict this. */
export const HEIGHT_ORDER = ['adult', 'child-tall', 'child-small', 'infant']

export const HEIGHT = {
  adult: 200,
  'child-tall': 128,
  'child-small': 100,
  infant: 56,
}

export const TONE = {
  adult: '#2f5d62',
  'child-tall': '#a4632b',
  'child-small': '#a4632b',
  infant: '#7a3b6b',
}

export const GROUND = 322       // baseline y for a front-plane figure
export const LABEL_BAND = 54    // reserved under the ground line for a name + note
export const DEPTH_SCALE = 0.8  // each step back shrinks the figure
export const DEPTH_LIFT = 26    // and lifts its feet up the receding ground
export const MARGIN_X = 90      // x=0 and x=100 map inside this margin
export const CARRIES = ['hip', 'shoulders']

/** Where the camera mark sits — its own band, clear of the label band. */
export const CAMERA = { x: STAGE.width / 2, y: GROUND + LABEL_BAND + 34 }

function figureBox(heightClass, scale, feetY) {
  const h = HEIGHT[heightClass] * scale
  const headR = h * 0.115
  const shoulderY = feetY - h + headR * 2.35
  return {
    h,
    headR,
    feetY,
    shoulderY,
    headTop: shoulderY - headR * 2.35,
    hipY: feetY - h * 0.44,
    halfShoulder: h * 0.105,
    halfHip: h * 0.082,
  }
}

/**
 * Position every figure in a pose.
 * @returns {{figures: Array, depths: number[], bounds: object}}
 */
export function layoutPose(pose) {
  const all = pose.figures || []
  const byDepth = (a, b) => (b.depth || 0) - (a.depth || 0)

  // Standing figures first, back to front. Carried figures come after every host
  // is placed — depth order alone would leave that to sort stability whenever a
  // carrier and its rider share a depth.
  const ordered = [
    ...all.filter((f) => !f.carriedBy).sort(byDepth),
    ...all.filter((f) => f.carriedBy).sort(byDepth),
  ]

  const placed = new Map()
  const figures = []

  for (const fig of ordered) {
    const depth = fig.depth || 0

    if (fig.carriedBy) {
      const host = placed.get(fig.carriedBy)
      if (!host) throw new Error(`"${fig.role}" is carriedBy "${fig.carriedBy}", which is not in this pose`)
      const scale = host.scale * 0.9
      const h = HEIGHT[fig.height] * scale
      // On the shoulders: the rider's feet tuck at the host's head top and the
      // body rises from there. On the hip: the rider's centre sits at the hip line.
      const feetY = fig.carry === 'shoulders'
        ? host.box.headTop + h * 0.66
        : host.box.hipY + h * 0.5
      const box = figureBox(fig.height, scale, feetY)
      const x = host.x + (fig.carryOffset ?? 0) * host.scale
      const entry = { ...fig, x, scale, box, carried: true }
      figures.push(entry)
      placed.set(fig.role, entry)
    } else {
      const scale = Math.pow(DEPTH_SCALE, depth)
      const box = figureBox(fig.height, scale, GROUND - depth * DEPTH_LIFT)
      const x = MARGIN_X + (fig.x / 100) * (STAGE.width - MARGIN_X * 2)
      const entry = { ...fig, x, scale, box, carried: false }
      figures.push(entry)
      placed.set(fig.role, entry)
    }
  }

  for (const fig of figures) {
    if (fig.carry === 'hip') {
      // A hip rider overlaps the adult carrying them, so a name centred above
      // would sit on that adult's torso — dark text on a dark fill. Push it out
      // to the free side instead, level with the rider's feet.
      const away = Math.sign(fig.carryOffset ?? 1) || 1
      fig.labelX = fig.x + away * 30 * fig.scale
      fig.labelY = fig.box.feetY + 15
      fig.labelAnchor = away < 0 ? 'end' : 'start'
    } else if (fig.carried) {
      fig.labelX = fig.x
      fig.labelY = fig.box.headTop - 12
      fig.labelAnchor = 'middle'
    } else {
      fig.labelX = fig.x
      fig.labelY = fig.box.feetY + 26
      fig.labelAnchor = 'middle'
    }
    fig.noteY = fig.labelY + (fig.carried && fig.carry !== 'hip' ? -20 : 21)
    fig.tone = TONE[fig.height]
  }

  const depths = [...new Set(all.filter((f) => !f.carriedBy).map((f) => f.depth || 0))].sort((a, b) => b - a)

  return {
    figures,
    depths,
    stage: STAGE,
    ground: GROUND,
    depthLift: DEPTH_LIFT,
    camera: CAMERA,
    bounds: {
      top: Math.min(...figures.map((f) => Math.min(f.box.headTop, f.labelY, f.noteY))),
      bottom: Math.max(...figures.map((f) => Math.max(f.box.feetY, f.labelY, f.noteY))),
      left: Math.min(...figures.map((f) => Math.min(f.x - f.box.halfShoulder, f.labelX - 60))),
      right: Math.max(...figures.map((f) => Math.max(f.x + f.box.halfShoulder, f.labelX + 60))),
    },
  }
}

/**
 * Check a pose spec and its resulting geometry.
 * @returns {string[]} problems, empty when the spec is sound
 */
export function validatePoses(poses) {
  const problems = []
  const at = (pose, message) => problems.push(`${pose.name || '(unnamed)'}: ${message}`)

  // The height scale must stay strictly ordered, or a diagram could show a
  // child taller than a parent and still look deliberate.
  for (let i = 1; i < HEIGHT_ORDER.length; i++) {
    const taller = HEIGHT_ORDER[i - 1]
    const shorter = HEIGHT_ORDER[i]
    if (!(HEIGHT[taller] > HEIGHT[shorter])) {
      problems.push(`HEIGHT scale: ${taller} (${HEIGHT[taller]}) must exceed ${shorter} (${HEIGHT[shorter]})`)
    }
  }

  if (!Array.isArray(poses)) return ['spec must be a JSON array of poses']

  for (const pose of poses) {
    if (!pose.name) problems.push('a pose is missing its name')
    if (!pose.lens) at(pose, 'no lens — a blocking diagram without the camera spec is half a spec')
    if (!pose.distance) at(pose, 'no distance — same reason')
    if (!Array.isArray(pose.figures) || pose.figures.length === 0) {
      at(pose, 'no figures')
      continue
    }

    const roles = new Set()
    for (const fig of pose.figures) {
      if (!fig.role) { at(pose, 'a figure is missing its role'); continue }
      if (roles.has(fig.role)) at(pose, `duplicate role "${fig.role}" — roles key the layout, so one would overwrite the other`)
      roles.add(fig.role)

      if (!HEIGHT_ORDER.includes(fig.height)) {
        at(pose, `"${fig.role}" has height "${fig.height}"; expected one of ${HEIGHT_ORDER.join(', ')}`)
      }

      if (fig.carriedBy) {
        if (!CARRIES.includes(fig.carry)) at(pose, `"${fig.role}" is carried but carry is "${fig.carry}"; expected ${CARRIES.join(' or ')}`)
        const host = pose.figures.find((f) => f.role === fig.carriedBy)
        if (!host) at(pose, `"${fig.role}" is carriedBy "${fig.carriedBy}", who is not in this pose`)
        else if (host.height !== 'adult') at(pose, `"${fig.role}" is carried by "${host.role}", who is not an adult`)
        else if (HEIGHT[fig.height] >= HEIGHT[host.height]) at(pose, `"${fig.role}" is not shorter than the person carrying them`)
      } else if (!(fig.x >= 0 && fig.x <= 100)) {
        at(pose, `"${fig.role}" has x ${fig.x}; expected 0–100`)
      }
    }

    let laid
    try {
      laid = layoutPose(pose)
    } catch (error) {
      at(pose, error.message)
      continue
    }

    // Everything drawn must land inside the stage. This is what catches a rider
    // whose head — and whose name — would render off the top of the frame.
    const { bounds } = laid
    if (bounds.top < 0) at(pose, `geometry runs ${Math.round(-bounds.top)}px above the stage`)
    if (bounds.bottom > GROUND + LABEL_BAND) at(pose, `labels run ${Math.round(bounds.bottom - GROUND - LABEL_BAND)}px into the camera band`)
    if (bounds.left < 0) at(pose, `geometry runs ${Math.round(-bounds.left)}px off the left edge`)
    if (bounds.right > STAGE.width) at(pose, `geometry runs ${Math.round(bounds.right - STAGE.width)}px off the right edge`)
  }

  return problems
}

/** Expand a spec into a render-kit variants array with geometry precomputed. */
export function buildVariants(poses) {
  return poses.map((pose) => ({ ...pose, layout: layoutPose(pose) }))
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function selftest() {
  const checks = []
  const check = (name, fn) => {
    try { fn(); checks.push(`✓ ${name}`) }
    catch (error) { checks.push(`✗ ${name} — ${error.message}`) }
  }
  const assert = (condition, message) => { if (!condition) throw new Error(message) }

  check('height scale is strictly ordered', () => {
    assert(validatePoses([]).length === 0, 'ordering check should pass on the shipped scale')
  })

  check('a rider is drawn above the adult carrying them', () => {
    const laid = layoutPose({
      name: 't', lens: '85mm', distance: '10 ft',
      figures: [
        { role: 'A', height: 'adult', x: 50, depth: 0 },
        { role: 'K', height: 'child-small', carriedBy: 'A', carry: 'shoulders' },
      ],
    })
    const adult = laid.figures.find((f) => f.role === 'A')
    const kid = laid.figures.find((f) => f.role === 'K')
    assert(kid.box.headTop < adult.box.headTop, 'rider head should sit above the adult head')
    assert(kid.box.h < adult.box.h, 'rider should be drawn smaller than the adult')
  })

  check('a carried figure placed before its host still resolves', () => {
    const laid = layoutPose({
      name: 't', lens: '85mm', distance: '10 ft',
      figures: [
        { role: 'K', height: 'infant', carriedBy: 'A', carry: 'hip' },
        { role: 'A', height: 'adult', x: 50, depth: 0 },
      ],
    })
    assert(laid.figures.length === 2, 'both figures should be laid out')
  })

  check('depth pushes a figure back and up', () => {
    const laid = layoutPose({
      name: 't', lens: '85mm', distance: '10 ft',
      figures: [
        { role: 'Front', height: 'adult', x: 40, depth: 0 },
        { role: 'Back', height: 'adult', x: 60, depth: 1 },
      ],
    })
    const front = laid.figures.find((f) => f.role === 'Front')
    const back = laid.figures.find((f) => f.role === 'Back')
    assert(back.box.h < front.box.h, 'the further figure should be smaller')
    assert(back.box.feetY < front.box.feetY, 'the further figure should stand higher up the frame')
  })

  check('off-stage geometry is reported', () => {
    const problems = validatePoses([{
      name: 'tower', lens: '85mm', distance: '10 ft',
      figures: [
        { role: 'A', height: 'adult', x: 50, depth: 0 },
        { role: 'B', height: 'child-tall', carriedBy: 'A', carry: 'shoulders' },
        { role: 'C', height: 'child-tall', carriedBy: 'B', carry: 'shoulders' },
      ],
    }])
    assert(problems.some((p) => p.includes('above the stage') || p.includes('not an adult')), `expected an off-stage or non-adult report, got: ${problems.join('; ')}`)
  })

  check('a duplicate role is reported', () => {
    const problems = validatePoses([{
      name: 'dup', lens: '85mm', distance: '10 ft',
      figures: [
        { role: 'A', height: 'adult', x: 40, depth: 0 },
        { role: 'A', height: 'adult', x: 60, depth: 0 },
      ],
    }])
    assert(problems.some((p) => p.includes('duplicate role')), 'expected a duplicate-role report')
  })

  check('a missing lens or distance is reported', () => {
    const problems = validatePoses([{ name: 'bare', figures: [{ role: 'A', height: 'adult', x: 50 }] }])
    assert(problems.some((p) => p.includes('no lens')), 'expected a missing-lens report')
    assert(problems.some((p) => p.includes('no distance')), 'expected a missing-distance report')
  })

  for (const line of checks) console.log(`  ${line}`)
  const failed = checks.filter((c) => c.startsWith('✗')).length
  console.log(failed === 0 ? `\nAll ${checks.length} checks passed` : `\n${failed} of ${checks.length} checks failed`)
  return failed === 0
}

if (process.argv[1] && process.argv[1].endsWith('pose-layout.mjs')) {
  const args = process.argv.slice(2)

  if (args.includes('--selftest')) {
    process.exit(selftest() ? 0 : 1)
  }

  if (args[0] === 'build') {
    const [, specPath, outPath] = args
    if (!specPath || !outPath) {
      console.error('Usage: node lib/pose-layout.mjs build <spec.json> <variants.json>')
      process.exit(1)
    }
    const poses = JSON.parse(readFileSync(specPath, 'utf8'))
    const problems = validatePoses(poses)
    if (problems.length > 0) {
      console.error(`${problems.length} problem(s) in ${specPath}:`)
      for (const problem of problems) console.error(`  ${problem}`)
      process.exit(1)
    }
    writeFileSync(outPath, JSON.stringify(buildVariants(poses), null, 2))
    console.log(`✓ ${poses.length} pose(s) checked and laid out → ${outPath}`)
    process.exit(0)
  }

  console.error('Usage: node lib/pose-layout.mjs [--selftest | build <spec.json> <variants.json>]')
  process.exit(1)
}
