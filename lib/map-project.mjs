/**
 * Site-map projection and its provenance gate.
 *
 * The rule this file exists to enforce: no geometry is ever typed by hand. A map
 * spec names OpenStreetMap element ids and nothing else, and every coordinate
 * drawn comes out of a fetched extract. A hallucinated trail handed to a family
 * navigating at 7am is the failure mode, so the checker asserts both halves —
 * every named element resolves, and the spec contains no coordinates at all.
 *
 *   node lib/map-project.mjs --selftest
 *   node lib/map-project.mjs build <spec.json> <extract.json> <variants.json>
 */

import { readFileSync, writeFileSync } from 'node:fs'
import process from 'node:process'

export const STAGE = { width: 1000, height: 560 }
export const PAD = { top: 30, right: 30, bottom: 54, left: 30 }

/** Keys that would mean somebody pasted a coordinate into the spec. */
const COORD_KEYS = /^(lat|lon|lng|latitude|longitude|coord|coords|coordinates|geometry|bbox)$/i

const EARTH_M_PER_DEG = 111320

export function metres(a, b) {
  const midLat = ((a.lat + b.lat) / 2) * (Math.PI / 180)
  const dy = (a.lat - b.lat) * EARTH_M_PER_DEG
  const dx = (a.lon - b.lon) * EARTH_M_PER_DEG * Math.cos(midLat)
  return Math.hypot(dx, dy)
}

export function indexExtract(extract) {
  const byId = new Map()
  for (const element of extract.elements || []) byId.set(`${element.type}/${element.id}`, element)
  return byId
}

export function centroid(element) {
  const g = element.geometry
  return {
    lat: g.reduce((sum, p) => sum + p.lat, 0) / g.length,
    lon: g.reduce((sum, p) => sum + p.lon, 0) / g.length,
  }
}

/**
 * Equirectangular projection fitted to the drawn features. At a few hundred
 * metres the difference from Mercator is far below a pixel, and staying linear
 * keeps the scale bar honest in both directions.
 */
export function makeProjection(points, margin = 0.12) {
  const lats = points.map((p) => p.lat)
  const lons = points.map((p) => p.lon)
  // Pad the frame so the route is not flush against the edges and labels have
  // somewhere to sit.
  const padLat = (Math.max(...lats) - Math.min(...lats)) * margin
  const padLon = (Math.max(...lons) - Math.min(...lons)) * margin
  const minLat = Math.min(...lats) - padLat
  const maxLat = Math.max(...lats) + padLat
  const minLon = Math.min(...lons) - padLon
  const maxLon = Math.max(...lons) + padLon
  const midLat = ((minLat + maxLat) / 2) * (Math.PI / 180)
  const lonScale = Math.cos(midLat)

  const spanX = (maxLon - minLon) * lonScale
  const spanY = maxLat - minLat
  const boxW = STAGE.width - PAD.left - PAD.right
  const boxH = STAGE.height - PAD.top - PAD.bottom
  const scale = Math.min(boxW / (spanX || 1e-9), boxH / (spanY || 1e-9))

  const offsetX = PAD.left + (boxW - spanX * scale) / 2
  const offsetY = PAD.top + (boxH - spanY * scale) / 2

  const project = (p) => ({
    x: offsetX + (p.lon - minLon) * lonScale * scale,
    // Latitude grows north, y grows down.
    y: offsetY + (maxLat - p.lat) * scale,
  })

  // Degrees of latitude per pixel, converted to metres — the scale bar's basis.
  project.metresPerPixel = EARTH_M_PER_DEG / scale
  return project
}

/**
 * Node graph over the trail ways the spec permits. Walking this — rather than
 * concatenating whole ways — is what keeps the drawn line and its distance
 * honest: a named way can run kilometres past the stop you needed it for.
 */
