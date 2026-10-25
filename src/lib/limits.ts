export const LIMITS = {
  maxFileBytes: 100 * 1024 * 1024,
  maxImagePixels: 16_000_000,
  maxDataPngPixels: 24_000_000,
  maxAudioSeconds: 300,
  maxPcmBytes: 64 * 1024 * 1024,
  sampleRate: 44_100,
  maxPcmChannels: 2,
} as const

export const bytesLabel = (value: number) => value >= 1024 * 1024
  ? `${(value / 1024 / 1024).toFixed(2)} MB`
  : `${(value / 1024).toFixed(1)} KB`
