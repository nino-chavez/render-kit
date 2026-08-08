#!/usr/bin/env node
/**
 * Fetch a small OpenStreetMap extract for a site map, and record where it came
 * from. Nothing about a location may be typed by hand — the extract is the only
 * source of geometry, and lib/map-project.mjs refuses to render a place that is
 * not in it.
 *
 *   node scripts/fetch-osm-extract.mjs \
 *     --bbox 41.8160,-88.1110,41.8215,-88.1050 \
 *     --out templates/site-map/danada-extract.json \
 *     --note "Danada Forest Preserve — Wheaton, IL"
 *
 * Overpass mirrors go down. The script tries each in turn and records which one
 * answered, so a later re-fetch knows what produced the committed data.
 */

import { writeFileSync } from 'node:fs'
import process from 'node:process'

const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
]

const KEEP_HIGHWAY = new Set(['path', 'footway', 'track', 'cycleway', 'bridleway'])

function parseArgs(argv) {
  const opts = {}
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '')
    opts[key] = argv[i + 1]
  }
  return opts
}

function query(bbox) {
  return `[out:json][timeout:90];
(
  way["highway"~"^(path|footway|track|cycleway|bridleway)$"](${bbox});
  way["amenity"="parking"](${bbox});
  way["leisure"](${bbox});
  way["building"](${bbox});
  way["tourism"](${bbox});
  way["amenity"](${bbox});
);
out geom;`
}

// Every Overpass mirror rate-limits or 406s a request without a real User-Agent.
// Node's fetch does not send one, so this is required, not decorative.
const USER_AGENT = process.env.OSM_USER_AGENT
  || 'render-kit-site-map/1.0 (+https://github.com/nino-chavez/render-kit)'

async function fetchFromAnyMirror(ql) {
  const failures = []
  for (const mirror of MIRRORS) {
    try {
      const response = await fetch(mirror, {
        method: 'POST',
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        body: new URLSearchParams({ data: ql }),
      })
      const text = await response.text()
      if (!response.ok || !text.trimStart().startsWith('{')) {
        failures.push(`${mirror}: ${response.status} ${text.slice(0, 120).replace(/\s+/g, ' ')}`)
        continue
      }
      return { mirror, data: JSON.parse(text) }
    } catch (error) {
      failures.push(`${mirror}: ${error.message}`)
    }
  }
  throw new Error(`every Overpass mirror failed:\n  ${failures.join('\n  ')}`)
}

function trim(elements) {
  // Ways only, geometry required, and only the kinds a site map draws. Everything
  // else is bulk that would make the committed extract unreviewable.
  return elements
    .filter((e) => e.type === 'way' && Array.isArray(e.geometry) && e.geometry.length > 1)
    .filter((e) => {
      const t = e.tags || {}
      return KEEP_HIGHWAY.has(t.highway) || t.amenity || t.leisure || t.building || t.tourism
    })
    .map((e) => ({
      type: e.type,
      id: e.id,
      tags: e.tags,
      nodes: e.nodes,
      geometry: e.geometry.map((p) => ({ lat: p.lat, lon: p.lon })),
    }))
    .sort((a, b) => a.id - b.id)
}

const opts = parseArgs(process.argv.slice(2))
if (!opts.bbox || !opts.out) {
  console.error('Usage: node scripts/fetch-osm-extract.mjs --bbox <s,w,n,e> --out <file.json> [--note "..."] [--date YYYY-MM-DD]')
  process.exit(1)
}

const { mirror, data } = await fetchFromAnyMirror(query(opts.bbox))
const elements = trim(data.elements || [])
if (elements.length === 0) {
  console.error(`No usable elements in the response from ${mirror}. Check the bbox.`)
  process.exit(1)
}

writeFileSync(opts.out, `${JSON.stringify({
  // ODbL requires attribution wherever this data appears, including on anything
  // rendered from it — site-map.html carries the same line on the sheet.
  attribution: '© OpenStreetMap contributors, ODbL 1.0 — https://www.openstreetmap.org/copyright',
  note: opts.note || '',
  bbox: opts.bbox,
  fetchedFrom: mirror,
  fetchedOn: opts.date || '',
  query: query(opts.bbox),
  elements,
}, null, 2)}\n`)

console.log(`✓ ${elements.length} element(s) from ${mirror} → ${opts.out}`)
