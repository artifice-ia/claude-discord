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
 * From yugo Release 2 the store must also be bound to an operator-attested
 * verification record (SPEC-26 §8.2), and the plugin may not create either the
 * store or the record. Two assertions here previously encoded the opposite
 * (SPEC §14 `INITIAL`: first boot creates its own store); they now encode the
 * attestation contract that supersedes it. See CHANGELOG 0.10.0.
 *
 * Everything runs against a throwaway HOME and state dir; no test touches the
 * operator's real `~/.claude`. The Discord token is deliberately bogus: these
 * assertions are about stderr emitted before `client.login` is ever reached.
 */

import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SERVER = join(import.meta.dir, '..', 'server.ts')
const FATAL_STORAGE = 'fatal FleetBus storage error'
/** The two operator conditions the library's own message cannot tell apart. */
const ABSENT_STORE = 'dedup store does not exist'
const UNATTESTED_STORE = 'dedup store is not attested'
/** SPEC-26 §8.2: unset, with a file-backed store configured, must refuse. */
const UNSET_RECORD_VAR = 'YUGO_DEDUP_VERIFICATION_RECORD is unset'

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

/**
 * Linux `dev_t` decomposition, mirroring the package's own. Kept in bigint
 * throughout: a device number does not fit a JS number safely.
 */
function deviceNumbers(dev: bigint): [bigint, bigint] {
  return [
    ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & 0xfffff000n),
    (dev & 0xffn) | ((dev >> 12n) & 0xffffff00n),
  ]
}

/**
 * The eight-column fingerprint Release 2 supports, for records that must be
 * written for a file no `PRAGMA table_info` can be read from (a non-database
 * file). `provisionStore` reads its fingerprint off the live database instead.
 */
const SUPPORTED_COLUMNS = [
  { name: 'envelope_id', declared_type: 'TEXT' },
  { name: 'first_seen_ms', declared_type: 'INTEGER' },
  { name: 'req_id', declared_type: 'TEXT' },
  { name: 'state', declared_type: 'TEXT' },
  { name: 'lease_owner', declared_type: 'TEXT' },
  { name: 'lease_until_ms', declared_type: 'INTEGER' },
  { name: 'lease_boot_id', declared_type: 'TEXT' },
  { name: 'lease_until_mono_ms', declared_type: 'INTEGER' },
]

/**
 * Write a verification record binding whatever file sits at `path`, returning
 * the record path. Split out from `provisionStore` because two tests need a
 * record for a file that is deliberately not a usable store — an attested but
 * non-SQLite file has to get *past* the plugin's advisory existence checks so
 * the library is what rejects it.
 *
 * `devno` binding, matching what the package's own fixtures use: the store
 * lives under a throwaway `tmpdir()` whose filesystem may have no
 * `/dev/disk/by-uuid` entry at all. Live stores should be attested with the
 * UUID binding, which survives a reboot; a devno record carries the boot id it
 * was taken under and must be re-attested after every restart.
 */
function writeVerificationRecord(path: string, columns: { name: string; declared_type: string }[]): string {
  const stat = statSync(path, { bigint: true })
  const [major, minor] = deviceNumbers(stat.dev)
  const recordPath = `${path}.verification.json`
  writeFileSync(recordPath, JSON.stringify({
    record_version: 1,
    canonical_path: realpathSync(path),
    device: {
      binding: 'devno',
      major: Number(major),
      minor: Number(minor),
      attested_boot_id: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
    },
    inode: stat.ino.toString(),
    port: 'typescript',
    schema_fingerprint: { table: 'envelope_dedup_v2', columns },
    storage_evidence: {
      device_path: 'test fixture', mount_point: 'unresolved', fstype: 'unresolved',
      mount_id_source: 'unresolved', backing: 'local-virtual',
      determined_by: 'test fixture only', uuid_resolution: 'test devno binding',
      inspected_at: '2026-09-24T19:00:00Z',
    },
    participant_inventory: [{ process: 'bun test', user: 'test', path, method: 'test fixture' }],
    attested_by: 'server-startup.test.ts',
    attested_at: '2026-09-24T19:00:00Z',
  }))
  return recordPath
}

/**
 * Stand in for `yugo dedup provision` — create an eight-column WAL store and
 * the verification record that binds it, returning the record path.
 *
 * Written here rather than imported from the package: the package's own
 * `src/dedup-test-fixtures.ts` is reachable on disk (bun's git install ignores
 * the `files` allowlist) but is absent from its `exports` map, so a deep import
 * does not resolve — and yugo #58 flags that a future packed tarball would drop
 * the file entirely.
 *
 * The schema fingerprint is read back off the live database rather than
 * transcribed, so this fixture cannot silently disagree with what it built. If
 * the package's `SUPPORTED_SCHEMA` moves, the library rejects this record and
 * these tests go red — which is the failure worth having.
 */
