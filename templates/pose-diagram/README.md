# Pose blocking diagrams

Where everyone stands, who is carrying whom, and where the camera is — one sheet
per setup, read on a phone between frames.

```bash
node lib/pose-layout.mjs build templates/pose-diagram/danada-family.json /tmp/variants.json
render-kit templates/pose-diagram/blocking.html --out-dir ./out --variants /tmp/variants.json
```

Two commands, and the first one is the gate: it refuses to write anything if the
spec would produce a diagram that lies.

## Why these are drawn, not generated

An image model asked for "two adults and three children, one on a hip, one on
shoulders, one a step forward" will return something plausible with four children
and nobody on anyone's shoulders. Counts and spatial relations are exactly what
those models miss, and a blocking diagram is a spec — being off by one person
makes it worse than nothing.

Generated illustration still has a place on the client-facing brief, where the
job is to set expectations rather than to specify an arrangement.

## Spec shape

```json
{
  "name": "01-family-staggered",
  "phase": "Phase 1 · full family · 7:00–7:45 · white paddock fences",
  "title": "Staggered heights",
  "cue": "\"Everyone find someone to hold onto.\"",
  "lens": "85mm", "aperture": "f/4", "shutter": "1/250", "distance": "12 ft",
  "watch": "Five faces on three planes. f/4, not wider — everyone stays sharp.",
  "figures": [
    { "role": "Dad", "height": "adult", "x": 21, "depth": 1 },
    { "role": "Baby", "height": "infant", "carriedBy": "Dad", "carry": "hip", "carryOffset": -22 }
  ]
}
```

| Field | Meaning |
|---|---|
| `height` | `adult`, `child-tall`, `child-small`, `infant` — drawn strictly in that order |
| `x` | 0–100 across the frame. An 85mm lens at 12 ft frames about five feet, so a family group nearly fills it |
| `depth` | 0 is the front plane; each step back draws smaller and higher up the receding ground |
| `carriedBy` | the `role` of an adult in the same pose |
| `carry` | `hip` or `shoulders` |
| `carryOffset` | horizontal offset from the carrier, in stage units before depth scaling |
| `note` | a second line under the name |

## What the gate checks

`node lib/pose-layout.mjs build` fails, without writing output, on:

- a height class outside the four, or a height scale that stopped being ordered
- a rider carried by someone who is not an adult, or not shorter than them
- `carriedBy` naming someone absent from the pose
- a duplicate role in one pose — roles key the layout, so one would overwrite the other
- a missing lens or distance, since a blocking diagram without the camera spec is half a spec
- geometry or labels that would render outside the stage

That last one is not theoretical. The first version of this template put a child
on an adult's shoulders and pushed her head, and her name, off the top of the
frame. Nothing errored: the PNG rendered, it just silently lost a person.

`node lib/pose-layout.mjs --selftest` covers the layout rules themselves.

## Why layout runs in Node

Chromium refuses ES module imports over `file://`, so a template loaded from disk
cannot share a module with the checker. Rather than keep two copies of the
geometry — which drift, and then the checker certifies diagrams it never saw —
the math lives in `lib/pose-layout.mjs` and the template draws numbers it is
handed. That also means the checks need no browser and run in milliseconds.
