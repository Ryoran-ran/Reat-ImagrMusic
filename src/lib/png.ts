import { unzlibSync, zlibSync } from 'fflate'
import type { ImageDataInput } from './types'
import { LIMITS } from './limits'

const signature = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10)
const typeBytes = (s: string) => Uint8Array.from(s, ch => ch.charCodeAt(0))
const crcTable = new Uint32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  crcTable[n] = c >>> 0
}
const crc = (bytes: Uint8Array) => {
  let c = 0xffffffff
  for (const b of bytes) c = crcTable[(c ^ b) & 255] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}
const chunk = (name: string, data: Uint8Array) => {
  const out = new Uint8Array(data.length + 12), view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  out.set(typeBytes(name), 4); out.set(data, 8)
  view.setUint32(out.length - 4, crc(out.subarray(4, out.length - 4)))
  return out
}

export function writePng(width: number, height: number, pixels: Uint8Array, channels: 3 | 4,
  maxPixels: number = LIMITS.maxImagePixels, compressionLevel: 1 | 6 = 6): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      width * height > maxPixels || pixels.length !== width * height * channels)
    throw new Error('PNG の寸法または画素列が不正です。')
  const row = width * channels, scan = new Uint8Array((row + 1) * height)
  for (let y = 0; y < height; y++) scan.set(pixels.subarray(y * row, (y + 1) * row), y * (row + 1) + 1)
  const ihdr = new Uint8Array(13), view = new DataView(ihdr.buffer)
  view.setUint32(0, width); view.setUint32(4, height)
  ihdr[8] = 8; ihdr[9] = channels === 3 ? 2 : 6
  return concat([signature, chunk('IHDR', ihdr), chunk('IDAT', zlibSync(scan, { level: compressionLevel })), chunk('IEND', new Uint8Array())])
}

export function readPng(bytes: Uint8Array, expectedChannels: 3 | 4, maxPixels: number = LIMITS.maxImagePixels): { width: number; height: number; pixels: Uint8Array } {
  if (bytes.length < 57 || !signature.every((b, i) => bytes[i] === b)) throw new Error('PNG シグネチャが不正です。')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let width = 0, height = 0, channels = 0, seenIhdr = false, seenEnd = false
  const idat: Uint8Array[] = []
  for (let at = 8; at < bytes.length;) {
    if (at + 12 > bytes.length) throw new Error('PNG チャンクが途中で切れています。')
    const length = view.getUint32(at), end = at + 12 + length
    if (end > bytes.length) throw new Error('PNG チャンクの長さが不正です。')
    if (crc(bytes.subarray(at + 4, end - 4)) !== view.getUint32(end - 4)) throw new Error('PNG の CRC が一致しません。')
    const kind = String.fromCharCode(...bytes.subarray(at + 4, at + 8)), payload = bytes.subarray(at + 8, end - 4)
    if (kind === 'IHDR') {
      if (seenIhdr || at !== 8 || length !== 13) throw new Error('PNG の IHDR が不正です。')
      seenIhdr = true; width = view.getUint32(at + 8); height = view.getUint32(at + 12)
      channels = payload[9] === 2 ? 3 : payload[9] === 6 ? 4 : 0
      if (payload[8] !== 8 || channels !== expectedChannels || payload[10] || payload[11] || payload[12] ||
          !width || !height || width * height > maxPixels)
        throw new Error(`対応する PNG は8-bit RGB/RGBA、最大${maxPixels.toLocaleString()}画素です。`)
    } else if (kind === 'IDAT') idat.push(payload)
    else if (kind === 'IEND') { if (length) throw new Error('PNG の IEND が不正です。'); seenEnd = true; if (end !== bytes.length) throw new Error('PNG 末尾に余分なデータがあります。') }
    else if ((bytes[at + 4] & 32) === 0) throw new Error(`未対応の PNG 必須チャンク: ${kind}`)
    at = end
  }
  if (!seenIhdr || !seenEnd || !idat.length) throw new Error('PNG の必須チャンクがありません。')
  const row = width * channels
  let scan: Uint8Array
  try { scan = unzlibSync(concat(idat), { out: new Uint8Array(height * (row + 1)) }) } catch { throw new Error('PNG の圧縮データを展開できません。') }
  if (scan.length !== height * (row + 1)) throw new Error('PNG の画素データ長が不正です。')
  const pixels = new Uint8Array(height * row)
  for (let y = 0; y < height; y++) {
    const filter = scan[y * (row + 1)], source = y * (row + 1) + 1, target = y * row
    if (filter > 4) throw new Error('PNG のフィルターが不正です。')
    for (let x = 0; x < row; x++) {
      const left = x >= channels ? pixels[target + x - channels] : 0
      const above = y ? pixels[target + x - row] : 0
      const upperLeft = y && x >= channels ? pixels[target + x - row - channels] : 0
      let predictor = 0
      if (filter === 1) predictor = left
      if (filter === 2) predictor = above
      if (filter === 3) predictor = Math.floor((left + above) / 2)
      if (filter === 4) {
        const p = left + above - upperLeft, a = Math.abs(p - left), b = Math.abs(p - above), c = Math.abs(p - upperLeft)
        predictor = a <= b && a <= c ? left : b <= c ? above : upperLeft
      }
      pixels[target + x] = (scan[source + x] + predictor) & 255
    }
  }
  return { width, height, pixels }
}

export const imageToPng = ({ width, height, rgba }: ImageDataInput) => writePng(width, height, rgba, 4)
