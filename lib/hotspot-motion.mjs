/**
 * hotspotToMotion — the one piece of walkthrough logic that didn't already exist.
 *
 * Turns a captured hotspot (rect, point, or none) + its action `kind` into a camera move
 * over the flat still: how far to zoom, where to aim, whether a click ripples. This is the
 * generalization of the highlight-ring math that was solved once by hand for a single promo
 * frame — pure, deterministic, and unit-tested so it holds across arbitrary rects and
 * resolutions rather than one lucky case.
 *
 * All geometry is in the manifest's LOGICAL space (0..width, 0..height); outputs are
 * resolution-independent percentages, so the same result drives any canvas size.
 *
 * @param {{x:number,y:number,w:number,h:number}|null} hotspot
 * @param {string} kind  one of manifest STEP_KINDS
 * @param {{width:number, height:number}} frame  logical capture size
 * @returns {{ scale:number, originX:number, originY:number, ripple:boolean,
 *             rippleX:number, rippleY:number }}  origins/ripple in percent (0..100)
 */
export function hotspotToMotion(hotspot, kind, frame) {
  const { width, height } = frame

  // How much of the frame's short side the target should occupy after the zoom. Bigger =
  // tighter zoom. Capped by MAX_SCALE so a tiny control never blows up into a soft close-up.
  const FILL = 0.5
  const MAX_SCALE = 2.0
  const MIN_SCALE = 1.0
  // Keep the focal point off the extreme edge so the emphasized region stays comfortably in
  // view (a target jammed to 0%/100% reads as clipped even though the scaled image covers).
  const EDGE = 12

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi))
  const pct = (v, total) => clamp((v / total) * 100, EDGE, 100 - EDGE)

  // No target → a slow, full-frame Ken-Burns drift. Aim at the point if one was given.
  if (!hotspot) {
    return { scale: 1.06, originX: 50, originY: 50, ripple: false, rippleX: 50, rippleY: 50 }
  }

  const cx = hotspot.x
  const cy = hotspot.y
  const originX = pct(cx, width)
  const originY = pct(cy, height)
  const hasRect = hotspot.w > 0 && hotspot.h > 0

  // annotate / scroll → the still already shows the resolved state; hold near full-frame with
  // a gentle drift toward the point of interest rather than a hard zoom.
  if (kind === 'annotate' || kind === 'scroll') {
    return { scale: hasRect ? 1.12 : 1.08, originX, originY, ripple: false, rippleX: originX, rippleY: originY }
  }

  // Point beat (coordinate, no rect): a fixed modest push toward the point.
  if (!hasRect) {
    const ripple = kind === 'click' || kind === 'select'
    return { scale: 1.25, originX, originY, ripple, rippleX: originX, rippleY: originY }
  }

  // Rect target: zoom so the rect fills ~FILL of the frame's short side, clamped.
  const scaleForW = (width * FILL) / hotspot.w
  const scaleForH = (height * FILL) / hotspot.h
  const scale = clamp(Math.min(scaleForW, scaleForH), MIN_SCALE, MAX_SCALE)

  // A ripple lands where the pointer would (click/select on a real control).
  const ripple = kind === 'click' || kind === 'select'
  return { scale, originX, originY, ripple, rippleX: originX, rippleY: originY }
}

/**
 * coverFit — how a still of the manifest's logical size lands in a canvas under CSS
 * `object-fit: cover`: one uniform scale `k`, then centered, so the overflowing axis is cropped
 * equally on both sides. `ox`/`oy` are the canvas-px offsets of the still's top-left corner
 * (≤ 0 on the cropped axis, 0 when the aspects match).
 *
 * @param {{width:number, height:number}} frame   logical capture size
 * @param {{width:number, height:number}} canvas  output box
 * @returns {{k:number, ox:number, oy:number}}
 */
export function coverFit(frame, canvas) {
  const k = Math.max(canvas.width / frame.width, canvas.height / frame.height)
  return { k, ox: (canvas.width - frame.width * k) / 2, oy: (canvas.height - frame.height * k) / 2 }
}

/**
 * hotspotToCanvas — a manifest hotspot (CENTER x/y + w/h, logical px) mapped into the canvas the
 * still is cover-fitted to. Returns the same shape in canvas px, or null for no target. Without
 * this, a template that scales x and y independently (canvas/width, canvas/height) aims too high
 * or too low whenever the still's aspect differs from the canvas, because cover-fit crops.
 */
export function hotspotToCanvas(hotspot, frame, canvas) {
  if (!hotspot) return null
  const { k, ox, oy } = coverFit(frame, canvas)
  return { x: hotspot.x * k + ox, y: hotspot.y * k + oy, w: hotspot.w * k, h: hotspot.h * k }
}

/**
 * motionForCanvas — hotspotToMotion evaluated in canvas space, for a template whose still fills
 * the whole canvas with `object-fit: cover` and whose transform-origin is a percent of that
 * canvas box (templates/walkthrough/motion.html). When the aspects match, the result equals
 * hotspotToMotion's in logical space.
 */
