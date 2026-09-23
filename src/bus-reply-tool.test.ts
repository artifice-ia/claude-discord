import { afterEach, describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { handleBusReply } from './bus-reply-tool'

type PublishCall = {
  reqId: string
  payload: unknown
  kind: string
  replyToken: string | null
}

const open: Array<{ client: Client; server: Server }> = []

afterEach(async () => {
  await Promise.all(open.splice(0).map(async ({ client, server }) => {
    await client.close()
    await server.close()
  }))
})

async function connectedToolClient(currentToken: string | null = null): Promise<{
  client: Client
  calls: PublishCall[]
}> {
  const calls: PublishCall[] = []
  const bus = {
    publishReply(reqId: string, payload: unknown, kind: string, replyToken: string | null) {
      calls.push({ reqId, payload, kind, replyToken })
      if (currentToken !== null && replyToken !== currentToken) {
        return { ok: false, error: 'claude_discord_adapter_reply_token_mismatch' }
      }
      return { ok: true }
    },
  }
  const server = new Server({ name: 'bus-reply-test', version: '1.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(CallToolRequestSchema, req => {
    if (req.params.name !== 'bus_reply') throw new Error('unexpected tool')
    return handleBusReply((req.params.arguments ?? {}) as Record<string, unknown>, bus)
  })
  const client = new Client({ name: 'test-client', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  open.push({ client, server })
  return { client, calls }
}

describe('bus_reply registered MCP handler boundary', () => {
  test('rejects an omitted reply_token without touching the bus', async () => {
    const { client, calls } = await connectedToolClient()
    const result = await client.callTool({ name: 'bus_reply', arguments: { req_id: 'req-1', payload: {} } })
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'bus_reply failed: reply_token is required' }])
    expect(calls).toHaveLength(0)
  })

  test('rejects a wrong-type reply_token without touching the bus', async () => {
    const { client, calls } = await connectedToolClient()
    const result = await client.callTool({ name: 'bus_reply', arguments: { req_id: 'req-1', reply_token: 42, payload: {} } })
    expect(result.isError).toBe(true)
    expect(calls).toHaveLength(0)
  })

  // Issue #38 — the following three guards were present but unpinned before this
  // commit. Ohm's mutation table showed each could be deleted and the pre-existing
  // suite still passed 5/5. Each new test asserts BOTH that the specific guard's
  // error surfaces AND that the bus was never touched, so a future deletion would
  // fail loudly. Do not weaken these to `expect(result.isError).toBe(true)` alone
  // — that would re-open the same hole under a different guard collapsing into a
  // near-identical error message.

  test('rejects a wrong-type req_id without touching the bus', async () => {
    const { client, calls } = await connectedToolClient()
    const result = await client.callTool({ name: 'bus_reply', arguments: { req_id: 42, reply_token: null, payload: {} } })
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'bus_reply failed: req_id must be a string' }])
    expect(calls).toHaveLength(0)
  })

  test('rejects an omitted payload without touching the bus', async () => {
    const { client, calls } = await connectedToolClient()
    const result = await client.callTool({ name: 'bus_reply', arguments: { req_id: 'req-1', reply_token: null } })
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'bus_reply failed: payload is required' }])
    expect(calls).toHaveLength(0)
  })

  test('rejects a wrong-type kind without touching the bus', async () => {
    const { client, calls } = await connectedToolClient()
    const result = await client.callTool({ name: 'bus_reply', arguments: { req_id: 'req-1', reply_token: null, payload: {}, kind: 42 } })
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'bus_reply failed: kind must be a string when provided' }])
    expect(calls).toHaveLength(0)
  })

  test('accepts an explicitly null token when no live claim exists', async () => {
    const { client, calls } = await connectedToolClient()
    const result = await client.callTool({ name: 'bus_reply', arguments: { req_id: 'req-late', reply_token: null, payload: { late: true } } })
    expect(result.isError).not.toBe(true)
    expect(calls).toEqual([{ reqId: 'req-late', payload: { late: true }, kind: 'result', replyToken: null }])
  })

  test('passes a stale token to the runtime fence and returns its refusal', async () => {
    const { client, calls } = await connectedToolClient('current-token')
    const result = await client.callTool({ name: 'bus_reply', arguments: { req_id: 'req-live', reply_token: 'stale-token', payload: {} } })
    expect(JSON.parse((result.content as Array<{ text: string }>)[0]!.text)).toEqual({
      ok: false,
      error: 'claude_discord_adapter_reply_token_mismatch',
    })
    expect(calls[0]!.replyToken).toBe('stale-token')
  })

  test('passes the current token through and publishes successfully', async () => {
    const { client, calls } = await connectedToolClient('current-token')
    const result = await client.callTool({ name: 'bus_reply', arguments: { req_id: 'req-live', reply_token: 'current-token', payload: { ok: true }, kind: 'custom_result' } })
    expect(JSON.parse((result.content as Array<{ text: string }>)[0]!.text)).toEqual({ ok: true })
    expect(calls).toEqual([{ reqId: 'req-live', payload: { ok: true }, kind: 'custom_result', replyToken: 'current-token' }])
  })
})