function trailGraph(wayIds, byId) {
  const position = new Map()
  const edges = new Map()
  const link = (a, b, weight) => {
    if (!edges.has(a)) edges.set(a, [])
    edges.get(a).push([b, weight])
  }
  for (const id of wayIds) {
    const way = byId.get(id)
    way.nodes.forEach((node, i) => position.set(node, way.geometry[i]))
    for (let i = 1; i < way.nodes.length; i++) {
      const weight = metres(way.geometry[i - 1], way.geometry[i])
      link(way.nodes[i - 1], way.nodes[i], weight)
      link(way.nodes[i], way.nodes[i - 1], weight)
    }
  }
  return { position, edges }
}

function nearestNode(graph, target) {
  let best = null
  let bestDistance = Infinity
  for (const [node, point] of graph.position) {
    const d = metres(point, target)
    if (d < bestDistance) {
      bestDistance = d
      best = node
    }
  }
  return best
}

/** Shortest path by metres. Small graph, so a sorted frontier is plenty. */
function shortestPath(graph, start, goal) {
  const best = new Map([[start, 0]])
  const cameFrom = new Map()
  const frontier = [[0, start]]
  while (frontier.length > 0) {
    frontier.sort((a, b) => a[0] - b[0])
    const [distance, node] = frontier.shift()
    if (node === goal) break
    if (distance > (best.get(node) ?? Infinity)) continue
    for (const [next, weight] of graph.edges.get(node) || []) {
      const candidate = distance + weight
      if (candidate < (best.get(next) ?? Infinity)) {
        best.set(next, candidate)
        cameFrom.set(next, node)
        frontier.push([candidate, next])
      }
    }
  }
  if (!best.has(goal)) return null
  const nodes = [goal]
  while (cameFrom.has(nodes[0])) nodes.unshift(cameFrom.get(nodes[0]))
  return { nodes, metres: best.get(goal), points: nodes.map((n) => graph.position.get(n)) }
}

/** True for a feature that is a line rather than an area — a trail, not a lot. */
export function isLinear(element) {
  return Boolean(element.tags?.highway)
}

/**
 * Where each stop actually is.
 *
 * An area — a parking lot, a building — is its centroid. A stop *on a trail* is
 * not: naming a 2 km regional trail and taking its midpoint put the marker half
 * a kilometre from where you would stand and inflated the leg to match. A linear
 * stop resolves to the point on it nearest where you are coming from, which is
 * where you actually join it.
 */
export function placePoints(spec, byId) {
  const points = []
  for (const place of spec.places || []) {
    const element = byId.get(place.osm)
    if (isLinear(element) && points.length > 0) {
      const previous = points[points.length - 1]
      points.push(element.geometry.reduce(
        (best, p) => (metres(p, previous) < metres(best, previous) ? p : best),
        element.geometry[0]
      ))
    } else {
      points.push(centroid(element))
    }
  }
  return points
}

/**
 * How far a stop may sit from the nearest permitted trail before the named
 * trails stop being the ones that serve it. On the Danada spec the real joins
 * are 30–40 m; anything past this is a stop the route does not actually reach.
 */
export const MAX_JOIN_METRES = 100

/** Walk the stops in order across the permitted trails. */
export function routeLegs(spec, byId, stops = placePoints(spec, byId)) {
  const graph = trailGraph(spec.route || [], byId)
  const joins = stops.map((stop) => {
    const node = nearestNode(graph, stop)
    return node ? { node, metres: metres(graph.position.get(node), stop) } : null
  })
  const legs = []
  for (let i = 1; i < stops.length; i++) {
    const from = joins[i - 1]
    const to = joins[i]
    const path = from && to ? shortestPath(graph, from.node, to.node) : null
    legs.push({
      from: spec.places[i - 1].label,
      to: spec.places[i].label,
      fromJoin: from,
      toJoin: to,
      path,
    })
  }
  return legs
}

/**
 * Resolve a spec against an extract into everything the template draws.
 */
