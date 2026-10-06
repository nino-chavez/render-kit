/**
 * --tokens: recolor a walkthrough output without editing its template.
 *
 * Accepts a JSON object of bare custom-property names ({"wt-accent": "#4d465f"}) or a raw CSS
 * declaration list ("--wt-accent: #4d465f;"). The caller inserts the result in a :root block
 * that comes AFTER the template's own defaults, so the later declaration wins the cascade.
 * One file can drive every emitter: each reads the `--wt-*` names it uses and ignores the rest.
 */
import { readFileSync } from 'node:fs'

export const TOKEN_PLACEHOLDER = '/*WALKTHROUGH-TOKENS*/'

export function readTokens(tokensPath) {
  const trimmed = readFileSync(tokensPath, 'utf8').trim()
  if (trimmed.startsWith('{')) {
    const obj = JSON.parse(trimmed)
    return Object.entries(obj)
      .map(([k, v]) => `--${k.replace(/^--/, '')}: ${v};`)
      .join(' ')
  }
  return trimmed
}

/**
 * Fill the template's single TOKEN_PLACEHOLDER with `css`. Throws unless the placeholder appears
 * exactly once: a second copy (in a comment, say) would take the tokens and leave the real
 * :root block empty, which renders without error and silently ignores --tokens.
 */
export function applyTokens(template, css, templatePath = 'the template') {
  const count = template.split(TOKEN_PLACEHOLDER).length - 1
  if (count !== 1) {
    throw new Error(
      `--tokens needs exactly one ${TOKEN_PLACEHOLDER} placeholder in ${templatePath}, found ${count} — ` +
      (count === 0 ? 'tokens would silently do nothing' : 'only the first would be filled')
    )
  }
  return template.replace(TOKEN_PLACEHOLDER, css)
}

// node lib/tokens.mjs --selftest
if (process.argv[1] && process.argv[1].endsWith('tokens.mjs') && process.argv.includes('--selftest')) {
  const { readFileSync: read } = await import('node:fs')
  const { dirname, join } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const here = dirname(fileURLToPath(import.meta.url))
  const cases = []
  const check = (name, cond) => cases.push([name, cond])
  const throws = (fn, re) => { try { fn(); return false } catch (e) { return re.test(e.message) } }

  check('fills a single placeholder', applyTokens(':root { /*WALKTHROUGH-TOKENS*/ }', '--wt-accent: red;') === ':root { --wt-accent: red; }')
  check('no placeholder → throws', throws(() => applyTokens(':root {}', 'x'), /found 0/))
  check('two placeholders → throws', throws(() => applyTokens('/*WALKTHROUGH-TOKENS*/ :root { /*WALKTHROUGH-TOKENS*/ }', 'x'), /found 2/))

  // Every stock template that accepts --tokens must carry the placeholder exactly once.
  const portrait = read(join(here, '..', 'templates', 'walkthrough', 'motion-portrait.html'), 'utf8')
  let filled = ''
  try { filled = applyTokens(portrait, '--wt-accent: #ff00ff;', 'motion-portrait.html') } catch (e) { console.error(e.message) }
  check('portrait: tokens land in a :root block', /:root \{ --wt-accent: #ff00ff; \}/.test(filled))

  const failed = cases.filter(([, ok]) => !ok)
  for (const [name, ok] of cases) console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (failed.length) {
    console.error(`\n${failed.length} check(s) failed`)
    process.exit(1)
  }
  console.log(`\nAll ${cases.length} checks passed`)
}
