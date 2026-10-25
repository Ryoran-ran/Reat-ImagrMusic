export interface ImageDataInput { width: number; height: number; rgba: Uint8Array }
export interface PcmData { sampleRate: number; channels: 1 | 2; frames: number; bytes: Uint8Array }
export interface PcmManifest {
  format: 'mexp-pcm-png'; version: 1; width: number; height: number;
  validBytes: number; sampleRate: number; channels: 1 | 2; frames: number; sha256: string
}
export interface MediaResult { blob: Blob; filename: string }
