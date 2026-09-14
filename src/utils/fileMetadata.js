const sizeUnits = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']

const integerFormatter = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 0,
})

const decimalFormatter = new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
})

const twoDigits = (value) => String(value).padStart(2, '0')
const localizedDateFormatters = new Map()

const getLocalizedDateFormatter = (locale) => {
  if (!localizedDateFormatters.has(locale)) {
    localizedDateFormatters.set(
      locale,
      new Intl.DateTimeFormat(locale, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }),
    )
  }

  return localizedDateFormatters.get(locale)
}

const formatDateTime = (date, locale = '') =>
  locale
    ? getLocalizedDateFormatter(locale).format(date)
    : `${twoDigits(date.getDate())}.${twoDigits(date.getMonth() + 1)}.${date.getFullYear()} ${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`

export const formatFileSize = (bytes, isDirectory = false) => {
  if (isDirectory || !Number.isFinite(bytes) || bytes < 0) {
    return '—'
  }

  if (bytes < 1000) {
    return `${integerFormatter.format(bytes)} B`
  }

  const unitIndex = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1000)),
    sizeUnits.length - 1,
  )
  const value = bytes / 1000 ** unitIndex
  const formatter = value < 10 ? decimalFormatter : integerFormatter

  return `${formatter.format(value)} ${sizeUnits[unitIndex]}`
}

export const formatModifiedAt = (value, locale = '') => {
  if (!value) {
    return '—'
  }

  const date = new Date(value)

  return Number.isNaN(date.getTime()) ? '—' : formatDateTime(date, locale)
}

export const formatModifiedAtTitle = (value, locale = '') => {
  if (!value) {
    return ''
  }

  const date = new Date(value)

  return Number.isNaN(date.getTime()) ? '' : formatDateTime(date, locale)
}
