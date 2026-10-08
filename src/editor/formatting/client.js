let worker
let sequence = 0
const pending = new Map()
export const formatInWorker = async (request) => {
  if (!worker) {
    worker = new Worker(new URL('./formatter.worker.js', import.meta.url), { type: 'module' })
    worker.onmessage = ({ data }) => {
      const task = pending.get(data.id)
      if (!task) return
      pending.delete(data.id)
      data.error ? task.reject(Object.assign(new Error(data.error.message), data.error)) : task.resolve(data.result)
    }
    worker.onerror = () => {
      for (const task of pending.values()) task.reject(Object.assign(new Error('Formatting failed: formatter worker could not start'), { code: 'EFORMAT' }))
      pending.clear(); worker?.terminate(); worker = null
    }
  }
  return new Promise((resolve, reject) => {
    const id = ++sequence
    pending.set(id, { resolve, reject })
    worker.postMessage({ id, request })
  })
}
