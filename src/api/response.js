export const normalizeApiResponse = (
  response,
  fallbackCode,
  fallbackMessage,
) => {
  if (response?.ok === true) {
    return response
  }

  return {
    ...response,
    ok: false,
    error: {
      ...response?.error,
      code: response?.error?.code || fallbackCode,
      message: response?.error?.message || fallbackMessage,
    },
  }
}
