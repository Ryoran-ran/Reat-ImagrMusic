/** Read dimensions from headers before asking the browser to decode large pixels. */
export async function imageDimensions(file: File): Promise<{ width: number; height: number } | null> {
  const bytes = new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer())
  const is = (at: number, text: string) => [...text].every((ch, i) => bytes[at + i] === ch.charCodeAt(0))
  const result = (width: number, height: number) => width > 0 && height > 0 ? { width, height } : null
  if (bytes.length >= 24 && bytes[0] === 137 && is(1, 'PNG') && is(12, 'IHDR')) {
    const view = new DataView(bytes.buffer)
    return result(view.getUint32(16), view.getUint32(20))
  }
  if (bytes.length >= 30 && is(0, 'RIFF') && is(8, 'WEBP')) {
    if (is(12, 'VP8X')) return result(1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16),
      1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16))
    if (is(12, 'VP8 ') && bytes[23] === 0x9d && bytes[24] === 1 && bytes[25] === 0x2a)
      return result((bytes[26] | bytes[27] << 8) & 0x3fff, (bytes[28] | bytes[29] << 8) & 0x3fff)
    if (is(12, 'VP8L') && bytes[20] === 0x2f)
      return result(1 + bytes[21] + ((bytes[22] & 0x3f) << 8),
        1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 15) << 10))
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    for (let at = 2; at + 4 < bytes.length;) {
      if (bytes[at++] !== 0xff) return null
      while (bytes[at] === 0xff) at++
      const marker = bytes[at++]
      if (marker === 0xd9 || marker === 0xda) return null
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue
      const length = (bytes[at] << 8) | bytes[at + 1]
      if (length < 2 || at + length > bytes.length) return null
      const sof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)
      if (sof && length >= 7) return result((bytes[at + 5] << 8) | bytes[at + 6],
        (bytes[at + 3] << 8) | bytes[at + 4])
      at += length
    }
  }
  return null
}
