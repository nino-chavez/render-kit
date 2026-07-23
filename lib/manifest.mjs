/**
 * Walkthrough manifest — the shared contract every emitter reads.
 *
 * ONE capture produces ONE manifest; each emitter (interactive / video / thumbs) turns that
 * same manifest into a different artifact, so the outputs can never drift. A capture harness
 * (rally-hq's record-interactive.spec.ts is the reference producer) drives a live app and,
 * per step, writes: a clean still, the action `kind`, a `caption`, and the target `hotspot`
 * rect. Any app that can emit this shape plugs into every render-kit walkthrough emitter.
 *
 * Coordinate space: `hotspot` is in LOGICAL capture pixels — the same width×height the
 * manifest declares, NOT the still's raw pixel dimensions. A still captured at
 * deviceScaleFactor 3 is 3× those pixels but still maps to the logical box; emitters scale
 * from width/height, so a high-DPI still just means a crisper zoom, never shifted overlays.
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

// The action taxonomy the capture side emits. Each value is a hint for which motion shape a
// visual emitter applies (a click ripples, a scroll pans, an annotate holds full-frame) — a
// small fixed set on purpose. Extend here once and every emitter learns the new kind.
export const STEP_KINDS = ['click', 'type', 'scroll', 'select', 'annotate']

// Bump only on a breaking change to the shape below. A manifest with no version is treated as
// v1 (the de-facto shape rally-hq shipped before this contract was named), never rejected.
export const SCHEMA_VERSION = 1

/**
 * Load, validate, and normalize a walkthrough manifest.
 * @returns {{ schemaVersion:number, label:string, title:string, width:number, height:number,
 *   srcDir:string, steps:Array<{frame:string, kind:string, caption:string,
 *   hotspot:{x:number,y:number,w:number,h:number}|null}> }}
 */
export function loadManifest(manifestPath) {
  if (!existsSync(manifestPath)) throw new Error(`manifest not found: ${manifestPath}`)

  let deck
  try {
    deck = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (err) {
    throw new Error(`manifest is not valid JSON: ${manifestPath} — ${err.message}`)
  }

  const version = deck.schemaVersion ?? SCHEMA_VERSION
  if (version !== SCHEMA_VERSION) {
    throw new Error(
      `manifest schemaVersion ${version} not supported (this render-kit reads v${SCHEMA_VERSION})`
    )
  }

  const label = deck.label
  if (!label || typeof label !== 'string') {
    throw new Error('manifest.label is required (the capture folder name holding the stills)')
  }
  if (!Number.isFinite(deck.width) || !Number.isFinite(deck.height)) {
    throw new Error('manifest.width and manifest.height are required numbers (logical capture size)')
  }
  if (!Array.isArray(deck.steps) || deck.steps.length === 0) {
    throw new Error('manifest.steps must be a non-empty array')
  }

  // Stills live in a sibling folder named after the label (the producer's convention).
  const srcDir = join(dirname(manifestPath), label)
  if (!existsSync(srcDir)) throw new Error(`stills folder not found: ${srcDir}`)

  const steps = deck.steps.map((s, idx) => {
    if (!s || typeof s.frame !== 'string') {
      throw new Error(`step ${idx}: "frame" (still filename) is required`)
    }
    if (s.kind != null && !STEP_KINDS.includes(s.kind)) {
      throw new Error(
        `step ${idx}: unknown kind "${s.kind}" — expected one of ${STEP_KINDS.join(', ')}`
      )
    }
    return {
      frame: s.frame,
      kind: s.kind || 'annotate',
      caption: s.caption || '',
      hotspot: normalizeHotspot(s.hotspot),
    }
  })

  // Title: explicit, else the tour id, else the label — title-cased for display.
  const rawTitle = deck.title || deck.tour || label
  const title = String(rawTitle)
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())

  return { schemaVersion: version, label, title, width: deck.width, height: deck.height, srcDir, steps }
}

// A hotspot is either a rect ({x,y,w,h}, target element), a point ({x,y,w:0,h:0}, a
// coordinate/center beat), or null (no target — full-frame). Anything malformed becomes null
// rather than throwing: a missing hotspot is a legitimate authoring choice, not an error.
function normalizeHotspot(hs) {
  if (!hs || typeof hs !== 'object') return null
  const { x, y, w, h } = hs
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return { x, y, w: Number.isFinite(w) ? w : 0, h: Number.isFinite(h) ? h : 0 }
}
