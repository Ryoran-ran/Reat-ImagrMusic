import { sha256 } from './hash'
import { readPng, writePng } from './png'
import { LIMITS } from './limits'
import type { PcmData, PcmManifest } from './types'
import { writeWav } from './wav'

// Values are clamped to [-1, 1], then scaled separately so -1 maps to -32768
// and +1 maps to +32767. Math.round resolves half steps toward +Infinity.
export function quantize(value: number): number {
  if (!Number.isFinite(value)) return 0
  const clamped = Math.max(-1, Math.min(1, value))
  return Math.round(clamped * (clamped < 0 ? 32768 : 32767))
}

function validateAudioChannels(channels: Float32Array[], sampleRate: number): number {
  if (!Number.isInteger(sampleRate) || sampleRate < 1 || channels.length < 1 || channels.length > 2 || !channels[0].length ||
      channels.some(c => c.length !== channels[0].length) ||
      channels[0].length / sampleRate > LIMITS.maxAudioSeconds)
    throw new Error(`音声は1〜2チャンネル、最大${LIMITS.maxAudioSeconds / 60}分です。`)
  const frames = channels[0].length
  if (frames * channels.length * 2 > LIMITS.maxPcmBytes)
    throw new Error(`展開後のPCMが${LIMITS.maxPcmBytes / 1024 / 1024} MBを超えます。音声を短くするか、サンプルレートを下げてください。`)
  return frames
}

export function audioChannelsToPcm(channels: Float32Array[], sampleRate: number): PcmData {
  const frames = validateAudioChannels(channels, sampleRate)
  const bytes = new Uint8Array(frames * channels.length * 2)
  const view = new DataView(bytes.buffer)
  for (let frame = 0; frame < frames; frame++)
    for (let channel = 0; channel < channels.length; channel++)
      view.setInt16((frame * channels.length + channel) * 2, quantize(channels[channel][frame]), true)
  return { sampleRate, channels: channels.length as 1 | 2, frames, bytes }
}

export async function audioChannelsToPcmAsync(channels: Float32Array[], sampleRate: number,
  progress?: (fraction: number) => void, aborted?: () => boolean): Promise<PcmData> {
  const frames = validateAudioChannels(channels, sampleRate)
  const bytes = new Uint8Array(frames * channels.length * 2), view = new DataView(bytes.buffer)
  for (let frame = 0; frame < frames; frame++) {
    if (frame % 65536 === 0) {
      if (aborted?.()) throw new DOMException('処理を中止しました。', 'AbortError')
      if (frame) { progress?.(frame / frames); await new Promise(resolve => setTimeout(resolve, 0)) }
    }
    for (let channel = 0; channel < channels.length; channel++)
      view.setInt16((frame * channels.length + channel) * 2, quantize(channels[channel][frame]), true)
  }
  progress?.(1)
  return { sampleRate, channels: channels.length as 1 | 2, frames, bytes }
}

export async function pcmToPixels(pcm: PcmData): Promise<{ png: Uint8Array; manifest: PcmManifest }> {
  if (pcm.channels < 1 || pcm.channels > 2 || pcm.frames < 1 || pcm.bytes.length !== pcm.frames * pcm.channels * 2)
    throw new Error('PCM の形式が不正です。')
  if (pcm.bytes.length > LIMITS.maxPcmBytes) throw new Error(`PCMは最大${LIMITS.maxPcmBytes / 1024 / 1024} MBです。`)
  const pixelCount = Math.ceil(pcm.bytes.length / 3)
  const width = Math.min(1024, Math.max(1, Math.ceil(Math.sqrt(pixelCount))))
  const height = Math.ceil(pixelCount / width)
  if (width * height > LIMITS.maxDataPngPixels) throw new Error(`データPNGが${LIMITS.maxDataPngPixels.toLocaleString()}画素の上限を超えます。音声を短くするかサンプルレートを下げてください。`)
  const rgb = new Uint8Array(width * height * 3)
  rgb.set(pcm.bytes)
  return {
    png: writePng(width, height, rgb, 3, LIMITS.maxDataPngPixels, 1),
    manifest: { format: 'mexp-pcm-png', version: 1, width, height, validBytes: pcm.bytes.length,
      sampleRate: pcm.sampleRate, channels: pcm.channels, frames: pcm.frames, sha256: await sha256(pcm.bytes) },
  }
}

export async function pixelsToPcm(png: Uint8Array, json: string): Promise<PcmData> {
  let manifest: PcmManifest
  try { manifest = JSON.parse(json) } catch { throw new Error('対応JSONを読み取れません。') }
  if (manifest.format !== 'mexp-pcm-png' || manifest.version !== 1 ||
      !Number.isInteger(manifest.width) || !Number.isInteger(manifest.height) ||
      !Number.isInteger(manifest.validBytes) || !Number.isInteger(manifest.sampleRate) ||
      !Number.isInteger(manifest.frames) || (manifest.channels !== 1 && manifest.channels !== 2) ||
      manifest.width < 1 || manifest.height < 1 || manifest.width * manifest.height > LIMITS.maxDataPngPixels ||
      manifest.sampleRate < 1 || manifest.frames < 1 ||
      manifest.frames / manifest.sampleRate > LIMITS.maxAudioSeconds ||
      manifest.validBytes !== manifest.frames * manifest.channels * 2 ||
      manifest.validBytes > LIMITS.maxPcmBytes ||
      manifest.validBytes > manifest.width * manifest.height * 3 ||
      !/^[0-9a-f]{64}$/.test(manifest.sha256)) throw new Error('対応JSONの形式・寸法が不正です。')
  const decoded = readPng(png, 3, LIMITS.maxDataPngPixels)
  if (decoded.width !== manifest.width || decoded.height !== manifest.height)
    throw new Error('データPNGとJSONの寸法が一致しません。')
  if (decoded.pixels.subarray(manifest.validBytes).some(value => value !== 0))
    throw new Error('データPNGの余り領域が変更されています。')
  const bytes = decoded.pixels.slice(0, manifest.validBytes)
  if (await sha256(bytes) !== manifest.sha256) throw new Error('SHA-256 が一致しません。PNGとJSONの組み合わせを確認してください。')
  return { sampleRate: manifest.sampleRate, channels: manifest.channels, frames: manifest.frames, bytes }
}

export async function pixelsToWav(png: Uint8Array, json: string): Promise<Uint8Array> {
  return writeWav(await pixelsToPcm(png, json))
}
