#!/usr/bin/env node
// classify-census.js — run classifyEntry over every user entry in a transcript
// and report harness / human / unknown counts with tag breakdown.
//
// Usage:  node scripts/classify-census.js <path-to-session.jsonl>
//
// Example:
//   node scripts/classify-census.js ~/.claude/projects/-home-kat/<session>.jsonl
//
// Output: tab-separated counts, one class per line, then an 'unknown' detail block.
// Unknown entries show only their opening tag (never the body — body may contain
// credentials or private content from `!` bash commands or terminal tasks).
//
// Add to CI or run after changing classifyEntry to verify the classifier matches
// the actual distribution in a real transcript. Target: unknown = 0 on a clean run.

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

const counts = { harness: 0, human: 0, unknown: 0 }
const unknownTags = {}

for (const e of entries) {
  if (e.type !== 'user') continue
  const cls = classifyEntry(e)
  counts[cls]++
  if (cls === 'unknown') {
    const content = e.message?.content
    const text = typeof content === 'string' ? content
      : (Array.isArray(content) ? content.filter(c => c.type === 'text').map(c => c.text).join('') : '')
    const tag = text.trim().match(/^<([a-z][a-z0-9-]*)/i)?.[1] ?? '(no-tag)'
    unknownTags[tag] = (unknownTags[tag] ?? 0) + 1
  }
}

const total = counts.harness + counts.human + counts.unknown
console.log(`user entries: ${total}`)
console.log(`  harness:  ${counts.harness}`)
console.log(`  human:    ${counts.human}`)
console.log(`  unknown:  ${counts.unknown}`)

if (counts.unknown > 0) {
  console.log('\nunknown tag breakdown (tag name only — not content):')
  for (const [tag, n] of Object.entries(unknownTags).sort((a, b) => b[1] - a[1])) {
    console.log(`  <${tag}>: ${n}`)
  }
}
