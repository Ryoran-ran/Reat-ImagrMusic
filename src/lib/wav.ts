import { hexToBytes, sha256 } from './hash'
import type { ImageDataInput, PcmData } from './types'
import { LIMITS } from './limits'

const ascii = (view: DataView, offset: number, text: string) => {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
}
const readAscii = (view: DataView, offset: number, count: number) =>
  String.fromCharCode(...new Uint8Array(view.buffer, view.byteOffset + offset, count))
const even = (n: number) => n + (n & 1)

export function writeWav(pcm: PcmData, imageMeta?: { width: number; height: number; sha256: string }): Uint8Array {
  if (![1, 2].includes(pcm.channels) || !Number.isInteger(pcm.sampleRate) || pcm.sampleRate <= 0 ||
      pcm.bytes.length !== pcm.frames * pcm.channels * 2 || pcm.bytes.length > 0xffffffff - 128)
    throw new Error('PCM の長さまたは形式が不正です。')
  const extra = imageMeta ? 8 + 48 : 0
  const size = 12 + 24 + 8 + even(pcm.bytes.length) + extra
  const out = new Uint8Array(size)
  const view = new DataView(out.buffer)
  ascii(view, 0, 'RIFF'); view.setUint32(4, size - 8, true); ascii(view, 8, 'WAVE')
  ascii(view, 12, 'fmt '); view.setUint32(16, 16, true)
  view.setUint16(20, 1, true); view.setUint16(22, pcm.channels, true)
  view.setUint32(24, pcm.sampleRate, true)
  view.setUint32(28, pcm.sampleRate * pcm.channels * 2, true)
  view.setUint16(32, pcm.channels * 2, true); view.setUint16(34, 16, true)
  ascii(view, 36, 'data'); view.setUint32(40, pcm.bytes.length, true)
  out.set(pcm.bytes, 44)
  if (imageMeta) {
    const at = 44 + even(pcm.bytes.length)
    ascii(view, at, 'mexp'); view.setUint32(at + 4, 48, true)
    view.setUint32(at + 8, 1, true)
    view.setUint32(at + 12, imageMeta.width, true)
    view.setUint32(at + 16, imageMeta.height, true)
    view.setUint32(at + 20, pcm.bytes.length, true)
    out.set(hexToBytes(imageMeta.sha256), at + 24)
  }
  return out
}

export interface ParsedWav { pcm: PcmData; imageMeta?: { width: number; height: number; byteLength: number; sha256: string } }
export function parseWav(bytes: Uint8Array): ParsedWav {
  if (bytes.length < 44) throw new Error('WAV が短すぎます。')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (readAscii(view, 0, 4) !== 'RIFF' || readAscii(view, 8, 4) !== 'WAVE' || view.getUint32(4, true) + 8 !== bytes.length)
    throw new Error('RIFF/WAVE の構造が不正です。')
  let fmt: { channels: 1 | 2; sampleRate: number } | undefined
  let data: Uint8Array | undefined
  let imageMeta: ParsedWav['imageMeta']
  for (let at = 12; at < bytes.length;) {
    if (at + 8 > bytes.length) throw new Error('WAV チャンクが途中で切れています。')
    const id = readAscii(view, at, 4), length = view.getUint32(at + 4, true)
    const start = at + 8, end = start + length
    if (end > bytes.length || end + (length & 1) > bytes.length) throw new Error('WAV チャンクの長さが不正です。')
    if (id === 'fmt ') {
      if (fmt || length < 16 || view.getUint16(start, true) !== 1 || view.getUint16(start + 14, true) !== 16)
        throw new Error('PCM16 WAV の fmt チャンクが必要です。')
      const channels = view.getUint16(start + 2, true), sampleRate = view.getUint32(start + 4, true)
      if ((channels !== 1 && channels !== 2) || sampleRate === 0 ||
          view.getUint16(start + 12, true) !== channels * 2 ||
          view.getUint32(start + 8, true) !== sampleRate * channels * 2)
        throw new Error('WAV のチャンネル数またはサンプルレートが不正です。')
      fmt = { channels, sampleRate }
    } else if (id === 'data') {
      if (data) throw new Error('data チャンクが重複しています。')
      data = bytes.slice(start, end)
    } else if (id === 'mexp') {
      if (imageMeta || length !== 48 || view.getUint32(start, true) !== 1)
        throw new Error('mexp チャンクの形式が不正です。')
      imageMeta = {
        width: view.getUint32(start + 4, true), height: view.getUint32(start + 8, true),
        byteLength: view.getUint32(start + 12, true),
        sha256: Array.from(bytes.slice(start + 16, start + 48), b => b.toString(16).padStart(2, '0')).join(''),
      }
    }
    at = end + (length & 1)
  }
  if (!fmt || !data || data.length % (fmt.channels * 2)) throw new Error('WAV の PCM データが不正です。')
  return { pcm: { ...fmt, frames: data.length / (fmt.channels * 2), bytes: data }, imageMeta }
}

export async function imageToWav(input: ImageDataInput): Promise<Uint8Array> {
  if (input.width <= 0 || input.height <= 0 || input.width * input.height > LIMITS.maxImagePixels ||
      input.rgba.length !== input.width * input.height * 4) throw new Error('画像の寸法またはRGBA列が不正です。')
  return writeWav({ sampleRate: LIMITS.sampleRate, channels: 1, frames: input.rgba.length / 2, bytes: input.rgba },
    { width: input.width, height: input.height, sha256: await sha256(input.rgba) })
}

export async function wavToImage(bytes: Uint8Array): Promise<ImageDataInput> {
  const { pcm, imageMeta } = parseWav(bytes)
  if (!imageMeta) throw new Error('専用 mexp チャンクがありません。')
  const { width, height, byteLength } = imageMeta
  if (pcm.channels !== 1 || pcm.sampleRate !== LIMITS.sampleRate || !width || !height ||
      width * height > LIMITS.maxImagePixels || width * height * 4 !== byteLength || byteLength !== pcm.bytes.length)
    throw new Error('mexp の寸法・長さと PCM が一致しません。')
  if (await sha256(pcm.bytes) !== imageMeta.sha256) throw new Error('SHA-256 が一致しません。WAV が変更されています。')
  return { width, height, rgba: pcm.bytes }
}