export function resolveMap(spec, extract) {
  const byId = indexExtract(extract)

  const stops = placePoints(spec, byId)
  const places = (spec.places || []).map((place, i) => {
    const element = byId.get(place.osm)
    return { ...place, element, at: stops[i] }
  })

  // The walked line is the shortest path across the permitted trails, stop to
  // stop. Drawing whole ways instead reported 4.3 km for a 1.5 km walk, because
  // one named way is a regional trail running far past the stop it serves.
  const legs = routeLegs(spec, byId, stops)
  const line = []
  for (const leg of legs) {
    const points = leg.path?.points || []
    line.push(...(line.length && points.length ? points.slice(1) : points))
  }
  const routeMetres = legs.reduce((sum, leg) => sum + (leg.path?.metres || 0), 0)

  // Context: every other trail and parking area in the extract, drawn faintly so
  // the route reads against something rather than floating.
  const context = { trails: [], parking: [], buildings: [] }
  const routeIds = new Set(spec.route || [])
  for (const element of extract.elements || []) {
    const key = `${element.type}/${element.id}`
    const tags = element.tags || {}
    if (tags.amenity === 'parking') context.parking.push(element)
    else if (tags.building) context.buildings.push(element)
    else if (tags.highway && !routeIds.has(key)) context.trails.push(element)
  }

  // Fit to the walk and the stop points. Two things must stay out of the fit:
  // context (a regional trail running kilometres west would set the frame) and a
  // linear stop's full geometry (same problem, arriving through the front door).
  const project = makeProjection([...line, ...stops])
  const xy = (points) => points.map((p) => project(p))

  // Context is drawn only where it lands on the sheet. A feature partly outside
  // is kept and clipped by the viewBox; one entirely outside is dropped.
  const onStage = (points) => {
    const projected = xy(points)
    return projected.some((q) => q.x >= 0 && q.x <= STAGE.width && q.y >= 0 && q.y <= STAGE.height)
      ? projected
      : null
  }

  return {
    stage: STAGE,
    title: spec.title || '',
    subtitle: spec.subtitle || '',
    attribution: extract.attribution,
    places: places.map((p) => ({
      label: p.label,
      kind: p.kind,
      osm: p.osm,
      note: p.note || '',
      // Only areas get an outline. Drawing a linear stop's full extent would
      // trace a trail clean off the sheet and read as part of the walk.
      outline: isLinear(p.element) ? null : xy(p.element.geometry),
      at: project(p.at),
    })),
    route: {
      points: xy(line),
      metres: Math.round(routeMetres),
      legs: legs.map((leg) => ({ from: leg.from, to: leg.to, metres: Math.round(leg.path?.metres || 0) })),
    },
    context: {
      trails: context.trails.map((t) => onStage(t.geometry)).filter(Boolean),
      parking: context.parking.map((t) => onStage(t.geometry)).filter(Boolean),
      buildings: context.buildings.map((t) => onStage(t.geometry)).filter(Boolean),
    },
    scale: scaleBar(project.metresPerPixel),
  }
}

/** A round-number bar, sized to sit under a fifth of the frame. */
export function scaleBar(metresPerPixel) {
  const target = (STAGE.width - PAD.left - PAD.right) / 5
  const steps = [10, 20, 25, 50, 100, 200, 250, 500, 1000]
  const chosen = steps.find((m) => m / metresPerPixel >= target * 0.6) ?? steps[steps.length - 1]
  return { metres: chosen, pixels: chosen / metresPerPixel }
}

