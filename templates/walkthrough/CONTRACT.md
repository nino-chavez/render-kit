# Walkthrough manifest — the shared contract

One capture produces one manifest. Every emitter (`interactive`, `video`, and thumbnails as
they land) turns that same manifest into a different artifact — so the outputs of a walkthrough
**cannot drift**. Add a step `kind` once, here, and every emitter learns it.

Capture stays app-specific; everything downstream of the manifest is generic. Any app that can
drive itself and emit this shape plugs into every render-kit walkthrough emitter. The reference
producer is rally-hq's `tests/e2e/record-interactive.spec.ts` (a Playwright harness that walks
the real app in snapshot mode).

## Shape

```json
{
  "schemaVersion": 1,
  "label": "create-tournament",
  "title": "Create a tournament",
  "width": 1280,
  "height": 720,
  "steps": [
    { "frame": "step-01.png", "kind": "annotate", "caption": "Start on your dashboard.", "hotspot": { "x": 600, "y": 300, "w": 0, "h": 0 } },
    { "frame": "step-02.png", "kind": "click",    "caption": "Hit New tournament.",        "hotspot": { "x": 1170, "y": 110, "w": 156, "h": 44 } }
  ]
}
```

| Field | Meaning |
|---|---|
| `schemaVersion` | Optional. Omitted → treated as `1` (the shape rally-hq shipped before the contract was named). |
| `label` | **Required.** The capture folder name; the stills live in a sibling dir named exactly this. |
| `title` | Optional. Display title; falls back to `tour`, then `label`, title-cased. |
| `width` / `height` | **Required.** The *logical* capture size — the coordinate space `hotspot` is measured in. |
| `steps[].frame` | **Required.** Still filename inside `<label>/`. |
| `steps[].kind` | `click` \| `type` \| `scroll` \| `select` \| `annotate`. Omitted → `annotate`. |
| `steps[].caption` | Caption text; `""`/absent → no caption. |
| `steps[].hotspot` | `{x,y,w,h}` rect (element target), point (`w:0,h:0`), or `null` (full-frame). |

## Coordinate space — the one thing to get right

`hotspot` is in **logical capture pixels** (`width`×`height`), **not** the still's raw pixel
dimensions. A still captured at `deviceScaleFactor: 3` is 3× those pixels but still maps to the
logical box. Every emitter scales from `width`/`height`, so:

- overlays never shift when you change capture DPI, and
- a high-DPI still simply means a **crisper zoom** in the video emitter.

Capture at 3× (`REEL_DPI=3` in the rally-hq harness) when the stills feed the video emitter — a
1× still visibly softens once the camera pushes in; a 3× still stays sharp through the 2× max zoom.

## Emitters

```bash
# interactive click-through player (self-contained folder: index.html + copied stills)
render-kit walkthrough create-tournament.interactive.json --emit interactive --out-dir out/create-tournament

# motion video over the stills (Ken-Burns + spotlight + captions; silent)
render-kit walkthrough create-tournament.interactive.json --emit video --out out/create-tournament.mp4 --canvas 1920x1080
```

Motion per `kind` is decided by `lib/hotspot-motion.mjs` (`hotspotToMotion`) — a pure, unit-tested
function (`node lib/hotspot-motion.mjs --selftest`): `click`/`select` push toward the target and
ripple, `type` frames the field, `scroll`/`annotate` hold near full-frame with a gentle drift.

Narration is deliberately **not** here — a narrated marketing/promo video is a different job
(authored creative, TTS, music). This lane is silent motion over a real walkthrough.