export function motionForCanvas(hotspot, kind, frame, canvas) {
  return hotspotToMotion(hotspotToCanvas(hotspot, frame, canvas), kind, canvas)
}

// node lib/hotspot-motion.mjs --selftest
if (process.argv[1] && process.argv[1].endsWith('hotspot-motion.mjs') && process.argv.includes('--selftest')) {
  const frame = { width: 1280, height: 720 }
  const eq = (a, b, eps = 0.01) => Math.abs(a - b) < eps
  const cases = []
  const check = (name, cond) => cases.push([name, cond])

  // null hotspot → gentle full-frame, centered.
  let m = hotspotToMotion(null, 'annotate', frame)
  check('null → gentle scale', eq(m.scale, 1.06))
  check('null → centered', eq(m.originX, 50) && eq(m.originY, 50))
  check('null → no ripple', m.ripple === false)

  // Small click target → clamped to MAX_SCALE, ripple on, aimed at center.
  m = hotspotToMotion({ x: 1170, y: 110, w: 40, h: 20 }, 'click', frame)
  check('small click → maxed scale', eq(m.scale, 2.0))
  check('small click → ripple on', m.ripple === true)
  check('small click → origin clamped off edge', m.originX <= 88 && m.originX >= 12)

  // Wide type field → modest zoom, no ripple.
  m = hotspotToMotion({ x: 574, y: 350, w: 602, h: 44 }, 'type', frame)
  check('wide type → scale >= 1', m.scale >= 1.0 && m.scale <= 2.0)
  check('type → no ripple', m.ripple === false)

  // Point beat → fixed push, ripple only for click/select.
  m = hotspotToMotion({ x: 600, y: 300, w: 0, h: 0 }, 'click', frame)
  check('point click → fixed 1.25', eq(m.scale, 1.25))
  check('point click → ripple on', m.ripple === true)
  m = hotspotToMotion({ x: 600, y: 300, w: 0, h: 0 }, 'annotate', frame)
  check('point annotate → no ripple', m.ripple === false)

  // Origin never lands on the extreme edge.
  m = hotspotToMotion({ x: 0, y: 0, w: 50, h: 50 }, 'click', frame)
  check('top-left target → origin held off edge', m.originX >= 12 && m.originY >= 12)

  // Cover-fit mapping. A 16:10 still (1440×900) is the case that broke on 2026-09-24.
  const still = { width: 1440, height: 900 }
  const target = { x: 300, y: 150, w: 100, h: 40 }

  // Matching aspect (1920×1200): uniform scale, no offset, and motion identical to logical space.
  let f = coverFit(still, { width: 1920, height: 1200 })
  check('matching aspect → k = 4/3', eq(f.k, 1920 / 1440))
  check('matching aspect → no offset', eq(f.ox, 0) && eq(f.oy, 0))
  let hc = hotspotToCanvas(target, still, { width: 1920, height: 1200 })
  check('matching aspect → center scales only', eq(hc.x, 400) && eq(hc.y, 200) && eq(hc.w, 133.33) && eq(hc.h, 53.33))
  const logical = hotspotToMotion(target, 'click', still)
  const canvasM = motionForCanvas(target, 'click', still, { width: 1920, height: 1200 })
  check('matching aspect → same motion as logical', eq(logical.scale, canvasM.scale) &&
    eq(logical.originX, canvasM.originX) && eq(logical.originY, canvasM.originY))

  // Wider canvas (1920×1080): width fits, height overflows and is cropped top and bottom.
  f = coverFit(still, { width: 1920, height: 1080 })
  check('wider canvas → k from width', eq(f.k, 1920 / 1440))
  check('wider canvas → crops top/bottom equally', eq(f.ox, 0) && eq(f.oy, (1080 - 1200) / 2))
  hc = hotspotToCanvas(target, still, { width: 1920, height: 1080 })
  check('wider canvas → y shifted up by the crop', eq(hc.x, 400) && eq(hc.y, 200 - 60))
  // The old per-axis mapping (y × 1080/900 = 180) lands 40 px low on this target.
  check('wider canvas → differs from per-axis scaling', !eq(hc.y, 150 * (1080 / 900)))

  // Taller canvas (1080×1080): height fits, width overflows and is cropped left and right.
  f = coverFit(still, { width: 1080, height: 1080 })
  check('taller canvas → k from height', eq(f.k, 1080 / 900))
  check('taller canvas → crops left/right equally', eq(f.oy, 0) && eq(f.ox, (1080 - 1728) / 2))
  hc = hotspotToCanvas(target, still, { width: 1080, height: 1080 })
  check('taller canvas → x shifted left by the crop', eq(hc.x, 300 * 1.2 - 324) && eq(hc.y, 180))

  check('null hotspot → null in canvas', hotspotToCanvas(null, still, { width: 1920, height: 1080 }) === null)

  const failed = cases.filter(([, ok]) => !ok)
  for (const [name, ok] of cases) console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (failed.length) {
    console.error(`\n${failed.length} check(s) failed`)
    process.exit(1)
  }
  console.log(`\nAll ${cases.length} checks passed`)
}
