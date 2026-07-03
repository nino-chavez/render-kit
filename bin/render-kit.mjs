#!/usr/bin/env node

import { chromium } from 'playwright'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, basename, resolve } from 'node:path'
import { readFileSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs'
import process from 'node:process'

const HERE = dirname(fileURLToPath(import.meta.url))

// Parse CLI arguments
function parseArgs(args) {
  const opts = {
    template: null,
    data: null,
    out: null,
    outDir: null,
    selector: null,
    scale: 1,
    width: null,
    height: null,
    variants: null,
  }

  let i = 0
  while (i < args.length) {
    const arg = args[i]
    if (!arg.startsWith('-')) {
      opts.template = arg
      i++
    } else if (arg === '--data') {
      opts.data = args[++i]
      i++
    } else if (arg === '--out') {
      opts.out = args[++i]
      i++
    } else if (arg === '--out-dir') {
      opts.outDir = args[++i]
      i++
    } else if (arg === '--selector') {
      opts.selector = args[++i]
      i++
    } else if (arg === '--scale') {
      opts.scale = parseInt(args[++i], 10)
      i++
    } else if (arg === '--width') {
      opts.width = parseInt(args[++i], 10)
      i++
    } else if (arg === '--height') {
      opts.height = parseInt(args[++i], 10)
      i++
    } else if (arg === '--variants') {
      opts.variants = args[++i]
      i++
    } else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    } else {
      console.error(`Unknown option: ${arg}`)
      process.exit(1)
    }
  }

  return opts
}

function printHelp() {
  console.log(`
render-kit — HTML to PNG asset renderer

Usage:
  render-kit <template.html> [options]

Options:
  --data <file.json>        Inject JSON data (exposed as RENDER_DATA global)
  --out <file.png>          Output single PNG file
  --out-dir <dir>           Output directory (use with --variants)
  --selector <selector>     CSS selector of element to crop (default: full page)
  --scale <N>               Device scale factor (default: 1)
  --width <N>               Viewport width in pixels
  --height <N>              Viewport height in pixels
  --variants <file.json>    Array of variants [{name, data}, ...] to render
  --help                    Show this message

Examples:
  render-kit template.html --width 1080 --height 1920 --out output.png

  render-kit template.html --data data.json --width 1080 --height 1920 \\
    --selector ".cap" --scale 2 --out output.png

  render-kit template.html --width 1080 --height 1920 --out-dir ./output \\
    --variants variants.json
`)
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))

  // Validate required arguments
  if (!opts.template) {
    console.error('Error: template.html is required')
    process.exit(1)
  }

  if (!existsSync(opts.template)) {
    console.error(`Error: template file not found: ${opts.template}`)
    process.exit(1)
  }

  if (!opts.out && !opts.outDir) {
    console.error('Error: either --out or --out-dir is required')
    process.exit(1)
  }

  // Load template
  let template = readFileSync(opts.template, 'utf8')
  let viewportWidth = opts.width
  let viewportHeight = opts.height

  // Try to extract viewport from template meta if not specified
  if (!viewportWidth || !viewportHeight) {
    const viewportMatch = template.match(/<!--\s*viewport:\s*(\d+)x(\d+)\s*-->/)
    if (viewportMatch) {
      if (!viewportWidth) viewportWidth = parseInt(viewportMatch[1], 10)
      if (!viewportHeight) viewportHeight = parseInt(viewportMatch[2], 10)
    }
  }

  if (!viewportWidth || !viewportHeight) {
    console.error('Error: viewport dimensions required. Specify --width and --height or add <!-- viewport: 1080x1920 --> to template')
    process.exit(1)
  }

  // Load data if provided
  let data = null
  if (opts.data) {
    if (!existsSync(opts.data)) {
      console.error(`Error: data file not found: ${opts.data}`)
      process.exit(1)
    }
    data = JSON.parse(readFileSync(opts.data, 'utf8'))
  }

  // Build job list
  const jobs = []

  if (opts.variants) {
    // Multi-variant rendering
    if (!existsSync(opts.variants)) {
      console.error(`Error: variants file not found: ${opts.variants}`)
      process.exit(1)
    }
    if (!opts.outDir) {
      console.error('Error: --out-dir is required when using --variants')
      process.exit(1)
    }

    const variants = JSON.parse(readFileSync(opts.variants, 'utf8'))
    if (!Array.isArray(variants)) {
      console.error('Error: variants file must contain a JSON array')
      process.exit(1)
    }

    for (const variant of variants) {
      const { name, data: variantData, ...rest } = variant
      if (!name) {
        console.error('Error: each variant must have a "name" field')
        process.exit(1)
      }

      const mergedData = { ...data, ...variantData, ...rest }
      jobs.push({
        name,
        outPath: join(opts.outDir, `${name}.png`),
        template,
        data: mergedData,
      })
    }

    mkdirSync(opts.outDir, { recursive: true })
  } else {
    // Single render
    jobs.push({
      name: basename(opts.out, '.png'),
      outPath: opts.out,
      template,
      data,
    })
  }

  // Render
  const browser = await chromium.launch()
  console.log(`Rendering ${jobs.length} asset(s)...\n`)

  for (const job of jobs) {
    // Prepare HTML: inject data as global RENDER_DATA
    let html = job.template
    if (job.data) {
      const dataScript = `<script>window.RENDER_DATA = ${JSON.stringify(job.data)};</script>`
      html = html.replace('</head>', `${dataScript}</head>`)
    }

    // Create temp file
    const tmpFile = join(dirname(job.outPath), `_render_tmp_${Date.now()}.html`)
    writeFileSync(tmpFile, html)

    try {
      const page = await browser.newPage({
        viewport: { width: viewportWidth, height: viewportHeight },
        deviceScaleFactor: opts.scale,
      })

      // Load page
      await page.goto(pathToFileURL(tmpFile).href, { waitUntil: 'networkidle' })

      // Wait for fonts and images
      await page.evaluate(() => document.fonts.ready)
      await page.waitForTimeout(250)

      // Screenshot
      if (opts.selector) {
        // Crop to element
        const el = await page.$(opts.selector)
        if (!el) {
          console.error(`✗ ${job.name}.png — selector not found: ${opts.selector}`)
          await page.close()
          continue
        }
        await el.screenshot({ path: job.outPath, omitBackground: true })
      } else {
        // Full page
        await page.screenshot({
          path: job.outPath,
          clip: { x: 0, y: 0, width: viewportWidth, height: viewportHeight },
        })
      }

      console.log(`✓ ${job.name}.png`)
      await page.close()
    } finally {
      rmSync(tmpFile, { force: true })
    }
  }

  await browser.close()
  console.log('\nDone')
}

main().catch((err) => {
  console.error('Error:', err.message)
  process.exit(1)
})
