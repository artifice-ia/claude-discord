/**
 * Startup-path tests for the fleet-bus dedup store.
 *
 * These spawn the real `server.ts` because the property under test is where a
 * failure lands, not what the library throws. The library already proves it
 * rejects a missing parent, an unwritable parent and a non-database file
 * (yugo #47); what this file proves is that the plugin opens the store on the
 * FATAL path, so unusable storage kills the process — rather than inside the
 * async supervisor block, whose catch swallows the throw and lets Discord come
 * up with a silently dead bus.
 *
 * Everything runs against a throwaway HOME and state dir; no test touches the
 * operator's real `~/.claude`. The Discord token is deliberately bogus: these
 * assertions are about stderr emitted before `client.login` is ever reached.
 */

import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SERVER = join(import.meta.dir, '..', 'server.ts')
const FATAL_STORAGE = 'fatal FleetBus storage error'

/** Time to let a NON-fatal case run before killing it. Fatal cases exit well under this. */
const RUN_MS = 6000

interface StartupResult {
  status: number | null
  stderr: string
}

/**
 * Run server.ts with a hermetic env. `extra` supplies the fleet-bus knobs
 * under test. Fatal paths exit immediately; anything that survives to the
 * Discord login is killed at RUN_MS and judged on stderr.
 */
function runServer(home: string, extra: Record<string, string>): StartupResult {
  const result = spawnSync(process.execPath, [SERVER], {
    encoding: 'utf8',
    timeout: RUN_MS,
    killSignal: 'SIGKILL',
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: home,
      // Keep the process away from the operator's real state, persona and .env.
      DISCORD_STATE_DIR: join(home, 'state'),
      CLAUDE_CONFIG_DIR: join(home, 'claude-config'),
      DISCORD_BOT_TOKEN: 'not-a-real-token',
      ...extra,
    },
  })
  return { status: result.status, stderr: result.stderr ?? '' }
}

/** A HOME containing `.claude/`, plus the token file and manifest the bus needs. */
function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'artifice-startup-'))
  const claude = join(home, '.claude')
  spawnSync('mkdir', ['-p', claude])
  writeFileSync(join(claude, 'fleet-bus-token-vec'), 'unused-password\n')
  writeFileSync(join(claude, 'fleet-manifest.yaml'), 'bot_names:\n  - vec\n  - deet\n')
  return home
}

function busEnv(home: string, dedupPath: string): Record<string, string> {
  return {
    FLEET_BUS_DISABLED: '0',
    FLEET_BUS_USER: 'vec',
    FLEET_BUS_DEDUP_STORE_PATH: dedupPath,
    FLEET_BUS_TOKEN_FILE: join(home, '.claude', 'fleet-bus-token-vec'),
    FLEET_BUS_MANIFEST_PATH: join(home, '.claude', 'fleet-manifest.yaml'),
    FLEET_BUS_AUDIT_LOG_PATH: join(home, '.claude', 'audit.jsonl'),
    // A port nothing listens on — the supervisor must retry, not take the
    // process down with it.
    FLEET_BUS_URL: 'nats://127.0.0.1:14222',
  }
}

