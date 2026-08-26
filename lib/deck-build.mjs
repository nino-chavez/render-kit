#!/usr/bin/env node
/**
 * Deck builder — turns a sheet-and-notes spec into two files you can hand to
 * someone.
 *
 *   .pptx  opens natively in PowerPoint and Keynote, and Google Slides imports
 *          it. Speaker notes are a first-class field in the format, so the
 *          companion notes travel with the deck instead of living beside it.
 *   .pdf   one page per sheet with its notes printed underneath — the field
 *          reference, readable on a phone with nothing installed.
 *
 * Neither output needs a server, a runtime, or this repo. That is the point:
 * a deck the author has to host is not a deck the recipient has.
 *
 * The sheets are images produced by render-kit's other gates (pose-layout,
 * map-project). This builder does not draw anything — it only assembles, and
 * it refuses to assemble a spec that is missing a sheet or missing its notes.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { randomUUID } from 'node:crypto'

const DEFAULT_THEME = {
  paper: 'F7F6F3',
  ink: '16161A',
  muted: '6B6A64',
  rule: 'DEDCD6',
  font: 'Arial',
}

/** PowerPoint's own wide-slide width. Height follows from the spec's aspect. */
const SLIDE_WIDTH_IN = 13.333

/**
 * A sheet whose shape differs this much from the slide gets bars down two
 * sides. `contain` never crops, so this is cosmetic — but past a quarter of
 * the slide it reads as a mistake, and it means the sheet was drawn to a
 * different canvas than the deck was declared at.
 */
const MAX_LETTERBOX = 0.25

// ---------------------------------------------------------------------------
// Reading sheets
// ---------------------------------------------------------------------------

/** Width and height straight out of the PNG IHDR chunk — no image library. */
export function pngSize(path) {
  const buf = readFileSync(path)
  // 24 bytes is exactly signature + length + "IHDR" + width + height.
  const isPng = buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47
  if (!isPng) throw new Error(`not a PNG: ${path}`)
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
}

/** Fraction of the slide left as bars when `image` is contained in `slide`. */
export function letterboxFraction(image, slide) {
  const imageRatio = image.w / image.h
  const slideRatio = slide.w / slide.h
  return imageRatio > slideRatio
    ? 1 - slideRatio / imageRatio // bars top and bottom
    : 1 - imageRatio / slideRatio // bars left and right
}

// ---------------------------------------------------------------------------
// Inline emphasis
// ---------------------------------------------------------------------------

/**
 * `**bold**` becomes runs. The access copy leans on emphasis to make times and
 * dollar figures findable at a glance, and both outputs have to carry it —
 * PowerPoint as text runs, the PDF as <strong>.
 */
export function parseRuns(text) {
  const runs = []
  for (const piece of String(text).split(/(\*\*[^*]+\*\*)/g)) {
    if (piece === '') continue
    const bold = piece.startsWith('**') && piece.endsWith('**') && piece.length > 4
    runs.push({ text: bold ? piece.slice(2, -2) : piece, bold })
  }
  return runs.length > 0 ? runs : [{ text: '', bold: false }]
}

const escapeHtml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export const runsToHtml = (text) =>
  parseRuns(text)
    .map((r) => (r.bold ? `<strong>${escapeHtml(r.text)}</strong>` : escapeHtml(r.text)))
    .join('')

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/**
 * Everything that has to be true before a deck is worth building. Returns a
 * list of problems; empty means go.
 *
 * `notes` is required rather than optional, because a deck without companion
 * notes is a different deliverable than the one this builder exists to make.
 * A slide that genuinely needs none says `"notes": null` — the omission has to
 * be deliberate and visible in the spec, not silent.
 */
