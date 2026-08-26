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
  infant: 74,
}

/**
 * The blocking fills the frame.
 *
 * `x` describes where people stand relative to each other, and real family
 * blocking is tight — five people at 12 ft span a couple of metres, not the
 * whole stage. Drawn literally that leaves the group huddled in the middle of
 * an empty sheet. Scaling the laid-out group up to the frame keeps the spacing
 * honest and still uses the paper. Feet stay on the ground line, so the ground
 * and the camera mark below it do not move.
 */
export const FIT_PADDING_X = 76
export const FIT_MAX_SCALE = 1.85
export const FIT_TOP = 12
/** Name plus note drawn above a shoulder-carried rider's head. */
export const LABEL_ABOVE = 36

export const TONE = {
  adult: '#2f5d62',
  'child-tall': '#a4632b',
  'child-small': '#a4632b',
  infant: '#7a3b6b',
}

/**
 * Half-width of the shoulders as a fraction of height.
 *
 * Not one number for everyone: an infant is about as wide as they are stubby,
 * and drawn at an adult's proportions a baby on a hip comes out as a thin bar
 * you cannot identify. These are body shapes, not a style choice.
 */
export const WIDTH = {
  adult: 0.105,
  'child-tall': 0.112,
  'child-small': 0.122,
  infant: 0.165,
}

/** Limbs sit against the torso, so they are drawn a shade darker than it. */
export function shade(hex, k) {
  const n = parseInt(hex.slice(1), 16)
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  return '#' + ch.map((c) => Math.round(c * k).toString(16).padStart(2, '0')).join('')
}

export const GROUND = 322       // baseline y for a front-plane figure
export const LABEL_BAND = 54    // reserved under the ground line for a name + note
export const DEPTH_SCALE = 0.8  // each step back shrinks the figure
export const DEPTH_LIFT = 26    // and lifts its feet up the receding ground
export const MARGIN_X = 90      // x=0 and x=100 map inside this margin
export const CARRIES = ['hip', 'shoulders']

/**
 * Where one figure may take hold of another.
 *
 * Contact is declared, never inferred from adjacency. Two figures standing next
 * to each other are not necessarily touching — "Staggered heights" puts Big sis
 * a full step in front of her parents and they are not holding her — and the
 * cue on almost every sheet is about who is holding whom. Guessing it from x
 * would draw arms the photographer did not ask for.
 */
export const CONTACT_POINTS = ['shoulder', 'waist', 'hand']

/** Arm length as a fraction of body height, measured shoulder to fingertip. */
export const ARM_SPAN = 0.46

/** Where the camera mark sits — its own band, clear of the label band. */
export const CAMERA = { x: STAGE.width / 2, y: GROUND + LABEL_BAND + 34 }

function figureBox(heightClass, scale, feetY) {
  const h = HEIGHT[heightClass] * scale
  const wide = WIDTH[heightClass] ?? 0.105
  const headR = h * (heightClass === 'infant' ? 0.155 : 0.115)
  const shoulderY = feetY - h + headR * 2.35
  return {
    h,
    headR,
    feetY,
    shoulderY,
    headTop: shoulderY - headR * 2.35,
    hipY: feetY - h * 0.44,
    halfShoulder: h * wide,
    halfHip: h * wide * 0.78,
    // Arms leave just below the shoulder line and reach to about mid-thigh.
    armY: shoulderY + h * 0.05,
    handY: feetY - h * 0.3,
    armSpan: h * ARM_SPAN,
    limb: Math.max(3, h * 0.055),
  }
}

/**
 * Contacts as a uniform list. `contact: ["Mom"]` is the common case — a hand on
 * a shoulder — so it stays writable as a bare name.
 */
export function contactsOf(fig) {
  return (fig.contact || []).map((c) =>
    typeof c === 'string' ? { to: c, at: 'shoulder' } : { at: 'shoulder', ...c }
  )
}

/**
 * Which side of the adult a carried child rides on: -1 left, +1 right.
 *
 * `carrySide` is the field. `carryOffset` is the older spelling — a distance in
 * pixels — and only its sign is still meaningful, because the distance is now
 * derived from the two bodies.
 */