describe('fleet-bus dedup store preflight (server.ts startup)', () => {
  test('missing parent directory is fatal', () => {
    const home = makeHome()
    try {
      const dedup = join(home, 'no-such-dir', 'dedup.sqlite')
      const { status, stderr } = runServer(home, busEnv(home, dedup))
      expect(stderr).toContain(FATAL_STORAGE)
      expect(stderr).toContain(dedup)
      expect(status).toBe(1)
      expect(existsSync(dedup)).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 20000)

  test('unwritable parent directory is fatal', () => {
    const home = makeHome()
    const locked = join(home, 'locked')
    spawnSync('mkdir', ['-p', locked])
    try {
      chmodSync(locked, 0o500)
      const dedup = join(locked, 'dedup.sqlite')
      const { status, stderr } = runServer(home, busEnv(home, dedup))
      expect(stderr).toContain(FATAL_STORAGE)
      expect(stderr).toContain(dedup)
      expect(status).toBe(1)
    } finally {
      chmodSync(locked, 0o700)
      rmSync(home, { recursive: true, force: true })
    }
  }, 20000)

  test('an existing file that is not a SQLite database is fatal', () => {
    const home = makeHome()
    try {
      const dedup = join(home, '.claude', 'not-a-db.sqlite')
      writeFileSync(dedup, 'this is plain text, not a database\n')
      const { status, stderr } = runServer(home, busEnv(home, dedup))
      expect(stderr).toContain(FATAL_STORAGE)
      expect(stderr).toContain(dedup)
      expect(status).toBe(1)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 20000)

  test('an absent store file is created, not treated as an error (SPEC §14 INITIAL)', () => {
    const home = makeHome()
    try {
      const dedup = join(home, '.claude', 'fleet-bus-dedup-vec.sqlite')
      expect(existsSync(dedup)).toBe(false)
      const { status, stderr } = runServer(home, busEnv(home, dedup))
      expect(stderr).not.toContain(FATAL_STORAGE)
      // First boot must MAKE the store, not refuse to start without one.
      expect(existsSync(dedup)).toBe(true)
      // And startup carried on to its normal clean shutdown.
      expect(stderr).toContain('shutting down')
      expect(status).toBe(0)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 20000)

  test('a NATS connection failure stays non-fatal', () => {
    const home = makeHome()
    try {
      const dedup = join(home, '.claude', 'fleet-bus-dedup-vec.sqlite')
      // FLEET_BUS_URL points at a dead port. Storage is a local precondition
      // and is fatal; connectivity is not — Discord never waits on the network.
      const { status, stderr } = runServer(home, busEnv(home, dedup))
      expect(stderr).not.toContain(FATAL_STORAGE)
      expect(stderr).not.toContain('fatal FleetBus')
      // The IIFE's catch did not fire either: the runtime was built and the
      // supervisor took the dead port, which is exactly where a NATS failure
      // belongs. (`FleetBus unavailable` is that catch's message.)
      expect(stderr).not.toContain('FleetBus unavailable')
      // The connect was attempted and reported as a supervisor retry, not as a
      // startup failure — and the process still reached its clean shutdown.
      expect(stderr).toContain('supervisor: connect failed')
      expect(stderr).toContain('CONNECTION_REFUSED')
      expect(stderr).toContain('shutting down')
      expect(status).toBe(0)
      // And the store opened, so the run got past the preflight.
      expect(existsSync(dedup)).toBe(true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 20000)

  test('FLEET_BUS_DISABLED keeps the store out of startup entirely', () => {
    const home = makeHome()
    try {
      // Bus off (the gate is an exact '0'). Two sub-cases, because each catches
      // a different leak:
      //
      //  (a) a path that cannot work — a Discord-only bot must start anyway;
      //  (b) a path that WOULD work — nothing may open it, so the absence of
      //      the file is proof the gate was respected rather than proof the
      //      path was broken.
      const broken = join(home, 'no-such-dir', 'dedup.sqlite')
      const brokenRun = runServer(home, { ...busEnv(home, broken), FLEET_BUS_DISABLED: '1' })
      expect(brokenRun.stderr).not.toContain(FATAL_STORAGE)
      expect(brokenRun.stderr).not.toContain('FleetBus')
      expect(brokenRun.stderr).not.toContain('unusable')
      expect(existsSync(broken)).toBe(false)
      expect(brokenRun.stderr).toContain('shutting down')
      expect(brokenRun.status).toBe(0)

      const usable = join(home, '.claude', 'fleet-bus-dedup-vec.sqlite')
      const usableRun = runServer(home, { ...busEnv(home, usable), FLEET_BUS_DISABLED: '1' })
      expect(existsSync(usable)).toBe(false)
      expect(usableRun.stderr).toContain('shutting down')
      expect(usableRun.status).toBe(0)
      // Nor did anything fall back to the default path.
      expect(existsSync(join(home, '.claude', 'fleet-bus-dedup-deet.sqlite'))).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 30000)
})
