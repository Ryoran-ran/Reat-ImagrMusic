import type { PcmData } from './types'
import { writePng } from './png'

const W = 900, H = 360
const background = [13, 27, 35], aqua = [75, 203, 192]
function canvas(): Uint8Array {
  const pixels = new Uint8Array(W * H * 3)
  for (let i = 0; i < pixels.length; i += 3) pixels.set(background, i)
  return pixels
}
function set(pixels: Uint8Array, x: number, y: number, color: number[]) {
  if (x < 0 || x >= W || y < 0 || y >= H) return
  pixels.set(color, (y * W + x) * 3)
}
function mono(pcm: PcmData): Float32Array {
  const view = new DataView(pcm.bytes.buffer, pcm.bytes.byteOffset, pcm.bytes.byteLength)
  const samples = new Float32Array(pcm.frames)
  for (let frame = 0; frame < pcm.frames; frame++) {
    let sum = 0
    for (let ch = 0; ch < pcm.channels; ch++) sum += view.getInt16((frame * pcm.channels + ch) * 2, true) / 32768
    samples[frame] = sum / pcm.channels
  }
  return samples
}

export function waveformPng(pcm: PcmData): Uint8Array {
  const samples = mono(pcm), pixels = canvas(), middle = Math.floor(H / 2)
  for (let x = 0; x < W; x++) {
    const start = Math.floor(x * samples.length / W), end = Math.max(start + 1, Math.floor((x + 1) * samples.length / W))
    let lo = 1, hi = -1
    for (let i = start; i < Math.min(end, samples.length); i++) { lo = Math.min(lo, samples[i]); hi = Math.max(hi, samples[i]) }
    set(pixels, x, middle, [40, 78, 86])
    const top = Math.max(0, Math.floor(middle - hi * (H * 0.42)))
    const bottom = Math.min(H - 1, Math.ceil(middle - lo * (H * 0.42)))
    for (let y = top; y <= bottom; y++) set(pixels, x, y, aqua)
  }
  return writePng(W, H, pixels, 3)
}

function fft(re: Float32Array, im: Float32Array) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]] }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = -2 * Math.PI / len, wr = Math.cos(angle), wi = Math.sin(angle)
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0
      for (let j = 0; j < len / 2; j++) {
        const p = i + j, q = p + len / 2, tr = re[q] * cr - im[q] * ci, ti = re[q] * ci + im[q] * cr
        re[q] = re[p] - tr; im[q] = im[p] - ti; re[p] += tr; im[p] += ti
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr
      }
    }
  }
}

export async function spectrogramPng(pcm: PcmData, progress?: (fraction: number) => void, aborted?: () => boolean): Promise<Uint8Array> {
  const samples = mono(pcm), pixels = canvas(), n = 1024, re = new Float32Array(n), im = new Float32Array(n)
  for (let x = 0; x < W; x++) {
    if (aborted?.()) throw new DOMException('処理を中止しました。', 'AbortError')
    const center = Math.floor(x * samples.length / W)
    re.fill(0); im.fill(0)
    for (let i = 0; i < n; i++) {
      const at = center + i - n / 2
      re[i] = (at >= 0 && at < samples.length ? samples[at] : 0) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)))
    }
    fft(re, im)
    for (let y = 0; y < H; y++) {
      const hz = 60 * Math.pow(Math.min(20000, pcm.sampleRate / 2) / 60, (H - 1 - y) / (H - 1))
      const bin = Math.min(n / 2 - 1, Math.round(hz * n / pcm.sampleRate))
      const magnitude = Math.hypot(re[bin], im[bin]) / (n / 4)
      const intensity = Math.max(0, Math.min(1, (20 * Math.log10(magnitude + 1e-8) + 80) / 75))
      const color = intensity < 0.5
        ? [13 + 50 * intensity, 27 + 260 * intensity, 35 + 264 * intensity]
        : [38 + 420 * (intensity - 0.5), 157 + 150 * (intensity - 0.5), 167 - 184 * (intensity - 0.5)]
      set(pixels, x, y, color)
    }
    if (x % 30 === 0) { progress?.(x / W); await new Promise(resolve => setTimeout(resolve, 0)) }
  }
  progress?.(1)
  return writePng(W, H, pixels, 3)
}
