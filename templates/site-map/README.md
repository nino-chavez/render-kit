# Site map

Where to park, the stops in order, and the real walk between them.

```bash
node scripts/fetch-osm-extract.mjs \
  --bbox 41.8160,-88.1110,41.8215,-88.1050 \
  --out templates/site-map/danada-extract.json \
  --note "Danada Forest Preserve — Wheaton, DuPage County, IL" \
  --date 2026-08-07

node lib/map-project.mjs build \
  templates/site-map/danada.json templates/site-map/danada-extract.json /tmp/variants.json

render-kit templates/site-map/site-map.html --out-dir ./out --variants /tmp/variants.json
```

The fetch is a one-off; the extract is committed. The middle command is the gate.

## The rule

**No geometry is ever typed by hand.** The spec names OpenStreetMap element ids
and nothing else. Every coordinate on the sheet comes out of the extract.

That is the whole design. A model asked to draw a trail map will produce
plausible geography, and a family navigating by it at 7am will not find the
parking lot. So the checker asserts both halves: every named element resolves in
the extract, **and** the spec contains no coordinates at all — not under a
`lat`/`lon` key, and not as a bare decimal degree hidden in some other field.
Asserting only the first half would let the next person paste a coordinate in
beside the id "just to nudge the marker" and pass.

## Spec shape

```json
{
  "name": "danada-morning",
  "title": "Danada — Saturday morning",
  "subtitle": "Park once. Three stops on foot, north along the trail.",
  "places": [
    { "label": "Park here", "kind": "parking", "osm": "way/321063232", "note": "Arrive 6:50" },
    { "label": "1 · 7:00",  "kind": "stop",    "osm": "way/707965571", "note": "Equestrian Center — white paddock fences" }
  ],
  "route": ["way/321063233", "way/172568407"]
}
```

`route` is the set of trails the walk may use, not an ordered chain. The walk
itself is the shortest path across them from each stop to the next, so listing a
spare trail is harmless and listing one that does not reach the next stop fails.

## What the gate checks

`node lib/map-project.mjs build` fails, without writing output, on:

- any coordinate in the spec, by key name or by a bare decimal degree
- a place or route way that is not in the extract
- a route way that is not a path
- named trails that do not actually connect one stop to the next
- an extract with no attribution, no source mirror, or no fetch date
- a route point or stop marker projected outside the sheet

`node lib/map-project.mjs --selftest` covers the rules themselves.

## Two things that were wrong before they were checked

**Whole ways are not the walk.** The first version drew each named way end to
end and reported 4.3 km for a walk that is 891 m. One of the named ways is the
Danada-Herrick Lake Regional Trail, which runs kilometres past the point where
you join it. The route is now the shortest path over a node graph built from the
permitted ways.

**A stop on a trail is not that trail's midpoint.** Naming the regional trail as
a stop put the marker half a kilometre up it and inflated the leg to 533 m. A
linear stop now resolves to the point on it nearest where you are coming from —
where you actually join it — which is 120 m from the equestrian center. Areas
still resolve to their centroid.

Both were caught by numbers that looked wrong, not by the checker. The checker
covers them now.

## Attribution

The extract and the rendered sheet both carry
`© OpenStreetMap contributors, ODbL 1.0`. ODbL requires it on anything produced
from the data, not just on the data file, so the credit line is not optional
chrome — removing it fails the gate.
