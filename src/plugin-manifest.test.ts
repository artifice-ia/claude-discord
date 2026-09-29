/**
 * Release-artifact invariants.
 *
 * Three files carry this release's version — `package.json`,
 * `.claude-plugin/plugin.json` and the CHANGELOG's top heading — and all three
 * can drift independently. Each drift has its own silent failure:
 *
 *  - the manifest is what Claude Code's `/plugin update` compares, so a release
 *    that bumps only `package.json` publishes fine, passes every other test and
 *    then never reaches a single installed bot — the update simply never fires;
 *  - a CHANGELOG heading naming a version that was never shipped sends the next
 *    operator to the wrong entry while they are diagnosing something.
 *
 * None of this is visible from inside the running process, which is why it
 * needs a test rather than a review habit.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')

function readJson(relativePath: string): { version?: unknown } {
  return JSON.parse(readFileSync(join(ROOT, relativePath), 'utf8'))
}

/** The version in the CHANGELOG's first `## x.y.z` heading, or null. */
function topChangelogVersion(): string | null {
  const heading = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8')
    .split('\n')
    .find(line => /^## /.test(line))
  return heading?.match(/^## (\d+\.\d+\.\d+)$/)?.[1] ?? null
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

  test('the CHANGELOG leads with the version being shipped', () => {
    // Same class as the manifest drift, different artifact. Asserted against a
    // parsed heading rather than a substring search, so a stray mention of the
    // version further down the file cannot satisfy it.
    const pkg = readJson('package.json').version
    expect(typeof pkg).toBe('string')
    expect(topChangelogVersion()).toBe(pkg as string)
  })
})
