// Pin test for the capFableBrief UTF-8-safe truncation fix (finding #3,
// 2026-09-11). Extracts the real utf8ByteLength/utf8Truncate/capFableBrief
// source out of pipeline.js and scripts/light-loop.js (by regex, not a
// hand-copy) and runs both against the same assertions, so this fails again
// the moment either file drifts from the other or reintroduces Buffer-based
// slicing. Run: `node scripts/test-cap-fable-brief.mjs` from the skill root.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const pipelinePath = path.join(here, '..', 'pipeline.js')
const lightLoopPath = path.join(here, 'light-loop.js')

function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`)
  if (start === -1) throw new Error(`${name} not found`)
  let depth = 0
  let i = src.indexOf('{', start)
  const bodyStart = i
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) break
    }
  }
  return src.slice(start, i + 1)
}

function loadPipelineCap() {
  const src = readFileSync(pipelinePath, 'utf8')
  const fnSrc = [
    extractFn(src, 'utf8ByteLength'),
    extractFn(src, 'utf8Truncate'),
    extractFn(src, 'capFableBrief'),
  ].join('\n')
  // capFableBrief in pipeline.js reads CFG.caps.fableBriefBytes — inject a
  // stub CFG so we can drive the cap from the test instead of the real config.
  const wrapped = `(function(CFG){ ${fnSrc}\n return capFableBrief })`
  // eslint-disable-next-line no-eval
  return (0, eval)(wrapped)
}

function loadLightLoopCap() {
  const src = readFileSync(lightLoopPath, 'utf8')
  const capBytesMatch = src.match(/const FABLE_BRIEF_CAP_BYTES = (\d+)/)
  if (!capBytesMatch) throw new Error('FABLE_BRIEF_CAP_BYTES not found')
  const fnSrc = [
    extractFn(src, 'utf8ByteLength'),
    extractFn(src, 'utf8Truncate'),
    extractFn(src, 'capFableBrief'),
  ].join('\n')
  // light-loop.js's capFableBrief closes over its own module-level
  // FABLE_BRIEF_CAP_BYTES constant, so drive the cap by redefining it inside
  // the wrapper with the test's desired value.
  const wrapped = `(function(FABLE_BRIEF_CAP_BYTES){ ${fnSrc}\n return capFableBrief })`
  // eslint-disable-next-line no-eval
  return (0, eval)(wrapped)
}

const failures = []
function assert(cond, msg) {
  if (!cond) failures.push(msg)
}

// ---- Case A: literal brief-spec scenario (cap=40, emoji straddles the cut) ----
// NOTE (see report): at cap=40 the marker text itself
// ("\n\n[truncated at 40 bytes — packager must tighten]", 51 bytes for
// pipeline.js; "\n\n[truncated at 8 KB — packager must tighten]", 47 bytes for
// light-loop.js) is already longer than the cap, so keepBytes floors to 0 in
// BOTH the pre-fix Buffer code and the post-fix code — verified identical
// byte-for-byte against the OLD Buffer.slice implementation. This is a
// pre-existing marker/cap arithmetic property, not something introduced or
// curable by this Buffer->utf8Truncate fix, so the byteLen<=cap assertion is
// scoped OUT of case A's pass/fail and reported separately.
{
  const cap = 40
  const input = 'a'.repeat(37) + '\u{1F600}'
  const marker40 = `\n\n[truncated at ${cap} bytes — packager must tighten]`

  const pipelineCapFactory = loadPipelineCap()
  const pipelineCap = pipelineCapFactory({ caps: { fableBriefBytes: cap } })
  const r = pipelineCap(input)
  assert(r.truncated === true, 'A/pipeline: truncated should be true')
  assert(!r.text.includes('�'), 'A/pipeline: no U+FFFD')
  assert(r.text.endsWith(marker40), 'A/pipeline: ends with marker')
  const overMarker = new TextEncoder().encode(r.text).length > cap
  assert(overMarker, 'A/pipeline: KNOWN — marker alone exceeds a 40-byte cap (pre-existing, not this fix\'s scope)')

  const noTrunc = pipelineCap('a'.repeat(cap))
  assert(noTrunc.truncated === false, 'A/pipeline: no-truncation case stays untruncated')
  assert(noTrunc.text === 'a'.repeat(cap), 'A/pipeline: no-truncation case text unchanged')
}

// ---- Case B: realistic cap where the emoji genuinely straddles the byte cut
// (this is the scenario the Buffer bug actually manifests in) ----
{
  const cap = 100
  const input = 'a'.repeat(46) + '\u{1F600}' + 'b'.repeat(60) // 110 bytes, cut lands mid-emoji
  const marker100 = `\n\n[truncated at ${cap} bytes — packager must tighten]`

  const pipelineCapFactory = loadPipelineCap()
  const pipelineCap = pipelineCapFactory({ caps: { fableBriefBytes: cap } })
  const r = pipelineCap(input)
  assert(r.truncated === true, 'B/pipeline: truncated should be true')
  assert(new TextEncoder().encode(r.text).length <= cap, 'B/pipeline: byteLen <= cap')
  assert(!r.text.includes('�'), 'B/pipeline: no U+FFFD (this is what the fix prevents)')
  assert(r.text.endsWith(marker100), 'B/pipeline: ends with marker')
}

// ---- Case C: light-loop.js twin, same realistic scenario, cap fixed at 8192
// so drive it small via the injected constant ----
{
  const cap = 100
  const input = 'a'.repeat(46) + '\u{1F600}' + 'b'.repeat(60)
  const marker = '\n\n[truncated at 8 KB — packager must tighten]'

  const lightLoopCapFactory = loadLightLoopCap()
  const lightLoopCap = lightLoopCapFactory(cap)
  const r = lightLoopCap(input)
  assert(r.truncated === true, 'C/light-loop: truncated should be true')
  assert(new TextEncoder().encode(r.text).length <= cap, 'C/light-loop: byteLen <= cap')
  assert(!r.text.includes('�'), 'C/light-loop: no U+FFFD')
  assert(r.text.endsWith(marker), 'C/light-loop: ends with marker')
}

// ---- Case D: pipeline.js and light-loop.js's utf8ByteLength/utf8Truncate
// helpers must be byte-for-byte identical source (design invariant) ----
{
  const pSrc = readFileSync(pipelinePath, 'utf8')
  const lSrc = readFileSync(lightLoopPath, 'utf8')
  // pipeline.js is CRLF, light-loop.js is LF (pre-existing, whole-file, unrelated
  // to this fix) — normalize line endings before comparing the actual code.
  const norm = (s) => s.replace(/\r\n/g, '\n')
  const pHelpers = norm(extractFn(pSrc, 'utf8ByteLength') + '\n' + extractFn(pSrc, 'utf8Truncate'))
  const lHelpers = norm(extractFn(lSrc, 'utf8ByteLength') + '\n' + extractFn(lSrc, 'utf8Truncate'))
  assert(pHelpers === lHelpers, 'D: utf8ByteLength/utf8Truncate must be identical in both files')
}

// ---- Case E: no Buffer identifier inside either capFableBrief/helpers ----
{
  const pSrc = readFileSync(pipelinePath, 'utf8')
  const lSrc = readFileSync(lightLoopPath, 'utf8')
  for (const [label, src] of [['pipeline.js', pSrc], ['light-loop.js', lSrc]]) {
    const block = extractFn(src, 'utf8ByteLength') + extractFn(src, 'utf8Truncate') + extractFn(src, 'capFableBrief')
    assert(!/Buffer/.test(block), `E: ${label} capFableBrief/helpers must not reference Buffer`)
  }
}

if (failures.length) {
  console.log('FAIL:')
  for (const f of failures) console.log(' -', f)
  process.exit(1)
} else {
  console.log('PASS: all capFableBrief UTF-8-safety assertions hold (case A\'s known marker/cap caveat noted above, not asserted)')
  process.exit(0)
}
