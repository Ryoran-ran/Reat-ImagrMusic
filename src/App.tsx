import { useEffect, useRef, useState } from 'react'
import { ArrowDownToLine, ArrowLeftRight, AudioLines, Check, ChevronRight, CircleAlert, ClipboardPaste, FileAudio2, FileImage, FlaskConical, Image as ImageIcon, Music2, Pause, Play, RotateCcw, ShieldCheck, Sparkles, Upload, Waves, X } from 'lucide-react'
import { LIMITS, bytesLabel } from './lib/limits'
import { imageDimensions } from './lib/imageInfo'
import { runWorker } from './lib/workerClient'
import { writeWav } from './lib/wav'
import type { ImageDataInput, MediaResult, PcmData, PcmManifest } from './lib/types'

type Tab = 'image' | 'audio' | 'roundtrip'
type ImageSource = ImageDataInput & { name: string; url: string; fileSize: number }
type AudioSource = { pcm: PcmData; name: string; url: string; fileSize: number; duration: number }
type Output = { wav: MediaResult; mp3?: MediaResult; pcm: PcmData; kind: 'raw' | 'music' }
type PictureOutput = { png: MediaResult; json?: MediaResult; mode: 'waveform' | 'spectrogram' | 'pixels'; manifest?: PcmManifest }
type Verification = { valid: boolean; exact?: boolean; dimensions: string; size: number; differences?: number; download: MediaResult; message: string }

const mime = { wav: 'audio/wav', mp3: 'audio/mpeg', png: 'image/png', json: 'application/json' }
const pasteReplaceLabel = 'クリップボードから貼り替え'
const restoredImageAlt = '復元したRGBA画像'
const imageInputHint = `PNG・JPEG・WebP / 最大${LIMITS.maxImagePixels.toLocaleString()}画素、${LIMITS.maxFileBytes / 1024 / 1024} MB`
const audioInputHint = `WAV・MP3 / 最大${LIMITS.maxAudioSeconds / 60}分、入力${LIMITS.maxFileBytes / 1024 / 1024} MB / 展開後PCM${LIMITS.maxPcmBytes / 1024 / 1024} MB`
const wavInputHint = `.wav / 最大${LIMITS.maxFileBytes / 1024 / 1024} MB`
const rawResultLabel = '生データ音声'
const musicResultLabel = '4小節の音楽'
const mp3MakeLabel = 'MP3を生成'
const mp3SaveLabel = 'MP3を保存'
const rawPreviewNote = '生データ音声のプレビューは先頭10秒まで再生します。保存WAVには全サンプルが含まれます。'
function result(bytes: Uint8Array | string, filename: string, type: string): MediaResult {
  const body = typeof bytes === 'string' ? bytes : new Uint8Array(bytes).buffer
  return { blob: new Blob([body], { type }), filename }
}
function save({ blob, filename }: MediaResult) {
  const url = URL.createObjectURL(blob), link = document.createElement('a')
  link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
function checkSize(file: File) {
  if (file.size > LIMITS.maxFileBytes) throw new Error(`入力ファイルは最大${LIMITS.maxFileBytes / 1024 / 1024} MBです。${file.name} は ${bytesLabel(file.size)} です。圧縮するか分割して再試行してください。`)
  if (!file.size) throw new Error('空のファイルです。')
}
function isImage(file: File) { return /\.(png|jpe?g|webp)$/i.test(file.name) }
function isAudio(file: File) { return /\.(wav|mp3)$/i.test(file.name) }
function inspectAudioDuration(file: File): Promise<number | undefined> {
  return new Promise(resolve => {
    const url = URL.createObjectURL(file), media = document.createElement('audio')
    let finished = false
    const done = (duration?: number) => {
      if (finished) return
      finished = true; clearTimeout(timer)
      media.onloadedmetadata = null; media.onerror = null
      media.removeAttribute('src'); URL.revokeObjectURL(url)
      resolve(duration !== undefined && Number.isFinite(duration) ? duration : undefined)
    }
    const timer = window.setTimeout(() => done(), 4000)
    media.preload = 'metadata'
    media.onloadedmetadata = () => done(media.duration)
    media.onerror = () => done()
    media.src = url
  })
}

function DropZone({ label, hint, accept, icon, onFile, onClipboardPaste, onSample, onAltSample, compact = false }: { label: string; hint: string; accept: string; icon: React.ReactNode; onFile: (file: File) => void; onClipboardPaste?: () => void; onSample?: () => void; onAltSample?: () => void; compact?: boolean }) {
  const [dragging, setDragging] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  return <div className={`dropzone ${dragging ? 'dragging' : ''} ${compact ? 'compact' : ''}`}
    onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); setDragging(true) } }}
    onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false) }}>
    <input ref={input} type="file" accept={accept} onChange={event => { const file = event.target.files?.[0]; if (file) onFile(file); event.target.value = '' }} aria-label={label} />
    <div className="drop-icon">{icon}</div><strong>{label}</strong><span>{hint}</span>
    <button type="button" className="button button-outline button-small" onClick={() => input.current?.click()}><Upload size={15}/> ファイルを選択</button>
    {onClipboardPaste && <button type="button" className="button button-outline button-small paste-button" onClick={onClipboardPaste}><ClipboardPaste size={15}/> クリップボードから貼り付け</button>}
    {onClipboardPaste && <span className="paste-hint">Ctrl+V でも貼り付けられます</span>}
    {onSample && <button type="button" className="sample-link" onClick={onSample}>サンプルで試す <ChevronRight size={13}/></button>}
    {onAltSample && <button type="button" className="sample-link" onClick={onAltSample}>MP3サンプルで試す <ChevronRight size={13}/></button>}
  </div>
}
function Download({ item, children, secondary = false }: { item: MediaResult; children: React.ReactNode; secondary?: boolean }) {
  return <button type="button" className={`button ${secondary ? 'button-outline' : 'button-primary'}`} onClick={() => save(item)}><ArrowDownToLine size={17}/>{children}</button>
}
function formatDuration(seconds: number) { return `${seconds.toFixed(1)} 秒` }
function wavVisual(pcm: PcmData): number[] {
  const view = new DataView(pcm.bytes.buffer, pcm.bytes.byteOffset, pcm.bytes.byteLength)
  return Array.from({ length: 96 }, (_, x) => {
    const a = Math.floor(x * pcm.frames / 96), b = Math.max(a + 1, Math.floor((x + 1) * pcm.frames / 96))
    let max = 0
    for (let i = a; i < b; i += Math.max(1, Math.floor((b - a) / 40))) max = Math.max(max, Math.abs(view.getInt16(i * pcm.channels * 2, true)) / 32768)
    return Math.max(3, max * 66)
  })
}

