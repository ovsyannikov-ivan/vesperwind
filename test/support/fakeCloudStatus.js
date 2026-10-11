// Stands in for src/api/cloudStatus.js in component tests: the real inspector
// (batching, limiter, cancellation) over a backend the test answers by hand.
import { createCloudStatusInspector } from '../../src/api/cloudStatus.js'

export const cloudBackend = { enabled: false, sent: [], cancelled: [], other: [] }

export const resetCloudBackend = (enabled = false) => {
  Object.assign(cloudBackend, { enabled, sent: [], cancelled: [], other: [] })
}

export const answerBatch = (index, statusFor = () => ({ contentAvailability: { state: 'cloud' } })) => {
  const batch = cloudBackend.sent[index]
  batch.reply({ ok: true, statuses: batch.paths.map((path) => ({ path, ...statusFor(path) })) })
}

let requestId = 0
export const cloudStatus = createCloudStatusInspector({
  supported: async () => cloudBackend.enabled,
  pause: () => Promise.resolve(),
  newId: () => `r${++requestId}`,
  request: (event, payload) => {
    if (event === 'filesystem:cloud-status-cancel') {
      cloudBackend.cancelled.push(payload.requestId)
      return Promise.resolve({ ok: true })
    }
    if (event !== 'filesystem:cloud-status') {
      cloudBackend.other.push(event)
      return Promise.resolve({ ok: false })
    }
    return new Promise((reply) => cloudBackend.sent.push({ ...payload, reply }))
  },
})
