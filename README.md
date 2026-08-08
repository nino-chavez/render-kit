<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="Render Kit turns one captured walkthrough manifest into interactive and motion outputs without content drift.">
</p>

# render-kit

Unified HTML→PNG asset render harness for social bugs, video cards, apparel mockups, and any screenshot-based asset pipeline.

## What it replaces

This tool consolidates the hand-rolled pattern that was rebuilt independently across:

- `flickdaymedia/scripts/story-assets/render-*.mjs` — social bugs, reel overlays, logos
- `letspepper/scripts/story-assets/render-*.mjs` — social bugs, highlight cards, standings
- `letspepper/scripts/apparel/render-apparel.mjs` — DTF print art + mockups

Every script launched a headless browser, loaded an HTML template, injected data, and saved a PNG. render-kit makes the next one a single command, not a new script.

## Two modes

- **Template → PNG** (below): the original harness — one HTML template + data → asset(s).
- **Walkthrough → many outputs** ([templates/walkthrough/CONTRACT.md](templates/walkthrough/CONTRACT.md)): one captured walkthrough manifest (a still + hotspot + caption per step) → an interactive click-through player **and** a motion video, from the same stills, so they can't drift.

```bash
# interactive click-through (self-contained folder: index.html + copied stills)
render-kit walkthrough create-tournament.interactive.json --emit interactive --out-dir out/create-tournament

# motion video over the stills (Ken-Burns push + spotlight + captions; silent)
render-kit walkthrough create-tournament.interactive.json --emit video --out out/create-tournament.mp4 --canvas 1920x1080
```

