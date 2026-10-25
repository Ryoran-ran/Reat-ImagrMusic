import { describe, expect, it } from 'vitest'
import { imageToWav, parseWav, wavToImage, writeWav } from './wav'
import { imageToPng, readPng } from './png'
import { audioChannelsToPcm, audioChannelsToPcmAsync, pcmToPixels, pixelsToPcm, quantize } from './pcm'
import { generateMusic } from './music'
import { spectrogramPng, waveformPng } from './visualize'
import { lameAdapter } from './mp3'
import { imageDimensions } from './imageInfo'
import type { ImageDataInput, PcmData } from './types'

const image: ImageDataInput = { width: 3, height: 2, rgba: Uint8Array.of(
  255, 0, 0, 255, 32, 91, 148, 0, 255, 255, 255, 255,
  0, 0, 0, 0, 1, 2, 3, 4, 254, 253, 252, 251,
) }

describe('RGBA → mexp WAV → RGBA', () => {
  it('accepts images larger than the former one-million-pixel limit', async () => {
    const large: ImageDataInput = { width: 1500, height: 1000, rgba: new Uint8Array(1500 * 1000 * 4) }
    const restored = await wavToImage(await imageToWav(large))
    expect(restored.width * restored.height).toBe(1_500_000)
    await expect(imageToWav({ width: 16_000_001, height: 1, rgba: new Uint8Array() })).rejects.toThrow('寸法')
  })
  it('reads image dimensions before full decoding', async () => {
    expect(await imageDimensions(new File([new Uint8Array(imageToPng(image)).buffer], 'sample.png'))).toEqual({ width: 3, height: 2 })
    const jpeg = Uint8Array.of(0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 100, 0, 200, 1, 1, 0x11, 0, 0xff, 0xd9)
    expect(await imageDimensions(new File([jpeg], 'sample.jpg'))).toEqual({ width: 200, height: 100 })
    const webp = new Uint8Array(30)
    webp.set(new TextEncoder().encode('RIFF'), 0); webp.set(new TextEncoder().encode('WEBPVP8X'), 8)
    webp[24] = 99; webp[27] = 49
    expect(await imageDimensions(new File([webp], 'sample.webp'))).toEqual({ width: 100, height: 50 })
  })
  it('preserves dimensions, SHA-256 and transparent RGB bytes', async () => {
    const wav = await imageToWav(image)
    const parsed = parseWav(wav)
    expect(parsed.imageMeta?.width).toBe(image.width)
    expect(parsed.imageMeta?.height).toBe(image.height)
    expect(parsed.pcm.bytes).toEqual(image.rgba)
    const restored = await wavToImage(wav)
    expect(restored).toEqual(image)
    expect(readPng(imageToPng(restored), 4).pixels).toEqual(image.rgba)
  })
  it('rejects missing metadata, invalid dimensions and any data byte change', async () => {
    const plain = writeWav({ sampleRate: 44100, channels: 1, frames: image.rgba.length / 2, bytes: image.rgba })
    await expect(wavToImage(plain)).rejects.toThrow('mexp')
    const badSize = await imageToWav(image)
    new DataView(badSize.buffer).setUint32(badSize.length - 44, 99, true) // width in mexp
    await expect(wavToImage(badSize)).rejects.toThrow('寸法')
    const modified = await imageToWav(image)
    modified[44 + 3] ^= 1
    await expect(wavToImage(modified)).rejects.toThrow('SHA-256')
  })
})

describe('PCM → RGB PNG + JSON → PCM WAV', () => {
  const pcm: PcmData = { sampleRate: 48000, channels: 2, frames: 4, bytes: Uint8Array.of(
    0, 128, 255, 127, 0, 0, 1, 0, 255, 255, 0, 128, 255, 127, 0, 0,
  ) }
  it('preserves minimum, maximum, silence, mono and stereo samples', async () => {
    for (const source of [pcm, { sampleRate: 44100, channels: 1 as const, frames: 3, bytes: Uint8Array.of(0, 128, 0, 0, 255, 127) }]) {
      const { png, manifest } = await pcmToPixels(source)
      const restored = await pixelsToPcm(png, JSON.stringify(manifest))
      expect(restored).toEqual(source)
      expect(parseWav(writeWav(restored)).pcm.bytes).toEqual(source.bytes)
    }
  })
  it('rejects a changed PNG or mismatched JSON', async () => {
    const { png, manifest } = await pcmToPixels(pcm)
    await expect(pixelsToPcm(png, JSON.stringify({ ...manifest, sha256: '0'.repeat(64) }))).rejects.toThrow('SHA-256')
    const changed = png.slice(); changed[changed.length - 8] ^= 1
    await expect(pixelsToPcm(changed, JSON.stringify(manifest))).rejects.toThrow()
  })
  it('uses a fixed float-to-int16 rule', () => {
    expect([-1, -0.5, 0, 0.5, 1].map(quantize)).toEqual([-32768, -16384, 0, 16384, 32767])
    expect(audioChannelsToPcm([new Float32Array([-1, 0, 1])], 44100).bytes).toEqual(Uint8Array.of(0, 128, 0, 0, 255, 127))
  })
  it('accepts audio longer than 30 seconds within the new limit', async () => {
    const longer = audioChannelsToPcm([new Float32Array(31 * 8000)], 8000)
    expect(longer.frames / longer.sampleRate).toBe(31)
    const { png, manifest } = await pcmToPixels(longer)
    expect(await pixelsToPcm(png, JSON.stringify(manifest))).toEqual(longer)
    expect(() => audioChannelsToPcm([new Float32Array(301)], 1)).toThrow('最大5分')
  })
  it('keeps worker quantization byte-identical and cancellable', async () => {
    const channels = [new Float32Array([-1, -0.5, 0, 0.5, 1]), new Float32Array([1, 0.5, 0, -0.5, -1])]
    expect(await audioChannelsToPcmAsync(channels, 44100)).toEqual(audioChannelsToPcm(channels, 44100))
    await expect(audioChannelsToPcmAsync(channels, 44100, undefined, () => true)).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('expressive outputs', () => {
  it('makes deterministic four-bar PCM within peak limit', async () => {
    const a = await generateMusic(image, 120), b = await generateMusic(image, 120)
    expect(a.bytes).toEqual(b.bytes)
    expect(a.frames / a.sampleRate).toBeCloseTo(8, 3)
    const view = new DataView(a.bytes.buffer)
    let peak = 0
    for (let i = 0; i < a.frames; i++) peak = Math.max(peak, Math.abs(view.getInt16(i * 2, true)))
    expect(peak).toBeLessThanOrEqual(Math.ceil(32768 * 0.85))
  })
  it('creates viewable PNGs for silence and short stereo audio', async () => {
    const silence = audioChannelsToPcm([new Float32Array(32), new Float32Array(32)], 44100)
    expect(readPng(waveformPng(silence), 3).width).toBe(900)
    expect(readPng(await spectrogramPng(silence), 3).height).toBe(360)
  })
  it('encodes MP3 frames from the generated PCM', async () => {
    const data = await lameAdapter.encode(await generateMusic(image, 180))
    expect(data.length).toBeGreaterThan(500)
    expect(data.some((b, i) => b === 0xff && (data[i + 1] & 0xe0) === 0xe0)).toBe(true)
  })
})
