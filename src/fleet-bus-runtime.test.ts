/**
 * BusRuntime integration test — proves the plugin-side supervisor loop,
 * config plumbing, and injection callback actually execute end-to-end with
 * a mocked NATS connection. This is the runtime-safety net that
 * `bun build --outdir` alone does not provide (see
 * [[feedback_bun_build_not_runtime_safe]]).
 *
 * We DO NOT hit the live norstar NATS — a second "luna" identity would
 * collide with the primary Luna session's heartbeat + subscriptions.
 */

import { describe, expect, test } from 'bun:test'
import { JSONCodec, type Msg, type NatsConnection } from 'nats'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BusRuntime, type BusRuntimeConfig } from './fleet-bus-wiring'
import type { Envelope, FleetBusSessionEvent } from '@artifice-ia/fleet-bus'

const jc = JSONCodec()

interface FakeSubscription {
  subject: string
  push: (msg: Msg) => void
  unsubscribe: () => void
}

class FakeNatsConnection {
  publishes: Array<{ subject: string; envelope: unknown }> = []
  subscribed: string[] = []
  private closed_ = false
  private readonly closedResolve: () => void
  readonly closedPromise: Promise<void>
  private readonly subscriptions: FakeSubscription[] = []

  constructor() {
    let resolve: () => void = () => {}
    this.closedPromise = new Promise<void>(r => { resolve = r })
    this.closedResolve = resolve
  }

  publish(subject: string, data: Uint8Array): void {
    if (this.closed_) throw new Error('closed')
    this.publishes.push({ subject, envelope: jc.decode(data) })
  }

  subscribe(subject: string): { unsubscribe: () => void; [Symbol.asyncIterator]: () => AsyncIterator<Msg> } {
    this.subscribed.push(subject)
    const queue: Msg[] = []
    let notify: (() => void) | null = null
    let done = false
    const self = this
    const push = (msg: Msg): void => {
      queue.push(msg)
      const n = notify
      notify = null
      n?.()
    }
    const unsubscribe = (): void => {
      done = true
      const n = notify
      notify = null
      n?.()
    }
    this.subscriptions.push({ subject, push, unsubscribe })
    return {
      unsubscribe,
      [Symbol.asyncIterator](): AsyncIterator<Msg> {
        return {
          async next(): Promise<IteratorResult<Msg>> {
            while (queue.length === 0) {
              if (done || self.closed_) return { value: undefined as unknown as Msg, done: true }
              await new Promise<void>(r => { notify = r })
            }
            return { value: queue.shift()!, done: false }
          },
        }
      },
    }
  }

  isClosed = (): boolean => this.closed_
  close = async (): Promise<void> => { this.markClosed() }
  drain = async (): Promise<void> => { this.markClosed() }
  closed = (): Promise<void> => this.closedPromise
  status = (): AsyncIterable<unknown> => (
    { [Symbol.asyncIterator]: (): AsyncIterator<unknown> => ({ next: (): Promise<IteratorResult<unknown>> => new Promise(() => {}) }) }
  )

  push(subject: string, envelope: unknown): void {
    const msg = { subject, data: jc.encode(envelope) } as Msg
    for (const sub of this.subscriptions) {
      if (sub.subject === subject) sub.push(msg)
    }
  }

  markClosed(): void {
    if (this.closed_) return
    this.closed_ = true
    for (const sub of this.subscriptions) sub.unsubscribe()
    this.closedResolve()
  }
}

function writeManifest(path: string, names: string[]): void {
  writeFileSync(path, `version: 1\nbot_names:\n${names.map(n => `  - ${n}`).join('\n')}\n`)
}

function makeConfig(overrides: Partial<BusRuntimeConfig>, manifestPath: string, auditLogPath: string): BusRuntimeConfig {
  return {
    botName: 'luna',
    password: 'unused',
    url: 'nats://unused',
    mode: 'primary',
    pluginVersion: '0.0.0-test',
    manifestPath,
    auditLogPath,
    subscribeBroadcast: false,
    heartbeatIntervalMs: 20,
    supervisorSleepMs: 10,
    // Peer sets aren't exercised by the runtime supervisor — only the
    // bus_request handler in server.ts reads them. Empty defaults keep the
    // runtime tests focused on transport/injection concerns.
    codexBots: new Set<string>(),
    claudeBots: new Set<string>(),
    logger: () => {},
    injectIntoSession: async () => {},
    ...overrides,
  }
}

