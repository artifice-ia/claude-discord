import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_MAX_ENVELOPE_BYTES,
  normalizeAllowlist,
  normalizeBotName,
  validateEnvelope,
} from './fleet-bus'

const allowlist = normalizeAllowlist(['luna', 'deet', 'kat', 'vec', 'ohm', 'myc', 'helm'])

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    envelope_version: 1,
    id: 'bd132d42-3a78-4af4-86ad-fbcfe3dd811f',
    from: 'ohm',
    to: 'vec',
    kind: 'pr_review_request',
    ts: '2026-08-24T00:00:00.000Z',
    payload: { pr: 42 },
    ...overrides,
  }
}

describe('bot identity normalization', () => {
  test('canonicalizes case and NFKC-compatible glyphs', () => {
    expect(normalizeBotName('ＫＡＴ')).toBe('kat')
    expect(normalizeBotName('OhM')).toBe('ohm')
  })

  test('rejects homoglyphs, invisible characters, whitespace, and punctuation', () => {
    expect(normalizeBotName('kаt')).toBeNull() // Cyrillic small a
    expect(normalizeBotName('k\u200Bat')).toBeNull()
    expect(normalizeBotName(' kat')).toBeNull()
    expect(normalizeBotName('kat.bot')).toBeNull()
  })

  test('normalizes, deduplicates, and rejects invalid manifest entries', () => {
    expect([...normalizeAllowlist(['VEC', 'vec', 'myc'])]).toEqual(['vec', 'myc'])
    expect(() => normalizeAllowlist(['valid', 'not valid'])).toThrow(TypeError)
  })
})

describe('envelope validation', () => {
  test('accepts a v1 envelope and exposes only the normalized from claim', () => {
    const result = validateEnvelope(envelope({ from: 'ＯＨＭ' }), allowlist)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.envelope.from).toBe('ohm')
  })

  test.each([
    ['non-object', null, 'envelope_not_object'],
    ['wrong version', envelope({ envelope_version: 2 }), 'unsupported_envelope_version'],
    ['missing id', envelope({ id: '' }), 'invalid_id'],
    ['missing kind', envelope({ kind: '' }), 'invalid_kind'],
    ['bad timestamp', envelope({ ts: 'yesterday-ish' }), 'invalid_ts'],
    ['missing payload', (() => { const value = envelope(); delete value.payload; return value })(), 'missing_payload'],
    ['unknown sender', envelope({ from: 'fernando' }), 'from_claim_rejected'],
    ['homoglyph sender', envelope({ from: 'оhm' }), 'from_claim_rejected'],
  ])('rejects %s', (_label, value, error) => {
    expect(validateEnvelope(value, allowlist)).toEqual({ ok: false, error })
  })

  test('rejects envelopes above the encoded byte limit', () => {
    const value = envelope({ payload: 'x'.repeat(DEFAULT_MAX_ENVELOPE_BYTES) })
    expect(validateEnvelope(value, allowlist)).toEqual({ ok: false, error: 'envelope_too_large' })
  })
})
