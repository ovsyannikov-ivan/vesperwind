const present = (value) => value !== null && value !== undefined && value !== ''

const join = (values) => values.filter(present).join(' · ')

export const formatMediaDuration = (seconds) => {
  const value = Math.max(0, Number(seconds) || 0)
  const hours = Math.floor(value / 3600)
  const minutes = Math.floor((value % 3600) / 60)
  const remainder = Math.floor(value % 60)
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${minutes}:${String(remainder).padStart(2, '0')}`
}

export const formatMediaBytes = (bytes) => {
  const value = Number(bytes) || 0
  if (!value) return 'Unknown'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1)
  return `${(value / (1024 ** index)).toFixed(index > 2 ? 2 : 1)} ${units[index]}`
}

export const formatMediaBitrate = (bitsPerSecond) => {
  const value = Number(bitsPerSecond) || 0
  if (!value) return ''
  return value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(2)} Mbps`
    : `${Math.round(value / 1000)} kbps`
}

const formatFrameRate = (value) => {
  const rate = Number(value) || 0
  if (!rate) return ''
  return `${Number(rate.toFixed(3))} fps`
}

const formatProfile = (profile, level) => {
  if (!profile) return ''
  if (!level || profile.includes('@')) return profile
  const normalizedLevel = String(level).match(/^L/i) ? level : `L${level}`
  return `${profile}@${normalizedLevel}`
}

const channelLayout = (layout, count) => {
  if (layout) {
    const normalized = String(layout).toLowerCase()
    if (normalized === 'stereo') return 'Stereo'
    if (normalized === 'mono') return 'Mono'
    if (normalized === '5.1(side)' || normalized === '5.1(back)') return '5.1'
    if (normalized === '7.1(wide-side)' || normalized === '7.1(wide)') return '7.1'
    return layout
  }
  return Number(count) > 0 ? `${count} channels` : ''
}

const friendlyDecoder = (value, fallback) => {
  const normalized = String(value || '').toLowerCase()
  if (normalized === 'videotoolbox-copy') return 'VideoToolbox (copy-back)'
  if (normalized === 'videotoolbox') return 'VideoToolbox'
  if (normalized === 'd3d11va-copy') return 'D3D11VA (copy-back)'
  if (normalized === 'd3d11va') return 'D3D11VA'
  if (normalized === 'dxva2-copy') return 'DXVA2 (copy-back)'
  return value || fallback || 'FFmpeg software'
}

const decodedPixelFormat = (value) => value ? String(value).toUpperCase() : ''

const row = (label, value, title = '') => ({ label, value, title })

export const buildMediaInfoSections = (diagnostics = {}, fallbackDuration = 0) => {
  const video = diagnostics.video || {}
  const audio = diagnostics.audio || {}
  const subtitle = diagnostics.subtitle || {}
  const profile = formatProfile(video.profile, video.level)
  const colorSummary = join([
    diagnostics.sourceFormat || 'SDR',
    diagnostics.friendlyPrimaries || diagnostics.primaries,
    diagnostics.friendlyTransfer || diagnostics.transfer,
  ])
  const colorDetails = join([
    diagnostics.primaries && `Primaries: ${diagnostics.friendlyPrimaries || diagnostics.primaries}`,
    video.matrix && `Matrix: ${video.friendlyMatrix || video.matrix}`,
    diagnostics.transfer && `Transfer: ${diagnostics.friendlyTransfer || diagnostics.transfer}`,
  ])
  const rawVideo = join([video.codec, video.profile, video.level])
  const rawAudio = join([audio.codec, audio.channelLayout, audio.channelCount])
  const rawSubtitle = join([subtitle.format, subtitle.language])
  const hardwareDecoder = diagnostics.hardwareDecoder || ''
  const output = join([diagnostics.outputMode, diagnostics.outputColorSpace])
  const display = diagnostics.display || {}
  const displayHeadroom = `${Number(display.currentHeadroom || 1).toFixed(2)}× current / ${Number(display.potentialHeadroom || 1).toFixed(2)}× potential`

  const sections = [
    {
      title: 'General',
      rows: [
        row('Container', diagnostics.friendlyContainer || diagnostics.container || 'Unknown', diagnostics.container || ''),
        row('File size', formatMediaBytes(diagnostics.fileSize)),
        row('Duration', formatMediaDuration(diagnostics.duration || fallbackDuration)),
        row('Average bitrate', formatMediaBitrate(diagnostics.overallBitrate)),
      ],
    },
    {
      title: 'Video',
      rows: [
        row('Format', join([video.friendlyCodec || video.codec || 'Unknown', profile]), rawVideo),
        row('Picture', join([
          video.width && video.height ? `${video.width}×${video.height}` : '',
          formatFrameRate(video.frameRate),
          video.progressive == null ? '' : video.progressive ? 'Progressive' : 'Interlaced',
        ])),
        row('Average bitrate', formatMediaBitrate(video.bitrate)),
        row('Signal', join([
          diagnostics.bitDepth && `${diagnostics.bitDepth}-bit`,
          video.chroma,
        ])),
        row('Color', colorSummary, colorDetails),
      ],
    },
    {
      title: 'Current audio',
      rows: [
        row('Format', join([
          audio.friendlyCodec || audio.codec || 'Unknown',
          channelLayout(audio.channelLayout, audio.channelCount),
          formatMediaBitrate(audio.bitrate),
          audio.sampleRate ? `${Number(audio.sampleRate / 1000).toFixed(audio.sampleRate % 1000 ? 1 : 0)} kHz` : '',
        ]), rawAudio),
        row('Track', join([
          audio.friendlyLanguage || audio.language,
          audio.title,
        ]), audio.language || ''),
      ],
    },
  ]

  if (subtitle.format) {
    sections.push({
      title: 'Subtitle',
      rows: [
        row('Format', subtitle.friendlyFormat || subtitle.format, rawSubtitle),
        row('Track', join([
          subtitle.friendlyLanguage || subtitle.language,
          subtitle.title,
          subtitle.forced ? 'Forced' : '',
          subtitle.default ? 'Default' : '',
        ]), subtitle.language || ''),
      ],
    })
  }

  sections.push({
    title: 'Playback',
    rows: [
      row('Backend', 'libmpv'),
      row('Demuxer', `FFmpeg / ${diagnostics.friendlyContainer || diagnostics.container || 'Unknown'}`, diagnostics.container || ''),
      row('Decoder', friendlyDecoder(hardwareDecoder, diagnostics.decoder), hardwareDecoder || diagnostics.decoder || ''),
      row('Hardware decode', hardwareDecoder ? 'Active' : 'Off'),
      row('Decoded pixel format', decodedPixelFormat(diagnostics.pixelFormat), diagnostics.pixelFormat || ''),
      row('Render surface', 'libmpv OpenGL Render API', diagnostics.renderer || ''),
      row('Output', output),
      row('Tone mapping', diagnostics.toneMapping === 'none' ? 'None' : diagnostics.toneMapping),
      row('Display', join([displayHeadroom, display.surfaceFormat])),
      diagnostics.fallbackReason ? row('Fallback reason', diagnostics.fallbackReason) : null,
    ].filter(Boolean),
  })

  return sections.map((section) => ({
    ...section,
    rows: section.rows.filter((item) => present(item.value)),
  }))
}