/** Walk a value tree looking for anything that smells like a pasted coordinate. */
function findCoordinates(value, path = '$') {
  const hits = []
  if (Array.isArray(value)) {
    value.forEach((item, i) => hits.push(...findCoordinates(item, `${path}[${i}]`)))
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (COORD_KEYS.test(key)) hits.push(`${path}.${key}`)
      hits.push(...findCoordinates(child, `${path}.${key}`))
    }
  } else if (typeof value === 'number') {
    // A decimal degree pasted from a map: magnitude in range, four or more places.
    const decimals = (String(value).split('.')[1] || '').length
    if (decimals >= 4 && Math.abs(value) > 1 && Math.abs(value) <= 180) hits.push(`${path} = ${value}`)
  }
  // A coordinate-named key holding a coordinate value matches twice. Report the
  // location once — two lines for one mistake reads like two mistakes.
  return hits.filter((hit, i) => !hits.some((other, j) => j !== i && other.startsWith(`${hit} =`)))
}

export function validateMapSpec(spec, extract) {
  const problems = []
  const byId = indexExtract(extract)

  if (!extract.attribution) problems.push('extract has no attribution — ODbL requires it on the rendered sheet')
  if (!extract.fetchedFrom) problems.push('extract does not record which Overpass mirror served it')
  if (!extract.fetchedOn) problems.push('extract does not record when it was fetched')

  // The whole point: geometry comes from the extract, never from the spec.
  for (const hit of findCoordinates(spec)) {
    problems.push(`spec carries a coordinate at ${hit} — name an OSM element instead, so the geometry stays checkable`)
  }

  if (!Array.isArray(spec.places) || spec.places.length < 2) {
    problems.push('spec needs at least two places — a start and somewhere to go')
  }

  for (const place of spec.places || []) {
    if (!place.label) problems.push('a place is missing its label')
    if (!place.osm) { problems.push(`"${place.label}" names no OSM element`); continue }
    const element = byId.get(place.osm)
    if (!element) problems.push(`"${place.label}" names ${place.osm}, which is not in the extract`)
    else if (!element.geometry?.length) problems.push(`${place.osm} has no geometry in the extract`)
  }

  const route = spec.route || []
  if (route.length === 0) {
    problems.push('spec has no route — name the trail ways that connect the stops')
  }
  for (const id of route) {
    const element = byId.get(id)
    if (!element) problems.push(`route names ${id}, which is not in the extract`)
    else if (!element.tags?.highway) problems.push(`route names ${id}, which is not a path (${JSON.stringify(element.tags)})`)
  }

  if (problems.length > 0) return problems

  // The real requirement is not that the listed ways form a chain in order, but
  // that they actually connect each stop to the next. A line that merely looks
  // walkable is the thing this whole file exists to prevent.
  for (const leg of routeLegs(spec, byId)) {
    if (!leg.path) problems.push(`the named trails do not connect "${leg.from}" to "${leg.to}"`)
    // A path between the two nearest nodes proves nothing if those nodes are
    // nowhere near the stops. Cutting the route to one way still "connected"
    // every stop until this check existed.
    for (const [label, join] of [[leg.from, leg.fromJoin], [leg.to, leg.toJoin]]) {
      if (!join) problems.push(`no named trail reaches "${label}" at all`)
      else if (join.metres > MAX_JOIN_METRES) {
        problems.push(`the nearest named trail is ${Math.round(join.metres)} m from "${label}" — over the ${MAX_JOIN_METRES} m join limit, so these are not the trails that serve it`)
      }
    }
  }

  if (problems.length > 0) return problems

  const resolved = resolveMap(spec, extract)
  // The walk and every stop marker must land on the sheet. An area outline that
  // runs past the edge is fine and expected — the equestrian paddocks are larger
  // than the frame — and the viewBox clips it, same as context.
  const mustFit = [...resolved.route.points, ...resolved.places.map((p) => p.at)]
  const stray = mustFit.filter((p) => p.x < 0 || p.x > STAGE.width || p.y < 0 || p.y > STAGE.height)
  if (stray.length > 0) {
    problems.push(`${stray.length} route point(s) or stop marker(s) land outside the stage`)
  }
  if (resolved.route.metres < 1) problems.push('the resolved route has no length')

  return problems
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function selftest() {
  const checks = []
  const check = (name, fn) => {
    try { fn(); checks.push(`✓ ${name}`) }
    catch (error) { checks.push(`✗ ${name} — ${error.message}`) }
  }
  const assert = (condition, message) => { if (!condition) throw new Error(message) }

  const extract = {
    attribution: '© OpenStreetMap contributors',
    fetchedFrom: 'test',
    fetchedOn: '2026-01-01',
    elements: [
      { type: 'way', id: 1, tags: { highway: 'footway' }, nodes: [10, 11], geometry: [{ lat: 41.8, lon: -88.11 }, { lat: 41.801, lon: -88.109 }] },
      { type: 'way', id: 2, tags: { highway: 'footway' }, nodes: [11, 12], geometry: [{ lat: 41.801, lon: -88.109 }, { lat: 41.802, lon: -88.108 }] },
      { type: 'way', id: 3, tags: { highway: 'footway' }, nodes: [90, 91], geometry: [{ lat: 41.9, lon: -88.2 }, { lat: 41.901, lon: -88.199 }] },
      { type: 'way', id: 4, tags: { amenity: 'parking' }, nodes: [20, 21, 22], geometry: [{ lat: 41.7999, lon: -88.1101 }, { lat: 41.8001, lon: -88.1101 }, { lat: 41.8, lon: -88.1099 }] },
      { type: 'way', id: 5, tags: { building: 'yes' }, nodes: [30, 31, 32], geometry: [{ lat: 41.8019, lon: -88.1081 }, { lat: 41.8021, lon: -88.1081 }, { lat: 41.802, lon: -88.1079 }] },
      { type: 'way', id: 6, tags: { building: 'yes' }, nodes: [40, 41, 42], geometry: [{ lat: 41.8999, lon: -88.1999 }, { lat: 41.9001, lon: -88.1999 }, { lat: 41.9, lon: -88.1997 }] },
    ],
  }
  const spec = {
    title: 't',
    places: [
      { label: 'Park', kind: 'parking', osm: 'way/4' },
      { label: 'End', kind: 'stop', osm: 'way/5' },
    ],
    route: ['way/1', 'way/2'],
  }

  check('a sound spec passes', () => {
    const problems = validateMapSpec(spec, extract)
    assert(problems.length === 0, problems.join('; '))
  })

  check('a pasted coordinate is rejected', () => {
    const bad = JSON.parse(JSON.stringify(spec))
    bad.places[0].lat = 41.8183
    const problems = validateMapSpec(bad, extract)
    assert(problems.some((p) => p.includes('carries a coordinate')), `expected a coordinate report, got: ${problems.join('; ')}`)
  })

  check('a bare decimal degree is rejected even without a coordinate key', () => {
    const bad = JSON.parse(JSON.stringify(spec))
    bad.places[0].nudge = -88.10766
    const problems = validateMapSpec(bad, extract)
    assert(problems.some((p) => p.includes('carries a coordinate')), `expected a coordinate report, got: ${problems.join('; ')}`)
  })

  check('an element absent from the extract is rejected', () => {
    const bad = JSON.parse(JSON.stringify(spec))
    bad.places[1].osm = 'way/99999'
    const problems = validateMapSpec(bad, extract)
    assert(problems.some((p) => p.includes('not in the extract')), 'expected a missing-element report')
  })

  check('trails that do not reach the next stop are rejected', () => {
    // way/3 is an island a few kilometres away, and way/6 sits on it. No walk
    // exists from the parking lot to it across the named trails.
    const bad = JSON.parse(JSON.stringify(spec))
    bad.places[1].osm = 'way/6'
    bad.route = ['way/1', 'way/2', 'way/3']
    const problems = validateMapSpec(bad, extract)
    assert(problems.some((p) => p.includes('do not connect')), `expected a no-connection report, got: ${problems.join('; ')}`)
  })

  check('a listed trail the walk does not need is not an error', () => {
    const extra = JSON.parse(JSON.stringify(spec))
    extra.route = ['way/1', 'way/2', 'way/3']
    const problems = validateMapSpec(extra, extract)
    assert(problems.length === 0, `spare trails should be allowed, got: ${problems.join('; ')}`)
  })

  check('a stop the named trails do not come near is rejected', () => {
    // way/1 and way/2 run past the parking lot but nowhere near way/6, which
    // sits kilometres away — the nearest node is real, and useless.
    const bad = JSON.parse(JSON.stringify(spec))
    bad.places[1].osm = 'way/6'
    const problems = validateMapSpec(bad, extract)
    assert(problems.some((p) => p.includes('join limit')), `expected a join-distance report, got: ${problems.join('; ')}`)
  })

  check('a coordinate is reported once, not once per reason', () => {
    const bad = JSON.parse(JSON.stringify(spec))
    bad.places[0].lat = 41.8183
    const hits = validateMapSpec(bad, extract).filter((p) => p.includes('carries a coordinate'))
    assert(hits.length === 1, `expected one report, got ${hits.length}: ${hits.join(' | ')}`)
  })

  check('per-leg distances are reported', () => {
    const resolved = resolveMap(spec, extract)
    assert(resolved.route.legs.length === 1, 'two stops make one leg')
    assert(resolved.route.legs[0].metres > 0, 'the leg should have a measured length')
    assert(resolved.route.legs[0].from === 'Park' && resolved.route.legs[0].to === 'End', 'legs should name their stops')
  })

  check('an extract without attribution is rejected', () => {
    const problems = validateMapSpec(spec, { ...extract, attribution: '' })
    assert(problems.some((p) => p.includes('attribution')), 'expected an attribution report')
  })

  check('route length is measured from the chained geometry', () => {
    const resolved = resolveMap(spec, extract)
    assert(resolved.route.metres > 50 && resolved.route.metres < 500, `unexpected route length ${resolved.route.metres} m`)
  })

  check('the scale bar reports a round number of metres', () => {
    const resolved = resolveMap(spec, extract)
    assert([10, 20, 25, 50, 100, 200, 250, 500, 1000].includes(resolved.scale.metres), `odd scale ${resolved.scale.metres}`)
    assert(resolved.scale.pixels > 0, 'scale bar has no width')
  })

  for (const line of checks) console.log(`  ${line}`)
  const failed = checks.filter((c) => c.startsWith('✗')).length
  console.log(failed === 0 ? `\nAll ${checks.length} checks passed` : `\n${failed} of ${checks.length} checks failed`)
  return failed === 0
}

if (process.argv[1] && process.argv[1].endsWith('map-project.mjs')) {
  const args = process.argv.slice(2)

  if (args.includes('--selftest')) process.exit(selftest() ? 0 : 1)

  if (args[0] === 'build') {
    const [, specPath, extractPath, outPath] = args
    if (!specPath || !extractPath || !outPath) {
      console.error('Usage: node lib/map-project.mjs build <spec.json> <extract.json> <variants.json>')
      process.exit(1)
    }
    const spec = JSON.parse(readFileSync(specPath, 'utf8'))
    const extract = JSON.parse(readFileSync(extractPath, 'utf8'))
    const problems = validateMapSpec(spec, extract)
    if (problems.length > 0) {
      console.error(`${problems.length} problem(s) in ${specPath}:`)
      for (const problem of problems) console.error(`  ${problem}`)
      process.exit(1)
    }
    const resolved = resolveMap(spec, extract)
    writeFileSync(outPath, JSON.stringify([{ name: spec.name, map: resolved }], null, 2))
    console.log(`✓ ${resolved.places.length} stop(s), ${resolved.route.metres} m of real trail → ${outPath}`)
    process.exit(0)
  }

  console.error('Usage: node lib/map-project.mjs [--selftest | build <spec.json> <extract.json> <variants.json>]')
  process.exit(1)
}
