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

## Optional step fields

Unknown fields are ignored by every emitter, so these are additive under `schemaVersion` 1 — an
existing manifest and an existing emitter both keep working untouched.

| Field | Meaning |
|---|---|
| `steps[].at` | Seconds from the start of the producer's own screen recording. Used to cut video clips (`render-kit clips`) — not read by `interactive` or `video`. |
| `steps[].beat` | A named group of steps (for example `beat2-details`), free-form string. Lets a producer or a downstream tool cluster steps into scenes. |
| `steps[].captions` | `{ "tutorial": "...", "hype": "...", "sizzle": "..." }` — per-mode copy. `caption` stays the tutorial copy read by `interactive` and `video`; `captions.hype`/`captions.sizzle` are read by the hype/sizzle lane (see below). |

## Producers

Two reference producers, one per platform. Anything that can drive the target app and emit the
manifest shape plugs into every emitter below.

- **Web** — rally-hq's `tests/e2e/record-interactive.spec.ts` (Playwright). Drives the app in
  snapshot mode and reads hotspots from `getBoundingClientRect()`.
- **Native iOS** — Minder's `ios/Minder/MinderUITests/MarketingTourUITests.swift` (XCUITest) plus
  `scripts/record-tour.sh` (simulator recording + manifest post-processing). Hotspots are
  `XCUIElement.frame`, in points; the logical `width`/`height` is the app window in points (for
  example 440×956), and the stills are the 3× screenshots (`XCUIScreen.main.screenshot()`).

**`hotspot.x`/`.y` is the target's center, not its top-left corner.** Both reference emitters
(`hotspot-motion.mjs`, the interactive player) treat `x,y` as the rect's center point — the
CONTRACT example above (`x:1170` on a 156-wide rect starting near `x:1090`) only holds under that
reading, and rally-hq's producer writes `rect.left + rect.width / 2`. A native producer reading a
raw element frame must convert: `x: frame.minX + frame.width / 2`, `y: frame.minY + frame.height / 2`
(`XCUIElement.frame` gives the top-left corner and size, not a center).

## Three output modes from one capture

| Mode | Renderer | Input | Typical length | Destination |
|---|---|---|---|---|
| Tutorial | `render-kit walkthrough --emit video` (+ `--template portrait` for phone apps) and `--emit interactive` | the manifest + stills | one clip per step, full walkthrough | help center, onboarding, support docs |
| Hype | HyperFrames composition | `render-kit clips` output + `captions.hype` | 15–30 s | social; a 15–30 s app-footage-only cut of it is the App Store preview |
| Sizzle | HyperFrames composition | `render-kit clips` output from several recorded flows + `captions.sizzle` | 45–90 s | website hero, investor/stakeholder reel |

Hype and sizzle are a different lane from tutorial: they are authored HyperFrames compositions
built from short cut clips (`render-kit clips`, below), not a straight per-step render. An App
Store preview may only contain screen captures of the app plus text overlays (App Review
Guideline 2.3.4), 15–30 s, at 886×1920 for the 6.9" device class.

## Capture gotchas

Measured on the Minder iOS producer, 2026-09-23. Each cost real debugging time; the fix is one
line.

1. **Variable frame rate.** `xcrun simctl io recordVideo` writes a frame only when the screen
   changes, so cutting straight from the recording ends early wherever the screen sat still.
   Normalize to a constant frame rate first — `render-kit clips` does this automatically.
2. **Simulator cloning.** `xcodebuild test` clones the simulator for parallel testing unless you
   pass `-parallel-testing-enabled NO`; otherwise the screen recorder films the idle original
   device, not the one running the test.
3. **Status-bar override time zone.** `simctl status_bar override --time` needs an ISO UTC string
   with milliseconds (for example `2026-09-23T14:41:00.000Z`) and displays it in the Mac's local
   time zone. It can also keep showing an older override — run `simctl status_bar clear` first.
4. **Action latency.** XCUITest leaves dead time between a tap and its result (roughly 2 s before
   a sheet opened, in the measured case). Cut a multi-segment clip (a jump cut over the dead
   time) rather than one longer scene.
5. **Recording-only tests need their own gate.** Pass test-runner environment variables as
   `TEST_RUNNER_<NAME>`, and skip the recording test unless that variable is set, so an ordinary
   suite run never pays for it.

## Emitters

```bash
# interactive click-through player (self-contained folder: index.html + copied stills)
render-kit walkthrough create-tournament.interactive.json --emit interactive --out-dir out/create-tournament

# motion video over the stills (Ken-Burns + spotlight + captions; silent)
render-kit walkthrough create-tournament.interactive.json --emit video --out out/create-tournament.mp4 --canvas 1920x1080
```

The interactive player sizes its stage from the manifest's `width`/`height` to fit the viewport's
width and height (capped at 1100px wide), so portrait phone captures keep the caption and Back/Next
in view. Under `prefers-reduced-motion` its hotspot pulses and transitions are off.

Motion per `kind` is decided by `lib/hotspot-motion.mjs` (`hotspotToMotion`) — a pure, unit-tested
function (`node lib/hotspot-motion.mjs --selftest`): `click`/`select` push toward the target and
ripple, `type` frames the field, `scroll`/`annotate` hold near full-frame with a gentle drift.

An app can replace the video look (caption layout, type, brand colors) with
`--template <html>`. The template must keep the default's interface: read `window.RENDER_DATA`,
expose `window.__seek(p)` for p in [0,1], and resolve `window.__ready`. The default stays
`templates/walkthrough/motion.html`. `--template portrait` selects the stock phone-tutorial look
(`templates/walkthrough/motion-portrait.html`) by name; any other value is still a path. Pair it
with `--tokens <file.json|file.css>` to recolor it — a JSON object of CSS custom-property values
(for example `{"wt-accent": "#4d465f"}`) or a raw CSS declaration list — without editing the
template. See `README.md` for a worked example.

Narration is deliberately **not** here — a narrated marketing/promo video is a different job
(authored creative, TTS, music). This lane is silent motion over a real walkthrough.

## `render-kit clips` — cutting scenes for the hype/sizzle lane

```bash
render-kit clips <manifest.json> --master <recording.mp4> --spec <scenes.json> --out-dir <dir> [--fps 30]
```

`scenes.json` names each output clip and anchors it to a manifest step's `at`:

```json
{
  "scenes": {
    "f4": {
      "step": 3, "offset": -0.4, "length": 1.0, "speed": 1,
      "then": [{ "step": 4, "offset": 0.46, "length": 2.35 }]
    }
  }
}
```

`step` is 1-based into `manifest.steps` and requires that step to carry `at`. `offset` and
`length` are source seconds relative to that step's `at`. `speed` defaults to 1 (values `> 1`
speed the clip up). `then` is an optional array of extra segments concatenated onto the first as
a jump cut — each entry may name its own `step` (defaulting to the scene's own `step`), `offset`,
and `length`, so a scene can cut from one moment straight to a later payoff without the dead time
between them (see gotcha 4 above).

The master is normalized to constant frame rate once (see gotcha 1) and reused across scenes.
Each named scene becomes `<out-dir>/<name>.mp4` (H.264, `yuv420p`, no audio, faststart), and
`<out-dir>/clips.json` records what was actually cut per scene: duration, each segment's source
start/length, the anchor step, where that step lands inside the clip, and its hotspot — so a
downstream HyperFrames composition can place captions and camera moves against real cut points
instead of re-deriving them.
