import { backend } from './backend.js'
import { normalizeApiResponse } from './response.js'

const getInfo = async () =>
  normalizeApiResponse(
    await backend.request('runtime:info'),
    'ERUNTIME_INFO',
    'Unable to load runtime information',
  )

export const runtime = Object.freeze({ getInfo })
