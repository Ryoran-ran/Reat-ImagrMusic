type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; progress?: (value: number) => void }
let nextId = 1
const worker = new Worker(new URL('../worker.ts', import.meta.url), { type: 'module' })
const pending = new Map<number, Pending>()
worker.onmessage = ({ data }) => {
  const task = pending.get(data.id)
  if (!task) return
  if (data.progress !== undefined) { task.progress?.(data.progress); return }
  pending.delete(data.id)
  if (data.error) task.reject(new Error(data.error))
  else task.resolve(data.result)
}
worker.onerror = () => {
  for (const task of pending.values()) task.reject(new Error('処理ワーカーが停止しました。ページを再読み込みしてください。'))
  pending.clear()
}
export function runWorker<T>(kind: string, payload: unknown, progress?: (value: number) => void, transfer: Transferable[] = []): { promise: Promise<T>; cancel: () => void } {
  const id = nextId++
  const promise = new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve, reject, progress })
    worker.postMessage({ id, kind, payload }, transfer)
  })
  return { promise, cancel: () => {
    const task = pending.get(id)
    if (!task) return
    pending.delete(id)
    worker.postMessage({ id, kind: 'cancel' })
    task.reject(new DOMException('処理を中止しました。', 'AbortError'))
  } }
}