export function validateDeck(spec, specDir) {
  const problems = []
  const push = (id, message) => problems.push(`slide "${id}": ${message}`)

  if (!spec || typeof spec !== 'object') return ['spec is not an object']
  if (!Array.isArray(spec.slides) || spec.slides.length === 0)
    return ['spec has no slides']
  if (!spec.title) problems.push('spec has no title')

  const slide = slideCanvas(spec)
  if (!(slide.w > 0 && slide.h > 0)) problems.push('aspect must have positive w and h')

  const seen = new Set()
  for (const [i, s] of spec.slides.entries()) {
    const id = s.id || `#${i + 1}`
    if (!s.id) push(id, 'has no id')
    else if (seen.has(s.id)) push(id, 'duplicate id')
    seen.add(s.id)

    const hasImage = typeof s.image === 'string' && s.image !== ''
    const hasRows = Array.isArray(s.rows) && s.rows.length > 0
    if (hasImage && hasRows) push(id, 'has both an image and rows — a slide is one or the other')
    if (!hasImage && !hasRows) push(id, 'has neither an image nor rows')

    if (hasImage) {
      const abs = resolve(specDir, s.image)
      if (!existsSync(abs)) {
        push(id, `image not found: ${s.image}`)
      } else {
        try {
          const box = pngSize(abs)
          const bars = letterboxFraction(box, slide)
          if (bars > MAX_LETTERBOX)
            push(
              id,
              `sheet is ${box.w}x${box.h} but the deck is ${slide.w}x${slide.h} — ` +
                `${Math.round(bars * 100)}% of the slide would be blank bars`
            )
        } catch (error) {
          push(id, error.message)
        }
      }
    }

    if (hasRows) {
      if (!s.title) push(id, 'a rows slide needs a title')
      for (const [j, row] of s.rows.entries())
        if (!row || !row.k || !row.v) push(id, `row ${j + 1} needs both k and v`)
    }

    if (!('notes' in s))
      push(id, 'has no notes — add them, or say "notes": null to declare it deliberate')
    else if (s.notes !== null && String(s.notes).trim() === '')
      push(id, 'has empty notes — use null to declare that deliberate')
  }

  return problems
}

/** The pixel canvas the deck is declared at. Defaults to 16:9. */
export function slideCanvas(spec) {
  const a = spec.aspect || {}
  return { w: Number(a.w) || 1920, h: Number(a.h) || 1080 }
}

/** Slide size in inches, pinned to PowerPoint's wide width. */
export function layoutInches(spec) {
  const { w, h } = slideCanvas(spec)
  return { width: SLIDE_WIDTH_IN, height: Number(((SLIDE_WIDTH_IN * h) / w).toFixed(3)) }
}

/**
 * Where a sheet sits on the slide when scaled to fit inside it, in inches.
 *
 * Computed here rather than handed to pptxgenjs as `sizing: {type:'contain'}`,
 * which writes an extent covering the whole slide — so a sheet drawn to a
 * different shape than the deck comes out stretched rather than fitted. The
 * site map is 2000x1520 against a 2000x1440 deck, which is a 5% horizontal
 * stretch on the one slide where distances are the content.
 */
export function containBox(image, layout) {
  const imageRatio = image.w / image.h
  const slideRatio = layout.width / layout.height
  const wide = imageRatio > slideRatio
  // The slide height is rounded to thousandths of an inch, so a sheet drawn to
  // exactly the deck's shape misses a full bleed by a ten-thousandth. Absorb
  // that rather than emitting a hairline bar nobody asked for.
  const snap = (value, edge) => (Math.abs(value - edge) < 0.002 ? edge : value)
  const w = snap(wide ? layout.width : layout.height * imageRatio, layout.width)
  const h = snap(wide ? layout.width / imageRatio : layout.height, layout.height)
  const round = (n) => Number(n.toFixed(4))
  return {
    x: round((layout.width - w) / 2),
    y: round((layout.height - h) / 2),
    w: round(w),
    h: round(h),
  }
}

// ---------------------------------------------------------------------------
// PPTX
// ---------------------------------------------------------------------------

