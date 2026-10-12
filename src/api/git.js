import { backend } from './backend.js'
import { normalizeApiResponse } from './response.js'

export const createGitApi = (transport) => {
  const request = async (operation, payload, options = {}) =>
    normalizeApiResponse(
      await transport.request(
        `git:${operation}`,
        { filesystemId: 'local', ...payload },
        { timeout: 30000, ...options },
      ),
      'EGIT',
      'Unable to inspect this repository',
    )
  return {
    detect: (paths, options) => request('detect', { paths }, options),
    status: (path, options) => request('status', { path }, options),
    branches: (path) => request('branches', { path }),
    log: (path, offset = 0, limit = 50) =>
      request('log', { path, offset, limit }),
    commit: (path, sha) => request('commit', { path, sha }),
    diff: (path, selection) => request('diff', { path, ...selection }),
  }
}
export const git = createGitApi(backend)

// Called once per successful directory load. Rows never perform detection.
export const discoverListedRepositories = async (
  { providerId, path, response, signal },
  api = git,
) => {
  if (providerId !== 'local' || !response?.ok || signal?.aborted)
    return { response, repository: null }
  const candidates = [
    path,
    ...response.entries
      .filter((entry) => entry.isDirectory && !entry.isSymbolicLink)
      .map((entry) => entry.path),
  ]
  const repositories = new Map()
  for (
    let offset = 0;
    offset < candidates.length && !signal?.aborted;
    offset += 256
  ) {
    const result = await api.detect(candidates.slice(offset, offset + 256), {
      signal,
    })
    if (result?.ok)
      for (const repo of result.repositories)
        repositories.set(repo.requestedPath, repo)
  }
  if (signal?.aborted) return { response, repository: null }
  return {
    repository: repositories.get(path) || null,
    response: {
      ...response,
      entries: response.entries.map((entry) => ({
        ...entry,
        gitRepository: repositories.get(entry.path) || null,
      })),
    },
  }
}