function provisionStore(storePath: string): string {
  const db = new Database(storePath, { create: true })
  db.exec('PRAGMA journal_mode=WAL')
  db.exec(`CREATE TABLE envelope_dedup_v2 (
    envelope_id TEXT PRIMARY KEY, first_seen_ms INTEGER NOT NULL,
    req_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','completed')),
    lease_owner TEXT NOT NULL, lease_until_ms INTEGER NOT NULL,
    lease_boot_id TEXT NOT NULL DEFAULT '', lease_until_mono_ms INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX envelope_dedup_v2_first_seen ON envelope_dedup_v2(first_seen_ms)`)
  const columns = (db.query('PRAGMA table_info(envelope_dedup_v2)').all() as { name: string; type: string }[])
    .map(row => ({ name: row.name, declared_type: row.type }))
  db.close()
  return writeVerificationRecord(storePath, columns)
}

/**
 * `record` is required and may be `null`, which omits
 * `YUGO_DEDUP_VERIFICATION_RECORD` entirely. There is no default here on
 * purpose: SPEC-26 §8.2 gives the variable no default in the product either, so
 * every call site has to say which record it configures — or that it configures
 * none.
 */
function busEnv(home: string, dedupPath: string, record: string | null): Record<string, string> {
  const env: Record<string, string> = {
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
  if (record !== null) env.YUGO_DEDUP_VERIFICATION_RECORD = record
  return env
}

describe('fleet-bus dedup store preflight (server.ts startup)', () => {
  test('an absent store under a missing parent is refused without creating directories', () => {
    // Under `create: false` a missing parent is no longer a failure mode of its
    // own — the store simply cannot exist, so this lands on the absent-store
    // branch. What it still proves, and the absent-store test cannot, is that
    // refusing does not reach for `mkdir`: yugo #47 removed the implicit
    // directory creation, and a plugin that quietly restored it would leave an
    // empty tree beside every misconfigured bot.
    const home = makeHome()
    try {
      const parent = join(home, 'no-such-dir')
      const dedup = join(parent, 'dedup.sqlite')
      expect(existsSync(parent)).toBe(false)
      const { status, stderr } = runServer(home, busEnv(home, dedup, `${dedup}.verification.json`))
      expect(stderr).toContain(FATAL_STORAGE)
      expect(stderr).toContain(ABSENT_STORE)
      expect(stderr).toContain(dedup)
      expect(status).toBe(1)
      expect(existsSync(dedup)).toBe(false)
      // The parent is untouched — nothing was created on the way to refusing.
      expect(existsSync(parent)).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 20000)

  // `chmod 0o500` does not stop root, which ignores directory write
  // permissions entirely — as root this test would provision a store, fail to
  // make the directory unwritable, and then pass or fail for reasons that have
  // nothing to do with permissions. Skipping loudly beats reporting a
  // root-owned pass as permission proof. CI runs unprivileged, so this is about
  // a local `sudo bun test`, not the pipeline.
  const permissionTest = process.getuid?.() === 0 ? test.skip : test

  permissionTest('unwritable parent directory is fatal', () => {
    // The store and its record both exist and are attested, so both advisory
    // existence checks pass and the failure has to come from the library's own
    // `accessSync(dir, W_OK)` precondition. A read-only parent is still fatal
    // under Release 2: SQLite in WAL mode must create `-wal`/`-shm` beside the
    // store, so a store it can only read is a store it cannot use.
    const home = makeHome()
    const locked = join(home, 'locked')
    spawnSync('mkdir', ['-p', locked])
    try {
      const dedup = join(locked, 'dedup.sqlite')
      const record = provisionStore(dedup)
      chmodSync(locked, 0o500)
      const { status, stderr } = runServer(home, busEnv(home, dedup, record))
      expect(stderr).toContain(FATAL_STORAGE)
      expect(stderr).toContain(dedup)
      // Reached the library, which named the parent directory. Neither advisory
      // check fired — this test is about permissions, not about absence.
      expect(stderr).toContain('is not writable')
      expect(stderr).toContain(locked)
      expect(stderr).not.toContain(ABSENT_STORE)
      expect(stderr).not.toContain(UNATTESTED_STORE)
      expect(status).toBe(1)
    } finally {
      chmodSync(locked, 0o700)
      rmSync(home, { recursive: true, force: true })
    }
  }, 20000)

  test('an existing file that is not a SQLite database is fatal', () => {
    // Attested, so both advisory existence checks pass and the file reaches the
    // library. A record binds a path, an inode and a device — it says nothing
    // about the bytes — so "attested" and "is a database" are independent, and
    // only the library can rule on the second.
    const home = makeHome()
    try {
      const dedup = join(home, '.claude', 'not-a-db.sqlite')
      writeFileSync(dedup, 'this is plain text, not a database\n')
      const record = writeVerificationRecord(dedup, SUPPORTED_COLUMNS)
      const { status, stderr } = runServer(home, busEnv(home, dedup, record))
      expect(stderr).toContain(FATAL_STORAGE)
      expect(stderr).toContain(dedup)
      // The library's own verdict on the bytes, not either advisory check.
      expect(stderr).toContain('file is not a database')
      expect(stderr).not.toContain(ABSENT_STORE)
      expect(stderr).not.toContain(UNATTESTED_STORE)
      expect(status).toBe(1)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 20000)

  test('an absent store file is fatal and is never created (SPEC-26 §8.2 attestation)', () => {
    // Reverses the 0.9.0 contract that first boot creates its own store
    // (SPEC §14 `INITIAL`). yugo Release 2 opens with `create: false` and binds
    // the store to an operator-attested record; SPEC-26 §8.2 states plainly
    // that a consumer must never create, refresh or repair its own store or
    // record, because self-attestation is not attestation. First boot against
    // an unprovisioned path refuses.
    const home = makeHome()
    try {
      const dedup = join(home, '.claude', 'fleet-bus-dedup-vec.sqlite')
      expect(existsSync(dedup)).toBe(false)
      // The variable IS set — so this is about the store being absent, not
      // about configuration being missing.
      const record = `${dedup}.verification.json`
      const { status, stderr } = runServer(home, busEnv(home, dedup, record))
      expect(stderr).toContain(FATAL_STORAGE)
      expect(stderr).toContain(ABSENT_STORE)
      // Absence is reported as absence, not as the record being missing — the
      // operator has to know which of the two to go and fix.
      expect(stderr).not.toContain(UNATTESTED_STORE)
      // The message has to carry all three things the operator needs: which
      // store, where the record was expected, and what produces it.
      expect(stderr).toContain(dedup)
      expect(stderr).toContain(`${dedup}.verification.json`)
      expect(stderr).toContain('yugo dedup provision')
      expect(status).toBe(1)
      // Refused, not silently created.
      expect(existsSync(dedup)).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 20000)

  test('an absent store is reported as absent even when a record survives it (SPEC-26 §8.2)', () => {
    // Provision, then remove only the store. A stale record left behind by a
    // moved or wiped store must not make the failure read as an attestation
    // problem — the store is what is gone.
    const home = makeHome()
    try {
      const dedup = join(home, '.claude', 'fleet-bus-dedup-vec.sqlite')
      const record = provisionStore(dedup)
      rmSync(dedup, { force: true })
      expect(existsSync(dedup)).toBe(false)
      expect(existsSync(record)).toBe(true)
      const { status, stderr } = runServer(home, busEnv(home, dedup, record))
      expect(stderr).toContain(FATAL_STORAGE)
      expect(stderr).toContain(ABSENT_STORE)
      expect(stderr).not.toContain(UNATTESTED_STORE)
      expect(status).toBe(1)
      expect(existsSync(dedup)).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 20000)

  test('a present but unattested store is fatal (SPEC-26 §8.2 attestation)', () => {
    // The other half of the reversal: the store exists and is perfectly good —
    // eight columns, WAL, right schema — and startup still refuses, because
    // nothing has attested it. This is the state every live store is in until
    // an operator runs `yugo dedup provision`.
    const home = makeHome()
    try {
      const dedup = join(home, '.claude', 'fleet-bus-dedup-vec.sqlite')
      const record = provisionStore(dedup)
      rmSync(record, { force: true })
      expect(existsSync(dedup)).toBe(true)
      const { status, stderr } = runServer(home, busEnv(home, dedup, record))
      expect(stderr).toContain(FATAL_STORAGE)
      expect(stderr).toContain(UNATTESTED_STORE)
      // Distinguishable from the absent case, which is the whole point of
      // classifying these two rather than letting both surface as the
      // library's single "missing verification record".
      expect(stderr).not.toContain(ABSENT_STORE)
      expect(stderr).toContain(dedup)
      expect(stderr).toContain(record)
      expect(stderr).toContain('yugo dedup provision')
      expect(status).toBe(1)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 20000)

  test('an unset YUGO_DEDUP_VERIFICATION_RECORD is fatal for a file-backed store (SPEC-26 §8.2)', () => {
    // §8.2: "an explicit path to an operator-provisioned file ... Unset while a
    // file-backed store is configured -> refuse consumption." The plugin
    // deliberately derives no default, so unset refuses on its own terms rather
    // than refusing later as a consequence of the file being absent. The store
    // here is fully provisioned — only the configuration is missing, which is
    // what isolates this from the absent and unattested cases.
    const home = makeHome()
    try {
      const dedup = join(home, '.claude', 'fleet-bus-dedup-vec.sqlite')
      const record = provisionStore(dedup)
      expect(existsSync(dedup)).toBe(true)
      expect(existsSync(record)).toBe(true)
      const { status, stderr } = runServer(home, busEnv(home, dedup, null))
      expect(stderr).toContain(FATAL_STORAGE)
      expect(stderr).toContain(UNSET_RECORD_VAR)
      // Not misreported as either filesystem condition: both files are there.
      expect(stderr).not.toContain(ABSENT_STORE)
      expect(stderr).not.toContain(UNATTESTED_STORE)
      // Names the variable to set and the command that produces its target.
      expect(stderr).toContain('YUGO_DEDUP_VERIFICATION_RECORD')
      expect(stderr).toContain('yugo dedup provision')
      expect(status).toBe(1)
      // A record sitting beside the store must NOT be adopted by convention —
      // that is the stale-record hazard the explicit variable exists to close.
      expect(stderr).not.toContain('supervisor: connect failed')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 20000)

  test("a ':memory:' store starts clean with no record and no record variable", () => {
    // `openVerifiedStore` creates a fresh in-memory schema for exactly this
    // string and returns before it consults any record, so SPEC-26 §8.2's
    // file-backed requirement does not reach it. The advisory existence checks
    // must not either: `existsSync(':memory:')` is false, and applying it here
    // would kill the package's own supported no-durability mode.
    const home = makeHome()
    try {
      const { status, stderr } = runServer(home, busEnv(home, ':memory:', null))
      expect(stderr).not.toContain(FATAL_STORAGE)
      expect(stderr).not.toContain(ABSENT_STORE)
      expect(stderr).not.toContain(UNSET_RECORD_VAR)
      expect(stderr).not.toContain('FleetBus unavailable')
      // Got past the preflight and into the supervisor, where the dead port is
      // a retry rather than a startup failure.
      expect(stderr).toContain('supervisor: connect failed')
      expect(stderr).toContain('shutting down')
      expect(status).toBe(0)
      // Nothing was created on disk under that name.
      expect(existsSync(join(home, '.claude', ':memory:'))).toBe(false)
      expect(existsSync(':memory:')).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 20000)

  test("a blank record variable is rejected even in ':memory:' mode", () => {
    // Memory mode never *consults* the record, but a blank value is still an
    // operator mistake and is rejected before the store mode is even chosen —
    // `parseFleetBusStartupConfig` runs first and treats blank as a typo rather
    // than as unset, exactly as it does for FLEET_BUS_DEDUP_STORE_PATH. So this
    // is a CONFIG error, not a storage one, and the distinction is what tells
    // the operator the variable is set-but-empty rather than absent.
    const home = makeHome()
    try {
      const { status, stderr } = runServer(home, {
        ...busEnv(home, ':memory:', null),
        YUGO_DEDUP_VERIFICATION_RECORD: '   ',
      })
      expect(stderr).toContain('fatal FleetBus config error')
      expect(stderr).toContain('YUGO_DEDUP_VERIFICATION_RECORD')
      expect(stderr).toContain('expected a non-empty filesystem path')
      // Not misattributed to storage — memory mode has no storage problem.
      expect(stderr).not.toContain(FATAL_STORAGE)
      expect(status).toBe(1)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 20000)

  test('a NATS connection failure stays non-fatal', () => {
    const home = makeHome()
    try {
      const dedup = join(home, '.claude', 'fleet-bus-dedup-vec.sqlite')
      // An attested store, so the run gets past the storage preflight and the
      // subject of this test is connectivity alone.
      const record = provisionStore(dedup)
      // FLEET_BUS_URL points at a dead port. Storage is a local precondition
      // and is fatal; connectivity is not — Discord never waits on the network.
      const { status, stderr } = runServer(home, busEnv(home, dedup, record))
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
      // `null` omits YUGO_DEDUP_VERIFICATION_RECORD entirely: a Discord-only
      // install must not newly require any of the Release 2 configuration.
      const brokenRun = runServer(home, { ...busEnv(home, broken, null), FLEET_BUS_DISABLED: '1' })
      expect(brokenRun.stderr).not.toContain(FATAL_STORAGE)
      expect(brokenRun.stderr).not.toContain('FleetBus')
      expect(brokenRun.stderr).not.toContain('unusable')
      expect(existsSync(broken)).toBe(false)
      expect(brokenRun.stderr).toContain('shutting down')
      expect(brokenRun.status).toBe(0)

      const usable = join(home, '.claude', 'fleet-bus-dedup-vec.sqlite')
      const usableRun = runServer(home, { ...busEnv(home, usable, null), FLEET_BUS_DISABLED: '1' })
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
