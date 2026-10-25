/// <reference lib="webworker" />
import { imageToWav, wavToImage, writeWav } from './lib/wav'
import { imageToPng } from './lib/png'
import { generateMusic } from './lib/music'
import { lameAdapter } from './lib/mp3'
import { audioChannelsToPcmAsync, pcmToPixels, pixelsToPcm } from './lib/pcm'
import { spectrogramPng, waveformPng } from './lib/visualize'
import type { ImageDataInput, PcmData } from './lib/types'

type Request = { id: number; kind: string; payload: any }
const stopped = new Set<number>()
const progress = (id: number, fraction: number) => self.postMessage({ id, progress: Math.round(fraction * 100) })
function resultBuffers(value: unknown, buffers = new Set<ArrayBuffer>()): Set<ArrayBuffer> {
  if (ArrayBuffer.isView(value) && value.buffer instanceof ArrayBuffer) buffers.add(value.buffer)
  else if (value && typeof value === 'object') for (const child of Object.values(value)) resultBuffers(child, buffers)
  return buffers
}

self.onmessage = async (event: MessageEvent<Request>) => {
  const { id, kind, payload } = event.data
  if (kind === 'cancel') { stopped.add(id); return }
  try {
    let result: unknown
    const report = (fraction: number) => progress(id, fraction)
    const aborted = () => stopped.has(id)
    switch (kind) {
      case 'imageWav': result = await imageToWav(payload as ImageDataInput); break
      case 'restoreImage': {
        const image = await wavToImage(payload as Uint8Array)
        result = { image, png: imageToPng(image) }
        break
      }
      case 'music': result = await generateMusic(payload.image, payload.bpm, report, aborted); break
      case 'mp3': result = await lameAdapter.encode(payload as PcmData, report, aborted); break
      case 'quantize': result = await audioChannelsToPcmAsync(payload.channels, payload.sampleRate, report, aborted); break
      case 'waveform': result = waveformPng(payload as PcmData); break
      case 'spectrogram': result = await spectrogramPng(payload as PcmData, report, aborted); break
      case 'pcmPixels': result = await pcmToPixels(payload as PcmData); break
      case 'restorePcm': {
        const pcm = await pixelsToPcm(payload.png, payload.json)
        result = { pcm, wav: writeWav(pcm) }
        break
      }
      default: throw new Error('不明な処理です。')
    }
    if (aborted()) throw new DOMException('処理を中止しました。', 'AbortError')
    self.postMessage({ id, result }, [...resultBuffers(result)])
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) })
  } finally { stopped.delete(id) }
}