export function carrySide(fig) {
  if (fig.carrySide === 'left' || fig.carrySide === -1) return -1
  if (fig.carrySide === 'right' || fig.carrySide === 1) return 1
  return Math.sign(fig.carryOffset ?? 1) || 1
}

/** The point on `target` that `from` is taking hold of. */
function contactPoint(target, at, side) {
  const { box } = target
  if (at === 'shoulder') return { x: target.x - side * box.halfShoulder, y: box.shoulderY + box.h * 0.03 }
  if (at === 'waist') return { x: target.x - side * box.halfHip, y: box.hipY }
  return { x: target.x - side * box.armSpan * 0.72, y: box.handY }
}

/**
 * Scale the laid-out group about the ground line so it fills the frame.
 *
 * Mutates every drawn coordinate in place and returns the factor used. Feet
 * stay on the ground because the vertical scale is taken about GROUND, which
 * keeps the receding ground lines and the camera mark below them valid.
 * Label font sizes are not touched — only where the labels sit — so a tight
 * pose gets bigger figures rather than bigger type.
 */
export function fitToStage(figures) {
  if (figures.length === 0) return 1
  const cx = STAGE.width / 2
  const spread = Math.max(
    ...figures.map((f) => Math.abs(f.x - cx) + f.box.halfShoulder + f.box.armSpan * 0.5)
  )
  // A rider carried on the shoulders is named above their head, and that label
  // band is a fixed number of pixels that does not scale with the figure. Its
  // room has to come off the top before the scale is computed, per figure —
  // folding it into one constant either wastes headroom or overruns the frame.
  const headroom = (f) => (f.carried && f.carry !== 'hip' ? LABEL_ABOVE : 0)
  const vertical = Math.min(
    ...figures.map((f) => (GROUND - FIT_TOP - headroom(f)) / Math.max(GROUND - f.box.headTop, 1))
  )
  const scale = Math.min((STAGE.width / 2 - FIT_PADDING_X) / Math.max(spread, 1), vertical, FIT_MAX_SCALE)
  if (!(scale > 0) || Math.abs(scale - 1) < 0.001) return 1

  const fx = (x) => cx + (x - cx) * scale
  const fy = (y) => GROUND - (GROUND - y) * scale
  for (const fig of figures) {
    for (const key of ['h', 'headR', 'halfShoulder', 'halfHip', 'armSpan', 'limb']) {
      fig.box[key] *= scale
    }
    for (const key of ['feetY', 'shoulderY', 'headTop', 'hipY', 'armY', 'handY']) {
      fig.box[key] = fy(fig.box[key])
    }
    fig.x = fx(fig.x)
    fig.scale *= scale
    for (const arm of fig.arms || []) {
      arm.from = { x: fx(arm.from.x), y: fy(arm.from.y) }
      arm.to = { x: fx(arm.to.x), y: fy(arm.to.y) }
      arm.width *= scale
    }
    if (fig.rig) {
      const seg = ([x1, y1, x2, y2]) => [fx(x1), fy(y1), fx(x2), fy(y2)]
      fig.rig.legs = fig.rig.legs.map(seg)
      fig.rig.hostArms = fig.rig.hostArms.map(seg)
      fig.rig.width *= scale
    }
    if (fig.shadow) {
      fig.shadow = {
        cx: fx(fig.shadow.cx),
        cy: fy(fig.shadow.cy),
        rx: fig.shadow.rx * scale,
        ry: fig.shadow.ry * scale,
      }
    }
  }
  return scale
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
      // A hip rider sits on the edge of the adult, not inside them. Derived from
      // both bodies rather than given as an offset in the spec: a hand-tuned
      // number that looked right at one scale put the child exactly behind the
      // adult's shoulder line at another, leaving a sliver of colour and no
      // readable second person.
      const side = carrySide(fig)
      const x = fig.carry === 'shoulders'
        ? host.x
        : host.x + side * (host.box.halfShoulder + box.halfShoulder * 0.55)
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

  // Arms, once every figure is placed. An arm exists only where the spec
  // declares contact, and it terminates on the named grip rather than trailing
  // off — a line that stops in mid-air reads as an artifact, not a hold.
  for (const fig of figures) {
    fig.arms = []
    for (const link of contactsOf(fig)) {
      const target = placed.get(link.to)
      if (!target || target === fig) continue // validatePoses reports these
      const side = Math.sign(target.x - fig.x) || 1
      fig.arms.push({
        from: { x: fig.x + side * fig.box.halfShoulder * 0.7, y: fig.box.armY },
        to: contactPoint(target, link.at, side),
        at: link.at,
        width: fig.box.limb,
      })
    }
  }

  // How a carried child is actually held. Without this a hip rider is a sliver
  // beside an adult and a shoulder rider is a blob above one — the two figures
  // on these sheets that most need to read at a glance.
  for (const fig of figures) {
    if (!fig.carried) continue
    const host = placed.get(fig.carriedBy)
    const b = fig.box
    if (fig.carry === 'hip') {
      const away = carrySide(fig)
      fig.rig = {
        kind: 'hip',
        // Legs hang out over the free side, which is what makes it a hip carry
        // rather than a small person standing improbably close.
        legs: [
          [fig.x + away * b.halfHip * 0.3, b.hipY, fig.x + away * b.h * 0.42, b.hipY + b.h * 0.26],
        ],
        hostArms: [
          [
            host.x + away * host.box.halfShoulder * 0.85,
            host.box.armY,
            fig.x - away * b.halfHip * 0.2,
            b.feetY + b.h * 0.04,
          ],
        ],
        width: b.limb,
      }
    } else {
      // Straddling: a leg down each side of the host's head, the host's hands
      // up on the shins.
      // Shins land on the chest, close to the head. Further out and the two
      // lines splay into wings that read as anything but a child sitting up.
      const kneeY = host.box.shoulderY + host.box.h * 0.11
      const kneeX = (s) => host.x + s * host.box.headR * 1.12
      fig.rig = {
        kind: 'shoulders',
        legs: [-1, 1].map((s) => [fig.x + s * b.halfHip * 0.8, b.hipY, kneeX(s), kneeY]),
        hostArms: [-1, 1].map((s) => [
          host.x + s * host.box.halfShoulder * 0.9,
          host.box.armY,
          kneeX(s),
          kneeY,
        ]),
        width: b.limb,
      }
    }
  }

  // Arms at rest on any side not already busy. Without these only the person
  // who happens to be holding someone has arms at all, and the rest read as
  // bowling pins rather than people.
  for (const fig of figures) {
    if (fig.carried) continue
    const busy = new Set(fig.arms.map((a) => Math.sign(a.to.x - fig.x) || 1))
    for (const rider of figures.filter((f) => f.carriedBy === fig.role)) {
      if (rider.carry === 'shoulders') busy.add(-1).add(1)
      else busy.add(carrySide(rider))
    }
    for (const side of [-1, 1]) {
      if (busy.has(side)) continue
      // The hand clears the shoulder line, so the arm reads against the torso
      // instead of disappearing into it.
      fig.arms.push({
        from: { x: fig.x + side * fig.box.halfShoulder * 0.72, y: fig.box.armY },
        to: { x: fig.x + side * (fig.box.halfShoulder + fig.box.limb * 0.75), y: fig.box.handY },
        at: 'rest',
        width: fig.box.limb,
      })
    }
  }

  // A contact shadow does the depth work the receding lines only hint at.
  for (const fig of figures) {
    if (fig.carried) continue
    fig.shadow = { cx: fig.x, cy: fig.box.feetY + 3, rx: fig.box.halfShoulder * 1.5, ry: 5 * fig.scale }
  }

  // Scale to the frame before labels are placed, so names follow the figures
  // they name instead of being positioned against pre-fit geometry.
  const fit = fitToStage(figures)

  for (const fig of figures) {
    if (fig.carry === 'hip') {
      // A hip rider overlaps the adult carrying them, so a name centred above
      // would sit on that adult's torso — dark text on a dark fill. Push it out
      // sideways instead, level with the rider's feet.
      //
      // Always the side they hang on, so the name and the child agree. In a
      // line-up that can put the name over the next person; every label is drawn
      // with a paper halo, so it stays readable over any fill. Choosing the side
      // by free space instead was worse — with the host counted as an obstacle
      // the name flipped onto the host, and without it, onto the next child.
      const away = carrySide(fig)
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
    fig.limbTone = shade(fig.tone, 0.72)
  }

  const depths = [...new Set(all.filter((f) => !f.carriedBy).map((f) => f.depth || 0))].sort((a, b) => b - a)

  return {
    figures,
    depths,
    stage: STAGE,
    ground: GROUND,
    depthLift: DEPTH_LIFT * fit,
    camera: CAMERA,
    fit,
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

      for (const link of contactsOf(fig)) {
        if (!CONTACT_POINTS.includes(link.at)) {
          at(pose, `"${fig.role}" takes hold at "${link.at}"; expected ${CONTACT_POINTS.join(', ')}`)
        }
        if (link.to === fig.role) at(pose, `"${fig.role}" is in contact with themselves`)
        else if (!pose.figures.some((f) => f.role === link.to)) {
          at(pose, `"${fig.role}" is in contact with "${link.to}", who is not in this pose`)
        }
      }
    }

    let laid
    try {
      laid = layoutPose(pose)
    } catch (error) {
      at(pose, error.message)
      continue
    }

    // A declared contact has to be physically possible. Two people three metres
    // apart cannot be holding a shoulder, and drawing the arm anyway produces a
    // diagram that looks authoritative and instructs the wrong thing.
    for (const fig of laid.figures) {
      for (const arm of fig.arms || []) {
        if (arm.at === 'rest') continue
        const reach = Math.hypot(arm.to.x - arm.from.x, arm.to.y - arm.from.y)
        if (reach > fig.box.armSpan * 1.15) {
          at(
            pose,
            `"${fig.role}" cannot reach that contact — ${Math.round(reach)}px of arm needed, ` +
              `${Math.round(fig.box.armSpan)}px available. Move them closer or drop the contact.`
          )
        }
      }
    }

    // Two bodies in the same place is a blocking error, not a drawing one. The
    // exception is a carry: a child on a hip is meant to overlap the adult
    // holding them, and only them.
    const held = (a, b) => a.carriedBy === b.role || b.carriedBy === a.role
    for (let i = 0; i < laid.figures.length; i++) {
      for (let j = i + 1; j < laid.figures.length; j++) {
        const a = laid.figures[i]
        const b = laid.figures[j]
        if (held(a, b) || (a.depth || 0) !== (b.depth || 0)) continue
        const clearance = (a.box.halfShoulder + b.box.halfShoulder) * 0.85
        if (Math.abs(a.x - b.x) < clearance) {
          at(pose, `"${a.role}" and "${b.role}" are drawn on top of each other — move one of them`)
        }
      }
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

  check('an arm is drawn only where contact is declared, and it lands on the grip', () => {
    const pose = {
      name: 'contact', lens: '85mm', distance: '12 ft',
      figures: [
        { role: 'A', height: 'adult', x: 42, depth: 0, contact: ['B'] },
        { role: 'B', height: 'adult', x: 58, depth: 0 },
      ],
    }
    const laid = layoutPose(pose)
    const a = laid.figures.find((f) => f.role === 'A')
    const b = laid.figures.find((f) => f.role === 'B')
    const held = (f) => f.arms.filter((arm) => arm.at !== 'rest')
    assert(held(a).length === 1, `A should hold once, got ${held(a).length}`)
    assert(held(b).length === 0, 'B declared no contact, so B holds nobody')
    assert(a.arms.length === 2 && b.arms.length === 2, 'both still have two arms, the spare at rest')
    assert(held(a)[0].from.x > a.x, 'the arm should leave the shoulder facing B')
    assert(held(a)[0].to.x < b.x, "the grip should land on B's near shoulder, not through B")
    assert(
      Math.abs(held(a)[0].to.y - (b.box.shoulderY + b.box.h * 0.03)) < 1,
      'a shoulder hold should land at shoulder height'
    )
  })

  check('the group is scaled up to fill the frame, feet still on the ground', () => {
    // A tight two-person pose: real spacing, so it needs the fit to use the sheet.
    const tight = {
      name: 'tight', lens: '85mm', distance: '12 ft',
      figures: [
        { role: 'A', height: 'adult', x: 46, depth: 0 },
        { role: 'B', height: 'adult', x: 54, depth: 0 },
      ],
    }
    const laid = layoutPose(tight)
    assert(laid.fit > 1, `a tight pose should scale up, got ${laid.fit}`)
    assert(laid.fit <= FIT_MAX_SCALE + 1e-9, 'and never past the cap')
    for (const fig of laid.figures) {
      assert(Math.abs(fig.box.feetY - GROUND) < 0.5, 'front-plane feet stay on the ground line')
      assert(fig.box.headTop >= FIT_TOP - 1, 'and heads stay inside the frame')
    }
    const [a, b] = laid.figures
    assert(Math.abs(a.x - b.x) > 8 * 8.2 * 0.9, 'the gap grows with the figures, keeping spacing honest')

    // A pose already wide enough is left alone rather than shrunk.
    const wide = {
      name: 'wide', lens: '85mm', distance: '12 ft',
      figures: [
        { role: 'A', height: 'adult', x: 2, depth: 0 },
        { role: 'B', height: 'adult', x: 98, depth: 0 },
      ],
    }
    assert(layoutPose(wide).fit <= 1, 'a full-width pose needs no scaling up')
  })

  check('contact reaches the correct side when the target is to the left', () => {
    const pose = {
      name: 'mirror', lens: '85mm', distance: '12 ft',
      figures: [
        { role: 'A', height: 'adult', x: 58, depth: 0, contact: ['B'] },
        { role: 'B', height: 'adult', x: 42, depth: 0 },
      ],
    }
    const a = layoutPose(pose).figures.find((f) => f.role === 'A')
    const b = layoutPose(pose).figures.find((f) => f.role === 'B')
    assert(a.arms[0].from.x < a.x, 'the arm should leave the shoulder facing left')
    assert(a.arms[0].to.x > b.x, "the grip should land on B's right shoulder")
  })

  check('a contact nobody could reach is reported', () => {
    const problems = validatePoses([{
      name: 'too-far', lens: '85mm', distance: '12 ft',
      figures: [
        { role: 'A', height: 'adult', x: 5, depth: 0, contact: ['B'] },
        { role: 'B', height: 'adult', x: 95, depth: 0 },
      ],
    }])
    assert(problems.some((p) => p.includes('cannot reach')), `expected a reach report, got: ${problems.join('; ')}`)
  })

  check('a contact with a stranger or with oneself is reported', () => {
    const problems = validatePoses([{
      name: 'bad-contact', lens: '85mm', distance: '12 ft',
      figures: [
        { role: 'A', height: 'adult', x: 45, depth: 0, contact: ['Nobody', 'A'] },
        { role: 'B', height: 'adult', x: 55, depth: 0, contact: [{ to: 'A', at: 'elbow' }] },
      ],
    }])
    assert(problems.some((p) => p.includes('not in this pose')), 'expected an unknown-target report')
    assert(problems.some((p) => p.includes('with themselves')), 'expected a self-contact report')
    assert(problems.some((p) => p.includes('takes hold at "elbow"')), 'expected an unknown-grip report')
  })

  check('a hip rider hangs their legs clear of the adult carrying them', () => {
    const pose = {
      name: 'hip', lens: '85mm', distance: '12 ft',
      figures: [
        { role: 'Dad', height: 'adult', x: 50, depth: 0 },
        { role: 'Baby', height: 'infant', carriedBy: 'Dad', carry: 'hip', carryOffset: -22 },
      ],
    }
    const baby = layoutPose(pose).figures.find((f) => f.role === 'Baby')
    assert(baby.rig && baby.rig.kind === 'hip', 'a hip rider needs a hip rig')
    const [, , legEndX] = baby.rig.legs[0]
    assert(legEndX < baby.x, 'legs should hang out to the free side, away from the adult')
    assert(baby.rig.hostArms.length === 1, 'one arm supports a hip carry')
  })

  check('a shoulder rider straddles, with the adult holding both shins', () => {
    const pose = {
      name: 'shoulders', lens: '85mm', distance: '12 ft',
      figures: [
        { role: 'Mom', height: 'adult', x: 50, depth: 0 },
        { role: 'Kid', height: 'child-small', carriedBy: 'Mom', carry: 'shoulders' },
      ],
    }
    const laid = layoutPose(pose)
    const kid = laid.figures.find((f) => f.role === 'Kid')
    const mom = laid.figures.find((f) => f.role === 'Mom')
    assert(kid.rig.legs.length === 2, 'a straddle needs two legs')
    assert(kid.rig.hostArms.length === 2, 'and two supporting arms')
    const [left, right] = kid.rig.legs.map((l) => l[2])
    assert(left < mom.x && right > mom.x, "legs should descend either side of the adult's head")
    assert(kid.rig.legs.every((l) => l[3] > kid.box.hipY), 'legs should descend, not rise')
  })

  check("a hip rider's name follows the side they hang on, clear of the host", () => {
    const side = (offset) => {
      const laid = layoutPose({
        name: 'hip-label', lens: '85mm', distance: '12 ft',
        figures: [
          { role: 'Mom', height: 'adult', x: 50, depth: 0 },
          { role: 'Baby', height: 'infant', carriedBy: 'Mom', carry: 'hip', carryOffset: offset },
        ],
      })
      return {
        baby: laid.figures.find((f) => f.role === 'Baby'),
        mom: laid.figures.find((f) => f.role === 'Mom'),
      }
    }
    const right = side(22)
    assert(right.baby.labelX > right.baby.x, 'a right hip names to the right')
    assert(right.baby.labelAnchor === 'start', 'and grows rightward')
    assert(right.baby.labelX > right.mom.x, "clear of the host's centre line")

    const left = side(-22)
    assert(left.baby.labelX < left.baby.x, 'a left hip names to the left')
    assert(left.baby.labelAnchor === 'end', 'and grows leftward')
    assert(left.baby.labelX < left.mom.x, "also clear of the host's centre line")
  })

  check('two bodies in the same place are reported, but a carry is not', () => {
    const problems = validatePoses([{
      name: 'stacked', lens: '85mm', distance: '12 ft',
      figures: [
        { role: 'A', height: 'adult', x: 50, depth: 0 },
        { role: 'B', height: 'adult', x: 51, depth: 0 },
      ],
    }])
    assert(problems.some((p) => p.includes('on top of each other')), 'expected an overlap report')

    const carry = validatePoses([{
      name: 'carry', lens: '85mm', distance: '12 ft',
      figures: [
        { role: 'Mom', height: 'adult', x: 50, depth: 0 },
        { role: 'Baby', height: 'infant', carriedBy: 'Mom', carry: 'hip', carryOffset: -22 },
      ],
    }])
    assert(!carry.some((p) => p.includes('on top of each other')), 'a carried child may overlap their host')
  })

  check('every standing figure gets a contact shadow, carried ones do not', () => {
    const pose = {
      name: 'shadow', lens: '85mm', distance: '12 ft',
      figures: [
        { role: 'Dad', height: 'adult', x: 40, depth: 0 },
        { role: 'Far', height: 'adult', x: 70, depth: 1 },
        { role: 'Baby', height: 'infant', carriedBy: 'Dad', carry: 'hip', carryOffset: -22 },
      ],
    }
    const laid = layoutPose(pose)
    const dad = laid.figures.find((f) => f.role === 'Dad')
    const far = laid.figures.find((f) => f.role === 'Far')
    assert(laid.figures.find((f) => f.role === 'Baby').shadow === undefined, 'a carried figure has no ground contact')
    assert(dad.shadow && far.shadow, 'standing figures cast one')
    assert(far.shadow.rx < dad.shadow.rx, 'a figure further back casts a smaller shadow')
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