The manifest is produced by an app-specific capture harness (rally-hq's `tests/e2e/record-interactive.spec.ts` is the reference producer). Per-step motion is decided by `lib/hotspot-motion.mjs` — pure and unit-tested (`node lib/hotspot-motion.mjs --selftest`). Capture at 3× DPI when the stills feed the video emitter, so deep zooms stay crisp. Narrated promo video is deliberately a different tool (`forge-signal/templates/demo-reel`), not this lane.

## Install

```bash
cd /Users/nino/Workspace/dev/tools/render-kit
npm install
chmod +x bin/render-kit.mjs
npm link  # global symlink, optional
```

Or run directly:
```bash
node /Users/nino/Workspace/dev/tools/render-kit/bin/render-kit.mjs [options]
```

## Quick start

Render a single asset:

```bash
render-kit templates/example/social-card.html \
  --data templates/example/data.json \
  --out /tmp/render-kit-test.png
```

Render multiple variants:

```bash
render-kit templates/example/social-card.html \
  --out-dir ./output \
  --variants templates/example/variants.json
```

## CLI Usage

```
render-kit <template.html> [options]

Options:
  --data <file.json>        Inject JSON data (exposed as RENDER_DATA global)
  --out <file.png>          Output single PNG file
  --out-dir <dir>           Output directory (use with --variants)
  --selector <selector>     CSS selector of element to crop (default: full page)
  --scale <N>               Device scale factor (default: 1, e.g. 2 for 2x)
  --width <N>               Viewport width in pixels
  --height <N>              Viewport height in pixels
  --variants <file.json>    Array of variants [{name, data}, ...] to render
  --help                    Show help
```

## Viewport specification

**Option 1: CLI flags (required)**

```bash
render-kit template.html --width 1080 --height 1920 --out output.png
```

**Option 2: HTML comment in template (optional)**

Add to the `<head>` of your template:

```html
<!-- viewport: 1080x1920 -->
```

Then omit `--width` and `--height`.

## Data injection

### Expose data as a global

Your template receives JSON data as `window.RENDER_DATA`. Use it to populate dynamic content:

```html
<script>
  if (window.RENDER_DATA) {
    const { title, subtitle } = window.RENDER_DATA;
    document.getElementById('title').textContent = title;
  }
</script>
```

**CLI:**

```bash
render-kit template.html --data data.json --out output.png
```

**data.json:**

```json
{
  "title": "My Title",
  "subtitle": "Subtitle"
}
```

### Multi-variant rendering

Use `--variants` to render one PNG per array entry. Each entry can override data:

```bash
render-kit template.html --out-dir ./output --variants variants.json
```

**variants.json:**

```json
[
  {
    "name": "card-a",
    "title": "Variant A",
    "subtitle": "First output"
  },
  {
    "name": "card-b",
    "title": "Variant B",
    "subtitle": "Second output"
  }
]
```

Renders: `output/card-a.png`, `output/card-b.png`

## Element cropping

Crop to a specific element (useful for transparent alpha assets):

```bash
render-kit template.html --selector ".pill" --out output.png
```

Requires the selector to exist in your HTML. Screenshots with `omitBackground: true` for transparency.

## Device scale factor

Render at higher DPI for print-ready assets (2x = double resolution):

```bash
render-kit template.html --scale 2 --out output.png
```

## Porting an existing render script

**Steps:**

1. **Extract the HTML template** from the script's functions into a standalone `.html` file
2. **Convert data injection** from template literals to `window.RENDER_DATA`:
   - Old: `const greeting = (name) => `<div>${name}</div>`  `
   - New: Template + `document.getElementById('name').textContent = window.RENDER_DATA.name`
3. **Move the jobs array** to a `variants.json` file with `{name, ...dataFields}`
4. **Replace the script** with a single `render-kit` command

**Example: Porting social-bugs**

Old script (render-social-bugs.mjs):

```javascript
const HANDLES = [
  { slug: 'letspepper', handle: 'letspepper.open' },
  { slug: 'flickday', handle: 'flickday.media' },
]
// ... loop over HANDLES, build jobs, screenshot
```

New approach:

- **social-card.html** — template with `${handle}` placeholder replaced by `window.RENDER_DATA.handle`
- **variants.json** — `[{name: 'ig-letspepper', handle: 'letspepper.open'}, ...]`
- **Command**: `render-kit social-card.html --out-dir ./output --variants variants.json`

## Font handling

### Google Fonts (recommended for most projects)

Use `@import url()` in your CSS (same as the existing scripts):

```css
@style
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono&display=swap');
</style>
```

render-kit waits for `document.fonts.ready` before screenshotting, so fonts always load.

### Embedded fonts

If you need offline rendering, embed fonts as data URIs in your CSS (as done in flickdaymedia/_brand-v2.mjs):

```css
@font-face {
  font-family: 'MyFont';
  src: url('data:application/font-woff2;base64,...');
}
```

## Typical workflows

### Social media bugs (transparent PNGs)

```bash
render-kit templates/social-pill.html \
  --data bug-data.json \
  --selector ".pill" \
  --scale 2 \
  --out ./social-bugs/ig-handle.png
```

### Video highlight cards (full-frame, no transparency)

```bash
render-kit templates/highlight-intro.html \
  --out-dir ./highlights \
  --variants teams.json
```

### Print assets (with DPI metadata)

```bash
render-kit templates/apparel-back.html \
  --scale 1 \
  --out ./print/back-12in.png

# Then stamp DPI if needed:
# magick ./print/back-12in.png -density 300 ./print/back-12in.png
```

### A deck someone else can open

Rendered sheets plus companion notes become a `.pptx` and a `.pdf`:

```bash
node lib/deck-build.mjs build deck.json --out-dir ./deck
```

The `.pptx` opens in PowerPoint and Keynote and carries the notes in the
format's own speaker-notes field; Google Slides imports `.pptx`. The `.pdf` is
one page per sheet with its notes printed underneath — the copy you read on a
phone. Neither needs a server or this repo on the far end.

A slide is either a rendered sheet or a table of labelled rows:

```json
{
  "title": "Danada — operator playbook",
  "slug": "danada-operator-deck",
  "aspect": { "w": 2000, "h": 1440 },
  "slides": [
    { "id": "map", "image": "../assets/site-map.png", "notes": "Gate opens 6:52." },
    {
      "id": "access",
      "title": "No permit, because nobody is paying",
      "lede": "Only when money changes hands.",
      "rows": [{ "k": "Gate opens", "v": "**6:52 a.m.**" }],
      "notes": "Read this before the morning, not during it."
    }
  ]
}
```

`aspect` is the canvas the sheets were rendered at, so they land full-bleed;
a sheet of a different shape is fitted and centred, never stretched. Image
paths are relative to the spec file. `**bold**` works in `lede`, `rows`, and
`title`.

The gate refuses to build a deck with a missing sheet, a duplicate id, a slide
that is both kinds, or a sheet so far off the deck's shape that a quarter of the
slide would be blank. Notes are required — a slide that genuinely needs none
says `"notes": null`, so the omission is visible in the spec rather than silent.

Run the checks with `npm test`.

## Technical details

- **Browser**: Playwright's chromium
- **File handling**: Renders to a temp HTML file via `file://` URL
- **Fonts**: Waits for `document.fonts.ready` + 250ms buffer
- **Cleanup**: Temp files removed after each render
- **Concurrency**: Sequential renders (one page at a time)

## License

MIT
