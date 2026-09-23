import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

type ReplyPublisher = {
  publishReply: (reqId: string, payload: unknown, kind: string, replyToken: string | null) => unknown
}

function toolError(message: string): CallToolResult {
  return { content: [{ type: 'text', text: `bus_reply failed: ${message}` }], isError: true }
}

/**
 * Runtime boundary for bus_reply. tools/list JSON Schema is descriptive only
 * when using the SDK's low-level CallToolRequestSchema handler, so all fields
 * are checked here before the publisher is touched.
 */
export function handleBusReply(args: Record<string, unknown>, bus: ReplyPublisher | null): CallToolResult {
  if (typeof args.req_id !== 'string') return toolError('req_id must be a string')
  if (!Object.hasOwn(args, 'reply_token')) return toolError('reply_token is required')
  if (args.reply_token !== null && typeof args.reply_token !== 'string') {
    return toolError('reply_token must be a string or null')
  }
  if (!Object.hasOwn(args, 'payload')) return toolError('payload is required')
  if (args.kind !== undefined && typeof args.kind !== 'string') {
    return toolError('kind must be a string when provided')
  }
  if (!bus) return toolError('fleet-bus disabled or unavailable')

  const result = bus.publishReply(
    args.req_id,
    args.payload,
    args.kind ?? 'result',
    args.reply_token,
  )
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
}