export default function App() {
  const [tab, setTab] = useState<Tab>('image')
  const [image, setImage] = useState<ImageSource | null>(null)
  const [audio, setAudio] = useState<AudioSource | null>(null)
  const [imageMode, setImageMode] = useState<'raw' | 'music'>('raw')
  const [audioMode, setAudioMode] = useState<'waveform' | 'spectrogram' | 'pixels'>('waveform')
  const [bpm, setBpm] = useState(112)
  const [output, setOutput] = useState<Output | null>(null)
  const [picture, setPicture] = useState<PictureOutput | null>(null)
  const [pictureUrl, setPictureUrl] = useState<string | null>(null)
  const [experiment, setExperiment] = useState<'image' | 'pcm'>('image')
  const [roundWav, setRoundWav] = useState<File | null>(null)
  const [roundPng, setRoundPng] = useState<File | null>(null)
  const [roundJson, setRoundJson] = useState<File | null>(null)
  const [verification, setVerification] = useState<Verification | null>(null)
  const [verificationPreviewUrl, setVerificationPreviewUrl] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [working, setWorking] = useState(false)
  const [pageDragging, setPageDragging] = useState(false)
  const [progress, setProgress] = useState(0)
  const [stage, setStage] = useState('')
  const cancelRef = useRef<(() => void) | null>(null)
  const playRef = useRef<{ context: AudioContext; source: AudioBufferSourceNode } | null>(null)
  const [playing, setPlaying] = useState(false)

  useEffect(() => () => { if (image) URL.revokeObjectURL(image.url) }, [image])
  useEffect(() => () => { if (audio) URL.revokeObjectURL(audio.url) }, [audio])
  useEffect(() => () => { if (pictureUrl) URL.revokeObjectURL(pictureUrl) }, [pictureUrl])
  useEffect(() => () => { if (verificationPreviewUrl) URL.revokeObjectURL(verificationPreviewUrl) }, [verificationPreviewUrl])
  useEffect(() => () => { playRef.current?.source.stop(); void playRef.current?.context.close() }, [])

  async function task<T>(kind: string, payload: unknown, from = 0, span = 100, transfer: Transferable[] = []): Promise<T> {
    const operation = runWorker<T>(kind, payload, value => setProgress(Math.round(from + value * span / 100)), transfer)
    cancelRef.current = operation.cancel
    return operation.promise
  }
  async function guarded(action: () => Promise<void>) {
    setError(''); setNotice(''); setWorking(true); setProgress(0)
    try { await action(); setProgress(100) }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setWorking(false); cancelRef.current = null; setStage('') }
  }
  function cancel() { cancelRef.current?.(); setNotice('中止を要求しました。現在の処理区間が終わると停止します。') }
  function showError(reason: unknown) { setError(reason instanceof Error ? reason.message : String(reason)) }

  async function loadImage(file: File) {
    setError(''); setNotice('')
    let cancelled = false
    cancelRef.current = () => { cancelled = true }
    setWorking(true); setStage('画像をデコード中'); setProgress(5)
    try {
      checkSize(file)
      if (!isImage(file)) throw new Error('画像は PNG・JPEG・WebP を選択してください。')
      const dimensions = await imageDimensions(file)
      if (cancelled) throw new DOMException('処理を中止しました。', 'AbortError')
      if (dimensions && dimensions.width * dimensions.height > LIMITS.maxImagePixels)
        throw new Error(`画像は最大${LIMITS.maxImagePixels.toLocaleString()}画素です。この画像は ${(dimensions.width * dimensions.height).toLocaleString()}画素です。元画像を縮小して再試行してください。`)
      let bitmap: ImageBitmap
      try { bitmap = await createImageBitmap(file) } catch { throw new Error('ブラウザが画像をデコードできません。ファイルが破損していないか確認してください。') }
      if (cancelled) { bitmap.close(); throw new DOMException('処理を中止しました。', 'AbortError') }
      if (bitmap.width * bitmap.height > LIMITS.maxImagePixels) { bitmap.close(); throw new Error(`画像は最大${LIMITS.maxImagePixels.toLocaleString()}画素です。この画像は ${(bitmap.width * bitmap.height).toLocaleString()}画素です。元画像を縮小して再試行してください。`) }
      const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height
      const context = canvas.getContext('2d', { willReadFrequently: true })!
      context.drawImage(bitmap, 0, 0); bitmap.close()
      const rgba = new Uint8Array(context.getImageData(0, 0, canvas.width, canvas.height).data)
      setImage({ width: canvas.width, height: canvas.height, rgba, name: file.name, url: URL.createObjectURL(file), fileSize: file.size })
      setOutput(null); setVerification(null); setProgress(100)
    } catch (reason) { showError(reason) }
    finally { setWorking(false); setStage(''); cancelRef.current = null }
  }
  async function loadClipboardImage(blob: Blob, type: string) {
    const extension = type === 'image/png' ? 'png' : type === 'image/jpeg' ? 'jpg' : type === 'image/webp' ? 'webp' : null
    if (!extension) { setError('クリップボードの画像形式に対応していません。PNG・JPEG・WebPを貼り付けてください。'); return }
    await loadImage(new File([blob], `clipboard-${Date.now()}.${extension}`, { type }))
  }
  async function pasteFromClipboard() {
    setError('')
    if (!navigator.clipboard?.read) { setError('このブラウザでは貼り付けボタンを使えません。画像タブで Ctrl+V を押してください。'); return }
    try {
      const items = await navigator.clipboard.read()
      const found = items.flatMap(item => item.types.map(type => ({ item, type })))
        .find(({ type }) => type === 'image/png' || type === 'image/jpeg' || type === 'image/webp')
      if (!found) throw new Error('クリップボードに対応する画像がありません。PNG・JPEG・WebPをコピーしてください。')
      await loadClipboardImage(await found.item.getType(found.type), found.type)
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === 'NotAllowedError')
        setError('クリップボードへのアクセスが許可されませんでした。画像タブで Ctrl+V を押してください。')
      else showError(reason)
    }
  }
  useEffect(() => {
    if (tab !== 'image') return
    const handlePaste = (event: ClipboardEvent) => {
      const target = event.target
      if (target instanceof HTMLElement && (target.isContentEditable || target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLInputElement && !['range', 'file'].includes(target.type)))) return
      if (working) return
      const item = Array.from(event.clipboardData?.items ?? []).find(entry => entry.kind === 'file' && entry.type.startsWith('image/'))
      const file = item?.getAsFile() ?? Array.from(event.clipboardData?.files ?? []).find(entry => entry.type.startsWith('image/'))
      if (!file) { setError('クリップボードに画像がありません。画像をコピーして Ctrl+V を押してください。'); return }
      event.preventDefault()
      void loadClipboardImage(file, item?.type || file.type)
    }
    window.addEventListener('paste', handlePaste)
    return () => window.removeEventListener('paste', handlePaste)
  }, [tab, working])
  async function loadSample(path: string, name: string, type: string, loader: (file: File) => Promise<void>) {
    try {
      const response = await fetch(path)
      if (!response.ok) throw new Error('サンプルを読み込めません。')
      await loader(new File([await response.blob()], name, { type }))
    } catch (reason) { showError(reason) }
  }
  async function loadAudio(file: File) {
    setError(''); setNotice('')
    let cancelled = false
    cancelRef.current = () => { cancelled = true }
    setWorking(true); setStage('音声をデコード中'); setProgress(5)
    try {
      checkSize(file)
      if (!isAudio(file)) throw new Error('音声は WAV・MP3 を選択してください。')
      const durationHint = await inspectAudioDuration(file)
      if (cancelled) throw new DOMException('処理を中止しました。', 'AbortError')
      if (durationHint !== undefined && durationHint > LIMITS.maxAudioSeconds + 0.5)
        throw new Error(`音声は最大${LIMITS.maxAudioSeconds / 60}分です。この音声は約${formatDuration(durationHint)}です。先にトリミングしてください。`)
      const context = new AudioContext()
      let decoded: AudioBuffer
      try { decoded = await context.decodeAudioData(await file.arrayBuffer()) }
      catch { throw new Error('ブラウザが音声をデコードできません。形式またはファイルの破損を確認してください。') }
      finally { void context.close() }
      if (cancelled) throw new DOMException('処理を中止しました。', 'AbortError')
      if (decoded.duration > LIMITS.maxAudioSeconds) throw new Error(`音声は最大${LIMITS.maxAudioSeconds / 60}分です。この音声は ${formatDuration(decoded.duration)} です。先にトリミングしてください。`)
      if (decoded.numberOfChannels < 1 || decoded.numberOfChannels > 2) throw new Error('音声はモノラルまたはステレオにしてください。')
      const pcmBytes = decoded.length * decoded.numberOfChannels * 2
      if (pcmBytes > LIMITS.maxPcmBytes) throw new Error(`展開後のPCMは最大${LIMITS.maxPcmBytes / 1024 / 1024} MBです。この音声は約${bytesLabel(pcmBytes)}になります。短くするかサンプルレートを下げてください。`)
      const channels = Array.from({ length: decoded.numberOfChannels }, (_, i) => new Float32Array(decoded.getChannelData(i)))
      setStage('基準PCMを確定中'); setProgress(10)
      const pcm = await task<PcmData>('quantize', { channels, sampleRate: decoded.sampleRate }, 10, 90,
        channels.map(channel => channel.buffer as ArrayBuffer))
      setAudio({ pcm, name: file.name, url: URL.createObjectURL(file), fileSize: file.size, duration: decoded.duration })
      setPicture(null); setVerification(null); setProgress(100)
    } catch (reason) { showError(reason) }
    finally { setWorking(false); setStage(''); cancelRef.current = null }
  }

  function handleDroppedFiles(files: File[]) {
    setPageDragging(false)
    if (!files.length) return
    if (working) { setError('処理中です。完了または中止後にファイルをドロップしてください。'); return }
    setError(''); setNotice('')
    if (tab === 'image' || tab === 'audio') {
      if (files.length !== 1) { setError('画像または音声は1ファイルずつドロップしてください。'); return }
      if (tab === 'image') void loadImage(files[0])
      else void loadAudio(files[0])
      return
    }
    try {
      if (experiment === 'image') {
        if (files.length !== 1 || !/\.wav$/i.test(files[0].name))
          throw new Error('往復実験の WAV → 画像には、mexp付きWAVを1ファイルだけドロップしてください。')
        checkSize(files[0]); setRoundWav(files[0]); setVerification(null)
        return
      }
      const png = files.filter(file => /\.png$/i.test(file.name))
      const json = files.filter(file => /\.json$/i.test(file.name))
      if (files.length > 2 || files.length !== png.length + json.length || png.length > 1 || json.length > 1)
        throw new Error('PCMの往復実験には、データPNGと対応JSONを各1ファイルまでドロップしてください。')
      files.forEach(checkSize)
      if (png[0]) setRoundPng(png[0])
      if (json[0]) setRoundJson(json[0])
      setVerification(null)
    } catch (reason) { showError(reason) }
  }
  useEffect(() => {
    const hasFiles = (event: DragEvent) => !!event.dataTransfer?.files.length || Array.from(event.dataTransfer?.types ?? []).includes('Files')
    const dragOver = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault(); event.dataTransfer!.dropEffect = 'copy'; setPageDragging(true)
    }
    const dragLeave = (event: DragEvent) => { if (!event.relatedTarget) setPageDragging(false) }
    const drop = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      handleDroppedFiles(Array.from(event.dataTransfer?.files ?? []))
    }
    window.addEventListener('dragover', dragOver)
    window.addEventListener('dragleave', dragLeave)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragover', dragOver)
      window.removeEventListener('dragleave', dragLeave)
      window.removeEventListener('drop', drop)
    }
  }, [tab, experiment, working])

  async function createAudio() {
    if (!image) return
    await guarded(async () => {
      setOutput(null); setStage(imageMode === 'raw' ? 'RGBAをWAVに格納中' : '画像の特徴から音を生成中')
      let pcm: PcmData, wav: Uint8Array
      if (imageMode === 'raw') {
        wav = await task<Uint8Array>('imageWav', { width: image.width, height: image.height, rgba: image.rgba })
        pcm = { sampleRate: LIMITS.sampleRate, channels: 1, frames: image.rgba.length / 2, bytes: image.rgba }
      } else {
        pcm = await task<PcmData>('music', { image, bpm }, 0, 45)
        wav = writeWav(pcm)
      }
      const base = image.name.replace(/\.[^.]+$/, '')
      const wavResult = result(wav, `${base}-${imageMode}.wav`, mime.wav)
      setOutput({ wav: wavResult, pcm, kind: imageMode })
    })
  }
  async function createMp3() {
    if (!output || output.mp3) return
    await guarded(async () => {
      setStage('MP3をエンコード中')
      const mp3 = await task<Uint8Array>('mp3', output.pcm)
      const filename = output.wav.filename.replace(/\.wav$/i, '.mp3')
      setOutput(current => current?.wav === output.wav ? { ...current, mp3: result(mp3, filename, mime.mp3) } : current)
    })
  }
  async function createPicture() {
    if (!audio) return
    await guarded(async () => {
      setPicture(null); setStage(audioMode === 'pixels' ? 'PCMバイトをPNGに格納中' : audioMode === 'waveform' ? '波形を描画中' : 'スペクトログラムを計算中')
      const base = audio.name.replace(/\.[^.]+$/, '')
      if (audioMode === 'pixels') {
        const made = await task<{ png: Uint8Array; manifest: PcmManifest }>('pcmPixels', audio.pcm)
        const png = result(made.png, `${base}-pcm-data.png`, mime.png)
        const json = result(JSON.stringify(made.manifest, null, 2), `${base}-pcm-data.json`, mime.json)
        setPicture({ png, json, manifest: made.manifest, mode: 'pixels' })
        setPictureUrl(URL.createObjectURL(png.blob))
      } else {
        const bytes = await task<Uint8Array>(audioMode, audio.pcm)
        const png = result(bytes, `${base}-${audioMode}.png`, mime.png)
        setPicture({ png, mode: audioMode })
        setPictureUrl(URL.createObjectURL(png.blob))
      }
    })
  }
  async function verify() {
    await guarded(async () => {
      setVerification(null); setStage('生成物を再読み込みして照合中')
      if (experiment === 'image') {
        const file = roundWav
        if (!file && (!output || output.kind !== 'raw')) throw new Error('mexp付きWAVを選択するか、画像 → 音で生データWAVを生成してください。')
        if (file) checkSize(file)
        const source = file ? new Uint8Array(await file.arrayBuffer()) : new Uint8Array(await output!.wav.blob.arrayBuffer())
        const restored = await task<{ image: ImageDataInput; png: Uint8Array }>('restoreImage', source)
        let differences: number | undefined
        if (image) {
          differences = restored.image.width === image.width && restored.image.height === image.height
            ? restored.image.rgba.reduce((count, value, index) => count + Number(value !== image.rgba[index]), 0)
            : Math.max(restored.image.rgba.length, image.rgba.length)
        }
        const exact = differences === undefined ? undefined : differences === 0
        const download = result(restored.png, 'restored-rgba.png', mime.png)
        setVerificationPreviewUrl(URL.createObjectURL(download.blob))
        setVerification({ valid: true, exact, dimensions: `${restored.image.width} × ${restored.image.height} px`, size: restored.image.rgba.length,
          differences, download, message: 'mexpとSHA-256の検証に成功しました。' })
      } else {
        const pngFile = roundPng, jsonFile = roundJson
        if (!!pngFile !== !!jsonFile) throw new Error('データPNGと対応JSONを両方選択してください。')
        if ((!pngFile || !jsonFile) && (!picture || picture.mode !== 'pixels' || !picture.json)) throw new Error('データPNGと対応JSONを選択するか、PCMピクセル画像を生成してください。')
        if (pngFile) checkSize(pngFile)
        if (jsonFile) checkSize(jsonFile)
        const png = pngFile ? new Uint8Array(await pngFile.arrayBuffer()) : new Uint8Array(await picture!.png.blob.arrayBuffer())
        const json = jsonFile ? await jsonFile.text() : await picture!.json!.blob.text()
        const restored = await task<{ pcm: PcmData; wav: Uint8Array }>('restorePcm', { png, json })
        let differences: number | undefined
        if (audio) differences = restored.pcm.bytes.length === audio.pcm.bytes.length && restored.pcm.sampleRate === audio.pcm.sampleRate && restored.pcm.channels === audio.pcm.channels
          ? restored.pcm.bytes.reduce((count, value, index) => count + Number(value !== audio.pcm.bytes[index]), 0)
          : Math.max(restored.pcm.bytes.length, audio.pcm.bytes.length)
        const exact = differences === undefined ? undefined : differences === 0
        const download = result(restored.wav, 'restored-pcm.wav', mime.wav)
        setVerificationPreviewUrl(URL.createObjectURL(download.blob))
        setVerification({ valid: true, exact, dimensions: `${restored.pcm.channels} ch / ${restored.pcm.sampleRate.toLocaleString()} Hz / ${restored.pcm.frames.toLocaleString()} frames`,
          size: restored.pcm.bytes.length, differences, download, message: 'PNGとJSONのSHA-256検証に成功しました。' })
      }
    })
  }
  async function play() {
    if (!output) return
    if (playRef.current) { playRef.current.source.stop(); void playRef.current.context.close(); playRef.current = null; setPlaying(false); return }
    const context = new AudioContext(), { pcm } = output
    const previewFrames = output.kind === 'raw' ? Math.min(pcm.frames, pcm.sampleRate * 10) : pcm.frames
    const buffer = context.createBuffer(pcm.channels, previewFrames, pcm.sampleRate)
    const view = new DataView(pcm.bytes.buffer, pcm.bytes.byteOffset, pcm.bytes.byteLength)
    for (let ch = 0; ch < pcm.channels; ch++) {
      const data = buffer.getChannelData(ch)
      for (let i = 0; i < previewFrames; i++) data[i] = view.getInt16((i * pcm.channels + ch) * 2, true) / 32768
    }
    const source = context.createBufferSource(), gain = context.createGain()
    source.buffer = buffer; source.connect(gain); gain.connect(context.destination)
    const level = output.kind === 'raw' ? 0.10 : 0.8, now = context.currentTime
    gain.gain.setValueAtTime(0, now); gain.gain.linearRampToValueAtTime(level, now + 0.025)
    gain.gain.setValueAtTime(level, now + Math.max(0.025, buffer.duration - 0.04))
    gain.gain.linearRampToValueAtTime(0, now + buffer.duration)
    source.onended = () => { if (playRef.current?.source === source) { playRef.current = null; setPlaying(false); void context.close() } }
    playRef.current = { context, source }; setPlaying(true); source.start()
  }

  return <div className="app-shell">
    <header className="site-header"><div className="brand"><span className="brand-mark"><AudioLines size={25} strokeWidth={2.2}/></span><div><strong>MEDIA LAB</strong><small>画像と音の実験室</small></div></div><div className="header-note"><span className="online-dot"/> ブラウザ内で処理 ・ アップロードなし</div></header>
    <main>
      <section className="hero"><div className="hero-eyebrow"><FlaskConical size={15}/> EXPERIMENT WITH MEDIA <span className="eyebrow-line"/></div><h1>見る音。<br/><em>聴く画像。</em></h1><p>画像と音の境界を越えて、データを変換してみよう。<br/>表現を楽しむ変換から、1バイトずつ確かめる往復実験まで。</p><div className="hero-decoration"><div className="orb orb-one"/><div className="orb orb-two"/><div className="orb orb-three"/><svg viewBox="0 0 450 160" aria-hidden="true"><path d="M0 83 C30 83 35 83 55 83 S75 37 88 83 S105 125 116 83 S133 55 145 83 S165 103 177 83 S194 20 207 83 S225 115 238 83 S255 66 268 83 S289 36 300 83 S319 107 333 83 S350 73 366 83 S393 83 450 83"/></svg></div></section>
      <nav className="tabs" aria-label="変換モード"><button className={tab === 'image' ? 'active' : ''} onClick={() => setTab('image')}><ImageIcon size={18}/> 画像 → 音</button><button className={tab === 'audio' ? 'active' : ''} onClick={() => setTab('audio')}><Waves size={18}/> 音 → 画像</button><button className={tab === 'roundtrip' ? 'active' : ''} onClick={() => setTab('roundtrip')}><ArrowLeftRight size={18}/> 往復実験</button></nav>
      {pageDragging && <div className="drop-overlay" role="status"><Upload size={25}/><strong>ここにファイルをドロップ</strong><span>{tab === 'image' ? 'PNG・JPEG・WebP画像を1つ' : tab === 'audio' ? 'WAV・MP3音声を1つ' : experiment === 'image' ? 'mexp付きWAVを1つ' : 'データPNGと対応JSONを一緒に、または1つずつ'}</span></div>}
      {error && <div className="alert error" role="alert"><CircleAlert size={19}/><span>{error}</span><button aria-label="エラーを閉じる" onClick={() => setError('')}><X size={17}/></button></div>}
      {notice && <div className="alert notice" role="status"><CircleAlert size={19}/><span>{notice}</span></div>}
      {working && <div className="progress-area" role="status" aria-live="polite"><div><span>{stage || '処理中'}</span><strong>{progress}%</strong></div><div className="progress-track"><div style={{ width: `${progress}%` }}/></div><button onClick={cancel}>処理を中止</button></div>}

      {tab === 'image' && <section className="workspace"><div className="section-heading"><div><span className="section-kicker">01 / IMAGE TO AUDIO</span><h2>画像から音をつくる</h2><p>画素をそのまま音にするか、色から音楽を組み立てます。</p></div><span className="section-symbol"><ImageIcon size={28}/></span></div><div className="workspace-grid"><div className="panel"><div className="panel-title"><span className="number">01</span><h3>画像を選ぶ</h3></div>{image ? <div className="source-card"><img src={image.url} alt="読み込んだ画像"/><div><strong>{image.name}</strong><span>{image.width} × {image.height} px ・ {bytesLabel(image.fileSize)}</span><button onClick={() => setImage(null)}><RotateCcw size={14}/> 別の画像を選ぶ</button><button onClick={() => void pasteFromClipboard()}><ClipboardPaste size={14}/>{pasteReplaceLabel}</button></div></div> : <DropZone label="画像をここにドロップ" hint={imageInputHint} accept=".png,.jpg,.jpeg,.webp" icon={<FileImage size={27}/>} onFile={loadImage} onClipboardPaste={() => void pasteFromClipboard()} onSample={() => void loadSample('/samples/rgba-sample.png', 'rgba-sample.png', 'image/png', loadImage)}/>}<div className="panel-title settings-title"><span className="number">02</span><h3>変換方法</h3></div><div className="choice-grid"><button className={`choice ${imageMode === 'raw' ? 'selected' : ''}`} onClick={() => { setImageMode('raw'); setOutput(null) }}><AudioLines size={23}/><strong>生データ音声化</strong><span>RGBAをPCM16として記録</span><small>mexp付きWAVは可逆</small></button><button className={`choice ${imageMode === 'music' ? 'selected' : ''}`} onClick={() => { setImageMode('music'); setOutput(null) }}><Music2 size={23}/><strong>音楽生成</strong><span>色と明るさから4小節を作曲</span><small>表現用・復元不可</small></button></div>{imageMode === 'music' && <div className="tempo"><label htmlFor="tempo">テンポ <strong>{bpm} BPM</strong></label><input id="tempo" type="range" min="60" max="180" value={bpm} onChange={event => { setBpm(Number(event.target.value)); setOutput(null) }}/><div><span>ゆったり 60</span><span>速く 180</span></div></div>}<button className="button button-primary wide run-button" disabled={!image || working} onClick={createAudio}><Sparkles size={18}/> 音を生成する <ChevronRight size={17}/></button></div><div className="panel result-panel"><div className="panel-title"><span className="number">03</span><h3>結果を聴く</h3></div>{output ? <><div className="result-badge"><Check size={15}/> {output.kind === 'raw' ? rawResultLabel : musicResultLabel}</div><div className="audio-art"><div className="bar-visual">{wavVisual(output.pcm).map((height, i) => <i key={i} style={{ height }} />)}</div><div className="audio-art-footer"><span>{formatDuration(output.pcm.frames / output.pcm.sampleRate)}</span><span>44.1 kHz / mono</span></div></div><button className="button button-dark wide" onClick={play}>{playing ? <Pause size={18}/> : <Play size={18}/>} {playing ? '再生を止める' : 'プレビューを再生'}</button>{output.kind === 'raw' && output.pcm.frames > output.pcm.sampleRate * 10 && <p className="preview-limit-note">{rawPreviewNote}</p>}<div className="download-row"><Download item={output.wav}>WAVを保存</Download>{output.mp3 ? <Download item={output.mp3} secondary>{mp3SaveLabel}</Download> : <button className="button button-outline" disabled={working} onClick={createMp3}><Music2 size={17}/>{mp3MakeLabel}</button>}</div><p className="panel-footnote">{output.kind === 'raw' ? '生データ音声は鋭く大きな音になる場合があります。プレビューだけ低音量・短いフェードを適用します。保存WAVのPCM値は変更しません。MP3は非可逆です。' : '音楽から元画像は復元できません。WAVとMP3は同じ生成PCMを元に作ります。'}</p></> : <div className="empty-result"><div className="empty-art"><AudioLines size={48}/></div><strong>音がここに現れます</strong><span>画像と変換方法を選んで実行してください</span></div>}</div></div></section>}

      {tab === 'audio' && <section className="workspace"><div className="section-heading"><div><span className="section-kicker">02 / AUDIO TO IMAGE</span><h2>音を画像として見る</h2><p>音の形を描く、またはPCMデータを画素に格納します。</p></div><span className="section-symbol"><Waves size={28}/></span></div><div className="workspace-grid"><div className="panel"><div className="panel-title"><span className="number">01</span><h3>音声を選ぶ</h3></div>{audio ? <div className="audio-source"><div className="audio-source-top"><FileAudio2 size={29}/><div><strong>{audio.name}</strong><span>{formatDuration(audio.duration)} ・ {audio.pcm.channels} ch ・ {audio.pcm.sampleRate.toLocaleString()} Hz</span></div></div><audio src={audio.url} controls preload="metadata"/><button onClick={() => setAudio(null)}><RotateCcw size={14}/> 別の音声を選ぶ</button></div> : <DropZone label="音声をここにドロップ" hint={audioInputHint} accept=".wav,.mp3,audio/wav,audio/mpeg" icon={<FileAudio2 size={27}/>} onFile={loadAudio} onSample={() => void loadSample('/samples/tone-sample.wav', 'tone-sample.wav', 'audio/wav', loadAudio)} onAltSample={() => void loadSample('/samples/music-check.mp3', 'music-sample.mp3', 'audio/mpeg', loadAudio)}/>}<div className="panel-title settings-title"><span className="number">02</span><h3>画像化の方法</h3></div><div className="stacked-choices"><button className={audioMode === 'waveform' ? 'selected' : ''} onClick={() => { setAudioMode('waveform'); setPicture(null) }}><Waves size={21}/><span><strong>波形</strong><small>音量の変化を一枚の画像に</small></span></button><button className={audioMode === 'spectrogram' ? 'selected' : ''} onClick={() => { setAudioMode('spectrogram'); setPicture(null) }}><AudioLines size={21}/><span><strong>スペクトログラム</strong><small>時間と周波数の分布を可視化</small></span></button><button className={audioMode === 'pixels' ? 'selected' : ''} onClick={() => { setAudioMode('pixels'); setPicture(null) }}><ShieldCheck size={21}/><span><strong>PCMピクセル</strong><small>データPNG＋JSONで可逆に格納</small></span></button></div><button className="button button-primary wide run-button" disabled={!audio || working} onClick={createPicture}><Sparkles size={18}/> 画像を生成する <ChevronRight size={17}/></button></div><div className="panel result-panel"><div className="panel-title"><span className="number">03</span><h3>結果を見る</h3></div>{picture && pictureUrl ? <><div className="result-badge"><Check size={15}/> {picture.mode === 'pixels' ? 'PCMデータ画像' : picture.mode === 'waveform' ? '波形画像' : 'スペクトログラム'}</div><div className={`picture-preview ${picture.mode === 'pixels' ? 'pixel-preview' : ''}`}><img src={pictureUrl} alt={picture.mode === 'pixels' ? 'PCMを格納したデータPNG' : `${picture.mode}の可視化画像`}/></div><div className="download-row"><Download item={picture.png}>PNGを保存</Download>{picture.json && <Download item={picture.json} secondary>JSONを保存</Download>}</div><p className="panel-footnote">{picture.mode === 'pixels' ? '復元にはデータPNGと対応JSONの両方が必要です。画像を編集・色変換すると一致しなくなる場合があります。' : 'この画像は表示用です。元音声への復元操作はありません。'}</p></> : <div className="empty-result"><div className="empty-art"><ImageIcon size={48}/></div><strong>画像がここに現れます</strong><span>音声と画像化の方法を選んで実行してください</span></div>}</div></div></section>}

      {tab === 'roundtrip' && <section className="workspace"><div className="section-heading"><div><span className="section-kicker">03 / ROUND-TRIP TEST</span><h2>元に戻して、確かめる</h2><p>保存した生成物を読み込み直し、ハッシュと基準データを照合します。</p></div><span className="section-symbol"><ArrowLeftRight size={28}/></span></div><div className="experiment-switch"><button className={experiment === 'image' ? 'selected' : ''} onClick={() => { setExperiment('image'); setVerification(null) }}><ImageIcon size={19}/> WAV → 画像</button><button className={experiment === 'pcm' ? 'selected' : ''} onClick={() => { setExperiment('pcm'); setVerification(null) }}><AudioLines size={19}/> PNG + JSON → 音声</button></div><div className="workspace-grid"><div className="panel"><div className="panel-title"><span className="number">01</span><h3>生成物を読み込む</h3></div>{experiment === 'image' ? <><p className="form-intro">mexp付きWAVを選択してください。未選択なら、この画面で生成した生データWAVを使います。</p><DropZone compact label={roundWav?.name || 'mexp付きWAV'} hint={wavInputHint} accept=".wav,audio/wav" icon={<FileAudio2 size={24}/>} onFile={file => handleDroppedFiles([file])}/>{roundWav && <button className="clear-file" onClick={() => setRoundWav(null)}><X size={14}/> 選択を解除</button>}<div className="baseline"><strong>比較基準</strong><span>{image ? `${image.name} の読み込み後RGBA画素列` : '画像未選択：WAV内のハッシュ検証のみ'}</span></div></> : <><p className="form-intro">データPNGと対応JSONを組で選択してください。未選択なら、ここで生成した組を使います。</p><div className="dual-drop"><DropZone compact label={roundPng?.name || 'データPNG'} hint=".png" accept=".png,image/png" icon={<FileImage size={24}/>} onFile={file => handleDroppedFiles([file])}/><DropZone compact label={roundJson?.name || '対応JSON'} hint=".json" accept=".json,application/json" icon={<FileImage size={24}/>} onFile={file => handleDroppedFiles([file])}/></div>{(roundPng || roundJson) && <button className="clear-file" onClick={() => { setRoundPng(null); setRoundJson(null) }}><X size={14}/> 選択を解除</button>}<div className="baseline"><strong>比較基準</strong><span>{audio ? `${audio.name} のデコード後PCM16列` : '音声未選択：PNG/JSONのハッシュ検証のみ'}</span></div></>}<button className="button button-primary wide run-button" disabled={working} onClick={verify}><ShieldCheck size={18}/> 復元して照合する <ChevronRight size={17}/></button></div><div className="panel result-panel"><div className="panel-title"><span className="number">02</span><h3>照合結果</h3></div>{verification ? <div className="verification"><div className={`verification-icon ${verification.exact === false ? 'mismatch' : ''}`}>{verification.exact === false ? <CircleAlert size={31}/> : <Check size={31}/>}</div><h3>{verification.exact === true ? '完全一致しました' : verification.exact === false ? '基準データと差があります' : '生成物の整合性を確認しました'}</h3><p>{verification.message}</p>{verificationPreviewUrl && (experiment === 'image' ? <img className="restored-preview" src={verificationPreviewUrl} alt={restoredImageAlt}/> : <audio className="restored-audio" src={verificationPreviewUrl} controls preload="metadata"/>)}<dl><div><dt>復元データ</dt><dd>{verification.dimensions}</dd></div><div><dt>基準データ長</dt><dd>{verification.size.toLocaleString()} bytes</dd></div><div><dt>差分</dt><dd>{verification.differences === undefined ? '比較基準なし' : `${verification.differences.toLocaleString()} bytes`}</dd></div><div><dt>SHA-256</dt><dd>一致</dd></div></dl><Download item={verification.download}>{experiment === 'image' ? '復元PNGを保存' : '復元WAVを保存'}</Download></div> : <div className="empty-result"><div className="empty-art"><ShieldCheck size={48}/></div><strong>検証結果がここに表示されます</strong><span>生成物を読み込んで照合してください</span></div>}</div></div></section>}
      <section className="info-strip"><div><ShieldCheck size={24}/><strong>可逆の範囲</strong><p>画像は読み込み後のRGBA画素列、音声はデコード後のPCM16列を比較します。元ファイルのバイト列は対象外です。</p></div><div><Sparkles size={24}/><strong>表現の変換</strong><p>音楽・波形・スペクトログラム・MP3は非可逆です。自由な表現として楽しめます。</p></div><div><FlaskConical size={24}/><strong>ローカルで完結</strong><p>処理はブラウザ内で実行します。選んだファイルはサーバーへ送信しません。</p></div></section>
    </main><footer><span>MEDIA LAB <b>·</b> IMAGE × SOUND</span><span>ブラウザの中で、見て、聴いて、確かめる。</span></footer>
  </div>
}
