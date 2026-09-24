import prism from 'prism-media'
import { Readable } from 'stream'

function splitFramedOpusPackets(opusBuffer: Buffer): Buffer[] {
  const packets: Buffer[] = []
  let offset = 0
  while (offset + 4 <= opusBuffer.length) {
    const len = opusBuffer.readUInt32BE(offset)
    offset += 4
    if (len === 0 || offset + len > opusBuffer.length) return [opusBuffer]
    packets.push(opusBuffer.subarray(offset, offset + len))
    offset += len
  }
  return offset === opusBuffer.length && packets.length > 0 ? packets : [opusBuffer]
}

async function decodeOpusToPcm(opusBuffer: Buffer): Promise<Buffer> {
  if (opusBuffer.length === 0) return Buffer.alloc(0)

  return await new Promise<Buffer>((resolve, reject) => {
    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 })
    const chunks: Buffer[] = []

    decoder.on('data', (chunk: Buffer) => chunks.push(chunk))
    decoder.on('end', () => resolve(Buffer.concat(chunks)))
    decoder.on('error', reject)

    const input = Readable.from(splitFramedOpusPackets(opusBuffer))
    input.on('error', reject)
    input.pipe(decoder)
  })
}

function pcmToWav(pcm: Buffer, sampleRate = 48000, channels = 2, bitDepth = 16): Buffer {
  const byteRate = sampleRate * channels * (bitDepth / 8)
  const blockAlign = channels * (bitDepth / 8)
  const dataSize = pcm.length
  const wav = Buffer.allocUnsafe(44 + dataSize)

  wav.write('RIFF', 0)
  wav.writeUInt32LE(36 + dataSize, 4)
  wav.write('WAVE', 8)
  wav.write('fmt ', 12)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(channels, 22)
  wav.writeUInt32LE(sampleRate, 24)
  wav.writeUInt32LE(byteRate, 28)
  wav.writeUInt16LE(blockAlign, 32)
  wav.writeUInt16LE(bitDepth, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(dataSize, 40)
  pcm.copy(wav, 44)
  return wav
}

export async function transcribe(opusBuffer: Buffer): Promise<string> {
  const pcm = await decodeOpusToPcm(opusBuffer)
  if (pcm.length === 0) return ''

  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY not set')

  const wav = pcmToWav(pcm)
  const form = new FormData()
  // `Buffer`'s backing store is typed `ArrayBufferLike`, which since TS 5.7
  // includes `SharedArrayBuffer` and so no longer satisfies `BlobPart`.
  //
  // `new Uint8Array(wav)` COPIES the Buffer's elements into a fresh array — it
  // is not a view over `wav.buffer`. That matters: Node pools small Buffers, so
  // a view would expose neighbouring bytes from the shared 8KB backing store.
  // The copy is the cost, and it is the reason this is correct.
  //
  // Preferred over widening `lib` or reaching for `skipLibCheck`: one call
  // site, no config blast radius.
  form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'audio.wav')
  form.append('model', 'whisper-1')

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Whisper HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`)
  }

  const json = await res.json() as { text?: string }
  const text = (json.text ?? '').trim()
  return text
}