describe('BusRuntime supervisor + wiring (cold-boot runtime smoke)', () => {
  test('supervisor connects, publishes a heartbeat, and shuts down cleanly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-bus-runtime-'))
    const manifestPath = join(dir, 'manifest.yaml')
    writeManifest(manifestPath, ['luna', 'ohm'])
    const nc = new FakeNatsConnection()
    const runtime = new BusRuntime(
      makeConfig({ connectFn: async () => nc as unknown as NatsConnection }, manifestPath, join(dir, 'audit.jsonl')),
    )
    runtime.start()
    // Wait long enough for connect + at least two heartbeat intervals.
    await new Promise(r => setTimeout(r, 80))
    // Heartbeat published on fleet.luna.status.
    const statusPubs = nc.publishes.filter(p => p.subject === 'fleet.luna.status')
    expect(statusPubs.length).toBeGreaterThanOrEqual(1)
    expect((statusPubs[0]!.envelope as Envelope).kind).toBe('status_heartbeat')
    // Subscriptions established for request/result/status (primary mode).
    expect(nc.subscribed).toContain('fleet.luna.request')
    expect(nc.subscribed).toContain('fleet.luna.result')
    expect(nc.subscribed).toContain('fleet.luna.status')
    await runtime.stop()
  })

  test('supervisor delivers an inbound request through injectIntoSession with baton meta', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-bus-runtime-'))
    const manifestPath = join(dir, 'manifest.yaml')
    writeManifest(manifestPath, ['luna', 'ohm'])
    const nc = new FakeNatsConnection()
    const events: Array<{ frameMeta: Record<string, string>; event: FleetBusSessionEvent }> = []
    const runtime = new BusRuntime(
      makeConfig(
        {
          injectIntoSession: async (frame, event) => {
            events.push({ frameMeta: frame.meta, event })
          },
          connectFn: async () => nc as unknown as NatsConnection,
        },
        manifestPath,
        join(dir, 'audit.jsonl'),
      ),
    )
    runtime.start()
    await new Promise(r => setTimeout(r, 40))
    const inbound: Envelope = {
      envelope_version: 1,
      id: 'env-inject',
      from: 'ohm',
      to: 'luna',
      kind: 'pr_review_request',
      ts: new Date().toISOString(),
      payload: { pr: 42 },
      root_id: 'root-inject',
      origin: 'ohm',
      owner: 'ohm',
      hops: 0,
    }
    nc.push('fleet.luna.request', inbound)
    await new Promise(r => setTimeout(r, 20))
    expect(events.length).toBe(1)
    expect(events[0]!.frameMeta.env_id).toBe('env-inject')
    expect(events[0]!.frameMeta.from_claim).toBe('ohm')
    expect(events[0]!.frameMeta.root_id).toBe('root-inject')
    expect(events[0]!.frameMeta.origin).toBe('ohm')
    expect(events[0]!.frameMeta.owner).toBe('ohm')
    expect(events[0]!.frameMeta.hops).toBe('0')
    // Runtime state reflects delivery.
    expect(runtime.injectionsDelivered).toBe(1)
    expect(runtime.lastInjectionTs).toBeTruthy()
    await runtime.stop()
  })

  test('statusSnapshot exposes counters, mode, and rate-limit fields', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-bus-runtime-'))
    const manifestPath = join(dir, 'manifest.yaml')
    writeManifest(manifestPath, ['luna'])
    const runtime = new BusRuntime(
      makeConfig({ mode: 'publish-only' }, manifestPath, join(dir, 'audit.jsonl')),
    )
    runtime.markConnected()
    const snap = runtime.statusSnapshot()
    expect(snap.state).toBe('connected')
    expect(snap.mode).toBe('publish-only')
    expect(snap.bot_name).toBe('luna')
    expect(snap.manifest_size).toBe(1)
    expect(snap.injections_delivered).toBe(0)
    expect(snap.injections_failed).toBe(0)
    const rl = snap.rate_limits as { per_from: unknown; per_subject: unknown; per_session_inject: unknown }
    expect(rl.per_from).toBeTruthy()
    expect(rl.per_subject).toBeTruthy()
    expect(rl.per_session_inject).toBeTruthy()
  })

  test('publish-only mode skips subscriptions AND heartbeat', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-bus-runtime-'))
    const manifestPath = join(dir, 'manifest.yaml')
    writeManifest(manifestPath, ['luna'])
    const nc = new FakeNatsConnection()
    const runtime = new BusRuntime(
      makeConfig(
        { mode: 'publish-only', connectFn: async () => nc as unknown as NatsConnection },
        manifestPath,
        join(dir, 'audit.jsonl'),
      ),
    )
    runtime.start()
    await new Promise(r => setTimeout(r, 60))
    expect(nc.subscribed).toEqual([])
    expect(nc.publishes.filter(p => p.subject.endsWith('.status'))).toEqual([])
    await runtime.stop()
  })
})
