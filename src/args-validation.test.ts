import { describe, expect, test } from 'bun:test'
import {
  readString,
  readOptionalString,
  readOptionalNumber,
  readOptionalBoolean,
  readOptionalStringArray,
  readRequiredUnknown,
} from './args-validation'

// Every helper is checked for THREE things: happy path returns the value,
// wrong type throws with an operator-parseable message, missing/undefined
// behaves correctly (required throws, optional returns undefined). Each guard
// inside a helper is mutation-verifiable — deleting it should fail at least
// one of these tests.

describe('readString', () => {
  test('returns the string when present with correct type', () => {
    expect(readString({ chat_id: 'abc' }, 'chat_id')).toBe('abc')
  })
  test('accepts an empty string as a valid string', () => {
    expect(readString({ text: '' }, 'text')).toBe('')
  })
  test('throws when the value is a number', () => {
    expect(() => readString({ chat_id: 42 }, 'chat_id')).toThrow('chat_id must be a string')
  })
  test('throws when the value is null', () => {
    expect(() => readString({ chat_id: null }, 'chat_id')).toThrow('chat_id must be a string')
  })
  test('throws when the key is absent', () => {
    expect(() => readString({}, 'chat_id')).toThrow('chat_id must be a string')
  })
})

describe('readOptionalString', () => {
  test('returns the string when present with correct type', () => {
    expect(readOptionalString({ reply_to: 'msg-1' }, 'reply_to')).toBe('msg-1')
  })
  test('returns undefined when the key is absent', () => {
    expect(readOptionalString({}, 'reply_to')).toBeUndefined()
  })
  test('returns undefined when the value is explicitly undefined', () => {
    expect(readOptionalString({ reply_to: undefined }, 'reply_to')).toBeUndefined()
  })
  test('throws on wrong type', () => {
    expect(() => readOptionalString({ reply_to: 42 }, 'reply_to')).toThrow('reply_to must be a string when provided')
  })
  test('throws on null (null is a wrong type here, not "absent")', () => {
    expect(() => readOptionalString({ reply_to: null }, 'reply_to')).toThrow('reply_to must be a string when provided')
  })
})

describe('readOptionalNumber', () => {
  test('returns the number when present with correct type', () => {
    expect(readOptionalNumber({ limit: 50 }, 'limit')).toBe(50)
  })
  test('accepts 0 as a valid number', () => {
    expect(readOptionalNumber({ limit: 0 }, 'limit')).toBe(0)
  })
  test('returns undefined when the key is absent', () => {
    expect(readOptionalNumber({}, 'limit')).toBeUndefined()
  })
  test('throws when passed a numeric string', () => {
    expect(() => readOptionalNumber({ limit: '50' }, 'limit')).toThrow('limit must be a number when provided')
  })
  test('throws on boolean', () => {
    expect(() => readOptionalNumber({ limit: true }, 'limit')).toThrow('limit must be a number when provided')
  })
})

describe('readOptionalBoolean', () => {
  test('returns true when present as true', () => {
    expect(readOptionalBoolean({ wait: true }, 'wait')).toBe(true)
  })
  test('returns false when present as false', () => {
    expect(readOptionalBoolean({ wait: false }, 'wait')).toBe(false)
  })
  test('returns undefined when the key is absent', () => {
    expect(readOptionalBoolean({}, 'wait')).toBeUndefined()
  })
  test('throws on a truthy string', () => {
    expect(() => readOptionalBoolean({ wait: 'true' }, 'wait')).toThrow('wait must be a boolean when provided')
  })
  test('throws on the number 1', () => {
    expect(() => readOptionalBoolean({ wait: 1 }, 'wait')).toThrow('wait must be a boolean when provided')
  })
})

describe('readOptionalStringArray', () => {
  test('returns the array when present with all-string elements', () => {
    expect(readOptionalStringArray({ files: ['a', 'b'] }, 'files')).toEqual(['a', 'b'])
  })
  test('returns an empty array unchanged', () => {
    expect(readOptionalStringArray({ files: [] }, 'files')).toEqual([])
  })
  test('returns undefined when the key is absent', () => {
    expect(readOptionalStringArray({}, 'files')).toBeUndefined()
  })
  test('throws when the value is not an array', () => {
    expect(() => readOptionalStringArray({ files: 'not-an-array' }, 'files')).toThrow('files must be an array of strings when provided')
  })
  test('throws when a single element is not a string', () => {
    expect(() => readOptionalStringArray({ files: ['a', 42] }, 'files')).toThrow('files must be an array of strings when provided')
  })
})

describe('readRequiredUnknown', () => {
  test('returns the value verbatim when the key is present', () => {
    const payload = { nested: true }
    expect(readRequiredUnknown({ payload }, 'payload')).toBe(payload)
  })
  test('returns undefined when the value is explicitly undefined (present-but-undefined counts as present)', () => {
    expect(readRequiredUnknown({ payload: undefined }, 'payload')).toBeUndefined()
  })
  test('returns null when the value is explicitly null', () => {
    expect(readRequiredUnknown({ payload: null }, 'payload')).toBeNull()
  })
  test('throws when the key is absent', () => {
    expect(() => readRequiredUnknown({}, 'payload')).toThrow('payload is required')
  })
})
