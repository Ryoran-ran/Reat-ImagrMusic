import { Mp3Encoder } from '@breezystack/lamejs'
import type { PcmData } from './types'

export interface Mp3EncoderAdapter {
  encode(pcm: PcmData, progress?: (fraction: number) => void, aborted?: () => boolean): Promise<Uint8Array>
}

export const lameAdapter: Mp3EncoderAdapter = {
  async encode(pcm, progress, aborted) {
    const encoder = new Mp3Encoder(pcm.channels, pcm.sampleRate, 128)
    const chunks: Uint8Array[] = [], block = 1152
    const view = new DataView(pcm.bytes.buffer, pcm.bytes.byteOffset, pcm.bytes.byteLength)
    for (let start = 0; start < pcm.frames; start += block) {
      if (aborted?.()) throw new DOMException('処理を中止しました。', 'AbortError')
      const count = Math.min(block, pcm.frames - start), left = new Int16Array(count)
      const right = pcm.channels === 2 ? new Int16Array(count) : undefined
      for (let i = 0; i < count; i++) {
        left[i] = view.getInt16((start + i) * pcm.channels * 2, true)
        if (right) right[i] = view.getInt16(((start + i) * 2 + 1) * 2, true)
      }
      const encoded = encoder.encodeBuffer(left, right)
      if (encoded.length) chunks.push(encoded.slice())
      if (start % (block * 16) === 0) {
        progress?.(Math.min(0.98, (start + count) / pcm.frames))
        await new Promise(resolve => setTimeout(resolve, 0))
      }
    }
    const tail = encoder.flush()
    if (tail.length) chunks.push(tail.slice())
    const output = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
    let offset = 0
    for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length }
    progress?.(1)
    return output
  },
}
