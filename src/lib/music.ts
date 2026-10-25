import type { ImageDataInput, PcmData } from './types'
import { LIMITS } from './limits'

const scale = [0, 2, 4, 5, 7, 9, 11, 12]
type Cell = { brightness: number; saturation: number; contrast: number }

async function features(image: ImageDataInput, progress?: (fraction: number) => void, aborted?: () => boolean): Promise<{ cells: Cell[][]; key: number }> {
  const cells: Cell[][] = [], { width, height, rgba } = image
  let hueX = 0, hueY = 0, hueWeight = 0
  for (let col = 0; col < 64; col++) {
    if (aborted?.()) throw new DOMException('処理を中止しました。', 'AbortError')
    const column: Cell[] = []
    for (let row = 0; row < 8; row++) {
      const x0 = Math.min(width - 1, Math.floor(col * width / 64))
      const x1 = Math.min(width, Math.max(x0 + 1, Math.floor((col + 1) * width / 64)))
      const y0 = Math.min(height - 1, Math.floor(row * height / 8))
      const y1 = Math.min(height, Math.max(y0 + 1, Math.floor((row + 1) * height / 8)))
      let sum = 0, square = 0, saturation = 0, count = 0
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const i = (y * width + x) * 4
        const r = rgba[i] / 255, g = rgba[i + 1] / 255, b = rgba[i + 2] / 255
        const light = 0.2126 * r + 0.7152 * g + 0.0722 * b
        const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min
        sum += light; square += light * light; saturation += max ? delta / max : 0; count++
        if (delta > 0.025) {
          let hue = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4
          if (hue < 0) hue += 6
          const angle = hue * Math.PI / 3
          hueX += Math.cos(angle) * delta; hueY += Math.sin(angle) * delta; hueWeight += delta
        }
      }
      const brightness = sum / count
      column.push({ brightness, saturation: saturation / count, contrast: Math.sqrt(Math.max(0, square / count - brightness * brightness)) })
    }
    cells.push(column)
    if (col % 4 === 3) { progress?.((col + 1) / 128); await new Promise(resolve => setTimeout(resolve, 0)) }
  }
  const angle = Math.atan2(hueY, hueX)
  const key = hueWeight / (64 * 8) < 0.02 ? 0 : Math.round((((angle + 2 * Math.PI) % (2 * Math.PI)) / (2 * Math.PI)) * 12) % 12
  return { cells, key }
}

export async function generateMusic(image: ImageDataInput, bpm: number, progress?: (fraction: number) => void, aborted?: () => boolean): Promise<PcmData> {
  if (!Number.isFinite(bpm) || bpm < 60 || bpm > 180) throw new Error('テンポは60〜180 BPMです。')
  const { cells, key } = await features(image, progress, aborted), sampleRate = LIMITS.sampleRate
  const stepSeconds = 15 / bpm, frames = Math.ceil(64 * stepSeconds * sampleRate)
  const samples = new Float32Array(frames)
  for (let col = 0; col < 64; col++) {
    if (aborted?.()) throw new DOMException('処理を中止しました。', 'AbortError')
    const chosen = cells[col].map((cell, row) => ({ ...cell, row, score: cell.brightness * 0.55 + cell.saturation * 0.3 + cell.contrast * 0.15 }))
      .sort((a, b) => b.score - a.score || a.row - b.row).slice(0, 2)
    for (const cell of chosen) {
      const midi = 48 + key + scale[7 - cell.row]
      const freq = 440 * Math.pow(2, (midi - 69) / 12)
      const onset = Math.round(col * stepSeconds * sampleRate)
      const noteFrames = Math.min(Math.round(stepSeconds * 0.88 * sampleRate), frames - onset)
      const amp = (0.08 + cell.brightness * 0.22) / chosen.length
      const bright = cell.saturation * 0.38
      for (let i = 0; i < noteFrames; i++) {
        const t = i / sampleRate, phase = 2 * Math.PI * freq * t
        const envelope = Math.min(1, i / (sampleRate * 0.009), (noteFrames - i) / (sampleRate * 0.035))
        samples[onset + i] += amp * envelope * (Math.sin(phase) * (1 - bright) + Math.sin(2 * phase) * bright * 0.7)
      }
    }
    if (col % 4 === 0) { progress?.(0.5 + (col + 1) / 128); await new Promise(resolve => setTimeout(resolve, 0)) }
  }
  let peak = 0
  for (const value of samples) peak = Math.max(peak, Math.abs(value))
  const gain = peak > 0.85 ? 0.85 / peak : 1
  const bytes = new Uint8Array(frames * 2), view = new DataView(bytes.buffer)
  for (let i = 0; i < frames; i++) {
    const value = Math.max(-1, Math.min(1, samples[i] * gain))
    view.setInt16(i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true)
  }
  progress?.(1)
  return { sampleRate, channels: 1, frames, bytes }
}
