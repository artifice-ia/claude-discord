// Runtime validation for MCP tool arguments.
//
// The SDK's low-level `Server.setRequestHandler(CallToolRequestSchema, ...)`
// validates only the generic tools/call envelope shape — the per-tool
// `inputSchema` returned from `tools/list` is descriptive, never enforced.
// (Ohm reproduced this with linked in-memory transports; issue #39 details.)
// Casts like `args.foo as string` are erased at runtime; a caller sending
// `args.foo = 42` would reach the handler with a Number where the handler
// expects a String.
//
// These helpers replace the blind casts with real checks. On failure they
// throw a TypeError; the outer try/catch in `server.ts` converts that to
// `{content: [{type: 'text', text: '<tool> failed: <msg>'}], isError: true}`,
// matching the existing per-tool error shape (see e.g. the `reply` case:
// "channel is not sendable", "file too large").
//
// Design notes on "optional":
//   - An OPTIONAL field is present-but-undefined OR absent from `args`. Both
//     are treated as "not provided" and return undefined without throwing.
//   - A wrong-TYPE optional (e.g. `args.limit = 'twenty'` when limit is
//     optional-number) still throws — the point of these helpers is to
//     surface type violations at the boundary, not to tolerate them.
//   - Presence uses `Object.hasOwn`, not `key in args`, so a caller cannot
//     bypass by putting the key on Object.prototype.

export function readString(args: Record<string, unknown>, key: string): string {
  const v = args[key]
  if (typeof v !== 'string') throw new TypeError(`${key} must be a string`)
  return v
}

export function readOptionalString(args: Record<string, unknown>, key: string): string | undefined {
  if (!Object.hasOwn(args, key) || args[key] === undefined) return undefined
  const v = args[key]
  if (typeof v !== 'string') throw new TypeError(`${key} must be a string when provided`)
  return v
}

export function readOptionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  if (!Object.hasOwn(args, key) || args[key] === undefined) return undefined
  const v = args[key]
  if (typeof v !== 'number') throw new TypeError(`${key} must be a number when provided`)
  return v
}

export function readOptionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  if (!Object.hasOwn(args, key) || args[key] === undefined) return undefined
  const v = args[key]
  if (typeof v !== 'boolean') throw new TypeError(`${key} must be a boolean when provided`)
  return v
}

// Array-of-string is common enough (attachment lists, bot lists) to give it
// its own helper. Element-type check catches `[42]` where `['a']` is meant.
export function readOptionalStringArray(args: Record<string, unknown>, key: string): string[] | undefined {
  if (!Object.hasOwn(args, key) || args[key] === undefined) return undefined
  const v = args[key]
  if (!Array.isArray(v)) throw new TypeError(`${key} must be an array of strings when provided`)
  for (const item of v) {
    if (typeof item !== 'string') throw new TypeError(`${key} must be an array of strings when provided`)
  }
  return v as string[]
}

// bus_request accepts a `payload` of any shape (it's the caller's envelope
// body). We check ONLY that the property is present — the shape check happens
// downstream at the bus adapter or the peer bot. Absent payload IS an error;
// an explicit null or empty object is fine.
export function readRequiredUnknown(args: Record<string, unknown>, key: string): unknown {
  if (!Object.hasOwn(args, key)) throw new TypeError(`${key} is required`)
  return args[key]
}
