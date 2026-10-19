#!/usr/bin/env node
// classify-census.cjs — run classifyEntry over every user entry in a transcript
// and report harness / human / unknown counts with tag and evidence-tier breakdown.
//
// Usage:  node scripts/classify-census.cjs <path-to-session.jsonl>
//
// Example:
//   node scripts/classify-census.cjs ~/.claude/projects/-home-kat/<session>.jsonl
//
// Output: counts by class and evidence tier, then unknown + textual-harness details.
// Entry content is never printed — body may contain credentials from `!` commands.
//
// WHAT THIS CENSUS PROVES AND DOES NOT PROVE
// -------------------------------------------
// PROVES:    these tag names appear in real harness output (coverage).
// DOES NOT:  prove they cannot appear in human terminal input (exclusivity).
//
// A human can type `<bash-stdout>private data</bash-stdout>` and the forwarder would
// see the same bytes. textual-harness entries are therefore in unknownEntries from
// discordReplyState — the forwarder refuses on them. (Ohm's correction, 2026-10-19)
//
// The census is still useful: unknown = 0 on a clean real-world run confirms the
// classifier has seen every tag the harness produces. It does NOT confirm delivery
// is safe across those entries — that is a separate argument, handled in the code.

const { readFileSync } = require('fs')
const { classifyEntry } = require('../hooks/discord-reply-state')

const path = process.argv[2]
if (!path) {
  console.error('usage: classify-census.js <session.jsonl>')
  process.exit(1)
}

const entries = readFileSync(path, 'utf8').split('\n')
  .filter(Boolean)
  .map(l => { try { return JSON.parse(l) } catch { return null } })
  .filter(Boolean)

const counts = { harness_structural: 0, harness_textual: 0, human: 0, unknown: 0 }
const unknownTags = {}
const textualTags = {}
const originKinds = {}

for (const e of entries) {
  if (e.type !== 'user') continue
  const { class: cls, evidence } = classifyEntry(e)
  if (cls === 'harness') {
    if (evidence === 'textual') counts.harness_textual++
    else counts.harness_structural++
  } else {
    counts[cls]++
  }
  const content = e.message?.content
  const text = typeof content === 'string' ? content
    : (Array.isArray(content) ? content.filter(c => c.type === 'text').map(c => c.text).join('') : '')
  const tag = text.trim().match(/^<([a-z][a-z0-9-]*)/i)?.[1] ?? null
  if (cls === 'unknown' && tag) {
    unknownTags[tag] = (unknownTags[tag] ?? 0) + 1
  }
  if (cls === 'harness' && evidence === 'textual' && tag) {
    textualTags[tag] = (textualTags[tag] ?? 0) + 1
  }
  // origin.kind distribution — the primary provenance evidence.
  const ok = e.origin?.kind ?? '(no origin)'
  originKinds[ok] = (originKinds[ok] ?? 0) + 1
}

const total = counts.harness_structural + counts.harness_textual + counts.human + counts.unknown
console.log(`user entries: ${total}`)
console.log(`  harness (structural): ${counts.harness_structural}`)
console.log(`  harness (textual):    ${counts.harness_textual}  ← forwarder refuses on these`)
console.log(`  human:                ${counts.human}`)
console.log(`  unknown:              ${counts.unknown}`)

console.log('\norigin.kind distribution (primary provenance — set by Claude Code runtime):')
for (const [ok, n] of Object.entries(originKinds).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${ok}: ${n}`)
}

if (counts.harness_textual > 0) {
  console.log('\ntextual-harness tag breakdown (tag name only — forwarder gates on these):')
  for (const [tag, n] of Object.entries(textualTags).sort((a, b) => b[1] - a[1])) {
    console.log(`  <${tag}>: ${n}`)
  }
}

if (counts.unknown > 0) {
  console.log('\nunknown tag breakdown (tag name only — not content):')
  for (const [tag, n] of Object.entries(unknownTags).sort((a, b) => b[1] - a[1])) {
    console.log(`  <${tag}>: ${n}`)
  }
}