/**
 * Put the line breaks back into speaker notes.
 *
 * pptxgenjs serialises `addNotes(text)` as one run inside one paragraph, with
 * any newlines left as literal characters inside `<a:t>`. DrawingML has no
 * whitespace-preserve on that element and expresses a line break as `<a:br/>`,
 * so PowerPoint renders those notes as a single run-on paragraph — the breaks
 * are in the file and invisible in the notes pane. Every note in a deck like
 * this is two paragraphs, so that is the whole readability of the field copy.
 *
 * Splitting the run and joining with `<a:br/>` turns a blank line into an empty
 * run between two breaks, which is exactly a blank line in the pane.
 *
 * Split on every newline form, not just "\n": pptxgenjs normalises notes to
 * CRLF on the way in, so splitting on "\n" alone leaves a carriage return
 * stranded at the end of every run.
 */
export function expandNotesLineBreaks(xml) {
  return xml.replace(
    /<a:r>(\s*<a:rPr[^>]*\/>)?\s*<a:t>([^<]*)<\/a:t>\s*<\/a:r>/g,
    (whole, rPr, text) => {
      if (!/[\r\n]/.test(text)) return whole
      const pr = rPr ? rPr.trim() : ''
      return text
        .split(/\r\n|\r|\n/)
        .map((line) => `<a:r>${pr}<a:t>${line}</a:t></a:r>`)
        .join('<a:br/>')
    }
  )
}

