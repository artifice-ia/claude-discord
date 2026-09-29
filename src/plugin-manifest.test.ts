/**
 * Packaging invariant: the plugin manifest version and the package version must
 * match.
 *
 * Claude Code's `/plugin update` compares the version in
 * `.claude-plugin/plugin.json`, not the one in `package.json`. A release that
 * bumps only `package.json` publishes fine, passes every other test, and then
 * never reaches a single installed bot — the update simply never fires. Nothing
 * else in this suite can see that, because it is invisible from inside the
 * running process.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')

function readJson(relativePath: string): { version?: unknown } {
  return JSON.parse(readFileSync(join(ROOT, relativePath), 'utf8'))
}

describe('plugin manifest', () => {
  test('version is in lockstep with package.json', () => {
    const manifest = readJson('.claude-plugin/plugin.json').version
    const pkg = readJson('package.json').version
    // Assert the shape first: two `undefined`s would otherwise compare equal
    // and the test would pass against a manifest with no version at all.
    expect(typeof manifest).toBe('string')
    expect(typeof pkg).toBe('string')
    expect(manifest).toBe(pkg)
  })
})