/** Rewrite the notes parts in place, leaving every other part byte-identical. */
async function repairNotes(buffer) {
  const { default: JSZip } = await import('jszip')
  const zip = await JSZip.loadAsync(buffer)
  const parts = Object.keys(zip.files).filter((p) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(p))
  for (const part of parts) {
    const xml = await zip.file(part).async('string')
    zip.file(part, expandNotesLineBreaks(xml))
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

async function buildPptx(spec, specDir, outPath) {
  const { default: PptxGenJS } = await import('pptxgenjs')
  const theme = { ...DEFAULT_THEME, ...(spec.theme || {}) }
  const { width: W, height: H } = layoutInches(spec)

  const pptx = new PptxGenJS()
  pptx.title = spec.title
  if (spec.subject) pptx.subject = spec.subject
  if (spec.author) pptx.author = spec.author
  pptx.defineLayout({ name: 'DECK', width: W, height: H })
  pptx.layout = 'DECK'

  for (const s of spec.slides) {
    const slide = pptx.addSlide()
    slide.background = { color: theme.paper }

    if (s.image) {
      // Full bleed. The sheets carry their own title, cues and settings chips,
      // so adding slide chrome would just duplicate what is already drawn.
      const imagePath = resolve(specDir, s.image)
      slide.addImage({
        path: imagePath,
        ...containBox(pngSize(imagePath), { width: W, height: H }),
        altText: s.alt || s.title || s.id,
      })
    } else {
      const pad = W * 0.064
      slide.addText(parseRuns(s.title).map((r) => ({ text: r.text, options: { bold: true } })), {
        x: pad,
        y: H * 0.072,
        w: W - pad * 2,
        h: H * 0.11,
        fontSize: 34,
        color: theme.ink,
        fontFace: theme.font,
        valign: 'top',
      })

      let y = H * 0.19
      if (s.lede) {
        slide.addText(parseRuns(s.lede).map((r) => ({ text: r.text, options: { bold: r.bold } })), {
          x: pad,
          y,
          w: W - pad * 2,
          h: H * 0.1,
          fontSize: 16,
          color: theme.muted,
          fontFace: theme.font,
          lineSpacingMultiple: 1.25,
          valign: 'top',
        })
        y += H * 0.11
      }

      slide.addTable(
        s.rows.map((row) => [
          {
            text: row.k,
            options: { bold: true, color: theme.ink, fontSize: 13, valign: 'top' },
          },
          {
            text: parseRuns(row.v).map((r) => ({ text: r.text, options: { bold: r.bold } })),
            options: { color: theme.ink, fontSize: 13, valign: 'top' },
          },
        ]),
        {
          x: pad,
          y,
          w: W - pad * 2,
          colW: [(W - pad * 2) * 0.22, (W - pad * 2) * 0.78],
          border: [
            { type: 'none' },
            { type: 'none' },
            { type: 'solid', color: theme.rule, pt: 1 },
            { type: 'none' },
          ],
          margin: [10, 6, 10, 0],
          fontFace: theme.font,
        }
      )

      if (s.stamp) {
        slide.addText(s.stamp, {
          x: pad,
          y: H - pad * 0.75,
          w: W - pad * 2,
          h: H * 0.06,
          fontSize: 9,
          color: theme.muted,
          fontFace: theme.font,
          valign: 'bottom',
        })
      }
    }

    if (s.notes) slide.addNotes(s.notes)
  }

  writeFileSync(outPath, await repairNotes(await pptx.write({ outputType: 'nodebuffer' })))
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

/**
 * Portrait, one slide per page, notes printed under the sheet. This is the
 * copy you actually read on a phone in a field at 6:55 in the morning, so it
 * is laid out to be read rather than projected.
 *
 * Images are referenced as absolute file:// URLs from a document that is
 * itself loaded over file://. Loading the HTML via setContent instead would
 * leave the document on about:blank, and Chromium refuses file-scheme
 * subresources into that origin — every sheet would silently come out blank.
 */
function deckHtml(spec, specDir) {
  const theme = { ...DEFAULT_THEME, ...(spec.theme || {}) }
  const pages = spec.slides
    .map((s) => {
      const body = s.image
        ? `<img class="sheet" src="file://${resolve(specDir, s.image)}" alt="${escapeHtml(
            s.alt || s.title || s.id
          )}">`
        : `<div class="rows-sheet">
             <h2>${runsToHtml(s.title)}</h2>
             ${s.lede ? `<p class="lede">${runsToHtml(s.lede)}</p>` : ''}
             <dl>${s.rows
               .map((r) => `<dt>${escapeHtml(r.k)}</dt><dd>${runsToHtml(r.v)}</dd>`)
               .join('')}</dl>
             ${s.stamp ? `<p class="stamp">${escapeHtml(s.stamp)}</p>` : ''}
           </div>`
      const notes = s.notes
        ? `<div class="notes">${s.notes
            .split(/\n{2,}/)
            .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
            .join('')}</div>`
        : ''
      return `<section class="page">${body}${notes}</section>`
    })
    .join('\n')

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(spec.title)}</title>
<style>
  @page { size: Letter portrait; margin: 14mm 14mm 16mm; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #${theme.paper}; color: #${theme.ink};
         font: 400 11.5pt/1.45 -apple-system, "Helvetica Neue", Arial, sans-serif;
         -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .page { break-after: page; }
  .page:last-child { break-after: auto; }
  .sheet { display: block; width: 100%; height: auto;
           border: 1px solid #${theme.rule}; border-radius: 6px; }
  .rows-sheet { border: 1px solid #${theme.rule}; border-radius: 6px; padding: 26px 28px; }
  .rows-sheet h2 { margin: 0; font-size: 21pt; letter-spacing: -.01em; line-height: 1.15; }
  .rows-sheet .lede { margin: 10px 0 0; color: #${theme.muted}; font-size: 12pt; }
  .rows-sheet dl { margin: 20px 0 0; }
  .rows-sheet dt { font-weight: 700; font-size: 10pt; margin-top: 14px; }
  .rows-sheet dd { margin: 3px 0 0; padding-bottom: 12px; border-bottom: 1px solid #${theme.rule}; }
  .rows-sheet .stamp { margin: 18px 0 0; font-size: 8.5pt; color: #${theme.muted}; }
  .notes { margin-top: 16px; padding-left: 14px; border-left: 3px solid #${theme.ink}; }
  .notes p { margin: 0 0 9px; }
  .notes p:last-child { margin-bottom: 0; }
</style></head>
<body>
${pages}
</body></html>`
}

async function buildPdf(spec, specDir, outPath) {
  const { chromium } = await import('playwright')
  const tempPath = join(dirname(outPath), `.deck-build-${randomUUID()}.html`)
  writeFileSync(tempPath, deckHtml(spec, specDir))

  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    const missing = []
    page.on('requestfailed', (r) => missing.push(r.url()))
    page.on('response', (r) => {
      if (r.status() >= 400) missing.push(`${r.status()} ${r.url()}`)
    })
    await page.goto(`file://${tempPath}`, { waitUntil: 'networkidle' })
    if (missing.length > 0)
      throw new Error(`sheets failed to load:\n  ${missing.join('\n  ')}`)
    await page.pdf({ path: outPath, format: 'Letter', printBackground: true })
  } finally {
    await browser.close()
    rmSync(tempPath, { force: true })
  }
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export async function buildDeck(specPath, outDir, basename) {
  const specDir = dirname(resolve(specPath))
  const spec = JSON.parse(readFileSync(specPath, 'utf8'))

  const problems = validateDeck(spec, specDir)
  if (problems.length > 0) {
    console.error(`${problems.length} problem(s) in ${specPath}:`)
    for (const problem of problems) console.error(`  ${problem}`)
    process.exit(1)
  }

  mkdirSync(outDir, { recursive: true })
  const stem = basename || spec.slug || 'deck'
  const pptxPath = join(resolve(outDir), `${stem}.pptx`)
  const pdfPath = join(resolve(outDir), `${stem}.pdf`)

  await buildPptx(spec, specDir, pptxPath)
  await buildPdf(spec, specDir, pdfPath)

  const noted = spec.slides.filter((s) => s.notes).length
  const { width, height } = layoutInches(spec)
  console.log(
    `✓ ${spec.slides.length} slide(s), ${noted} with notes, ${width}x${height}in\n` +
      `  ${pptxPath}\n  ${pdfPath}`
  )
}

// ---------------------------------------------------------------------------
// Self-checks
// ---------------------------------------------------------------------------

function selftest() {
  const checks = []
  const assert = (condition, message) => {
    if (!condition) throw new Error(message)
  }
  const check = (name, fn) => {
    try {
      fn()
      checks.push(`✓ ${name}`)
    } catch (error) {
      checks.push(`✗ ${name} — ${error.message}`)
    }
  }

  const tmp = join(process.env.TMPDIR || '/tmp', `deck-selftest-${randomUUID()}`)
  mkdirSync(tmp, { recursive: true })
  const png = (name, w, h) => {
    const buf = Buffer.alloc(24)
    buf.writeUInt32BE(0x89504e47, 0)
    buf.writeUInt32BE(w, 16)
    buf.writeUInt32BE(h, 20)
    writeFileSync(join(tmp, name), buf)
    return name
  }
  const sheet = png('sheet.png', 2000, 1440)
  const base = () => ({
    title: 'A deck',
    aspect: { w: 2000, h: 1440 },
    slides: [{ id: 'one', image: sheet, notes: 'a note' }],
  })

  check('a well-formed spec passes', () => {
    assert(validateDeck(base(), tmp).length === 0, 'expected no problems')
  })

  check('a missing sheet is reported', () => {
    const spec = base()
    spec.slides[0].image = 'nope.png'
    assert(
      validateDeck(spec, tmp).some((p) => p.includes('image not found')),
      'expected a missing-image report'
    )
  })

  check('a duplicate id is reported', () => {
    const spec = base()
    spec.slides.push({ ...spec.slides[0] })
    assert(
      validateDeck(spec, tmp).some((p) => p.includes('duplicate id')),
      'expected a duplicate-id report'
    )
  })

  check('a slide that is both image and rows is reported', () => {
    const spec = base()
    spec.slides[0].rows = [{ k: 'a', v: 'b' }]
    assert(
      validateDeck(spec, tmp).some((p) => p.includes('one or the other')),
      'expected a both-kinds report'
    )
  })

  check('omitted notes fail but an explicit null passes', () => {
    const bare = base()
    delete bare.slides[0].notes
    assert(
      validateDeck(bare, tmp).some((p) => p.includes('no notes')),
      'expected a missing-notes report'
    )
    const declared = base()
    declared.slides[0].notes = null
    assert(validateDeck(declared, tmp).length === 0, 'explicit null should pass the gate')
    const empty = base()
    empty.slides[0].notes = '   '
    assert(
      validateDeck(empty, tmp).some((p) => p.includes('empty notes')),
      'expected an empty-notes report'
    )
  })

  check('a sheet drawn to the wrong canvas is reported', () => {
    const spec = base()
    spec.slides.push({ id: 'tall', image: png('tall.png', 1000, 2000), notes: 'n' })
    assert(
      validateDeck(spec, tmp).some((p) => p.includes('blank bars')),
      'expected a letterbox report'
    )
  })

  check('a rows slide needs a title and complete rows', () => {
    const spec = base()
    spec.slides = [{ id: 'r', rows: [{ k: 'only-a-key' }], notes: 'n' }]
    const problems = validateDeck(spec, tmp)
    assert(problems.some((p) => p.includes('needs a title')), 'expected a missing-title report')
    assert(problems.some((p) => p.includes('both k and v')), 'expected an incomplete-row report')
  })

  check('letterbox is measured on the short axis either way', () => {
    assert(letterboxFraction({ w: 2000, h: 1440 }, { w: 2000, h: 1440 }) === 0, 'exact fit is 0')
    const wide = letterboxFraction({ w: 1920, h: 1080 }, { w: 2000, h: 1440 })
    assert(wide > 0.2 && wide < 0.3, `16:9 in 25:18 should bar ~24%, got ${wide}`)
    const tall = letterboxFraction({ w: 2000, h: 1520 }, { w: 2000, h: 1440 })
    assert(tall > 0 && tall < 0.06, `the map should bar under 6%, got ${tall}`)
  })

  check('bold markers become runs and survive to HTML', () => {
    const runs = parseRuns('open at **6:52** sharp')
    assert(runs.length === 3, `expected 3 runs, got ${runs.length}`)
    assert(runs[1].bold && runs[1].text === '6:52', 'the middle run should be bold 6:52')
    assert(
      runsToHtml('a **b** c') === 'a <strong>b</strong> c',
      'expected a strong element in the HTML'
    )
    assert(runsToHtml('5 < 6 & 7') === '5 &lt; 6 &amp; 7', 'expected HTML escaping')
  })

  check('a sheet is fitted to the slide, never stretched to it', () => {
    const layout = { width: 13.333, height: 9.6 } // 25:18
    const exact = containBox({ w: 2000, h: 1440 }, layout)
    assert(exact.x === 0 && exact.y === 0, 'a matching sheet should sit at the origin')
    assert(exact.w === layout.width && exact.h === layout.height, 'a matching sheet should bleed')

    // The site map: taller than the deck, so it pillarboxes and keeps its shape.
    const map = containBox({ w: 2000, h: 1520 }, layout)
    assert(map.y === 0 && map.h === layout.height, 'a taller sheet should fill the height')
    assert(map.x > 0 && map.w < layout.width, 'a taller sheet should leave bars at the sides')
    assert(
      Math.abs(map.w / map.h - 2000 / 1520) < 0.001,
      `the sheet's own aspect must survive, got ${map.w / map.h}`
    )
    assert(
      Math.abs(map.x - (layout.width - map.w) / 2) < 0.001,
      'the sheet should be centred, not pinned left'
    )

    const wide = containBox({ w: 1920, h: 1080 }, layout)
    assert(wide.x === 0 && wide.w === layout.width, 'a wider sheet should fill the width')
    assert(wide.y > 0 && wide.h < layout.height, 'a wider sheet should leave bars top and bottom')
  })

  check('slide inches follow the declared aspect', () => {
    assert(layoutInches({ aspect: { w: 2000, h: 1440 } }).height === 9.6, 'expected 9.6in tall')
    assert(layoutInches({}).height === 7.5, 'expected a 16:9 default of 7.5in')
  })

  check('paragraph breaks in notes become real breaks in the PPTX', () => {
    const run = (t) => `<a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t>${t}</a:t></a:r></a:p>`
    const out = expandNotesLineBreaks(run('first para\n\nsecond para'))
    assert(out.split('<a:br/>').length === 3, `expected two breaks, got: ${out}`)
    assert(out.includes('<a:t>first para</a:t>'), 'expected the first paragraph in its own run')
    assert(out.includes('<a:t>second para</a:t>'), 'expected the second paragraph in its own run')
    assert(out.includes('<a:t></a:t>'), 'expected an empty run for the blank line')
    assert(
      out.includes('<a:rPr lang="en-US" dirty="0"/><a:t>second para'),
      'each run should keep the original run properties'
    )
    const single = run('no breaks here')
    assert(expandNotesLineBreaks(single) === single, 'a note with no newline should be untouched')

    // pptxgenjs normalises notes to CRLF, so this is the shape that actually
    // reaches the transform — splitting on "\n" alone stranded a "\r" in every
    // run, which the XML shows and a text-mode read of the same file hides.
    const crlf = expandNotesLineBreaks(run('first para\r\n\r\nsecond para'))
    assert(!/[\r\n]/.test(crlf), `no run should still hold a newline: ${crlf}`)
    assert(crlf.split('<a:br/>').length === 3, 'CRLF should give the same two breaks')
    assert(crlf.includes('<a:t>first para</a:t>'), 'no stray carriage return on the first run')
    assert(expandNotesLineBreaks(run('a\rb')).includes('<a:br/>'), 'a bare CR should break too')
  })

  check('paragraph breaks in notes survive into the PDF markup', () => {
    const spec = base()
    spec.slides[0].notes = 'first para\n\nsecond para'
    const html = deckHtml(spec, tmp)
    assert(html.includes('<p>first para</p>'), 'expected the first paragraph')
    assert(html.includes('<p>second para</p>'), 'expected a separate second paragraph')
  })

  rmSync(tmp, { recursive: true, force: true })

  for (const line of checks) console.log(`  ${line}`)
  const failed = checks.filter((c) => c.startsWith('✗')).length
  console.log(
    failed === 0 ? `\nAll ${checks.length} checks passed` : `\n${failed} of ${checks.length} checks failed`
  )
  return failed === 0
}

if (process.argv[1] && process.argv[1].endsWith('deck-build.mjs')) {
  const args = process.argv.slice(2)

  if (args.includes('--selftest')) {
    process.exit(selftest() ? 0 : 1)
  }

  if (args[0] === 'build') {
    const specPath = args[1]
    const outDir = args[args.indexOf('--out-dir') + 1]
    const nameFlag = args.indexOf('--basename')
    if (!specPath || !args.includes('--out-dir') || !outDir) {
      console.error(
        'Usage: node lib/deck-build.mjs build <deck.json> --out-dir <dir> [--basename <name>]'
      )
      process.exit(1)
    }
    await buildDeck(specPath, outDir, nameFlag === -1 ? undefined : args[nameFlag + 1])
    process.exit(0)
  }

  console.error(
    'Usage: node lib/deck-build.mjs [--selftest | build <deck.json> --out-dir <dir> [--basename <name>]]'
  )
  process.exit(1)
}
