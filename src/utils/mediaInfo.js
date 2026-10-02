const present = (value) => value !== null && value !== undefined && value !== '' && value !== false

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

export const formatMediaChannels = (layout, count) => {
  if (layout) {
    const normalized = String(layout).toLowerCase()
    // mpv uses e.g. "undefined8" when the channel count is known but positions are not.
    const unspecified = normalized.match(/^(?:undefined|unknown)(\d*)$/)
    if (unspecified) {
      const channels = Number(count) || Number(unspecified[1])
      return channels > 0 ? `${channels} channels` : ''
    }
    if (normalized === 'stereo') return 'Stereo'
    if (normalized === 'mono') return 'Mono'
    if (normalized === '5.1(side)' || normalized === '5.1(back)') return '5.1'
    if (normalized === '7.1(wide-side)' || normalized === '7.1(wide)') return '7.1'
    return layout
  }
  return Number(count) > 0 ? `${count} channels` : ''
}

export const formatMediaTrack = (track) => join([
  track.title || track.friendlyLanguage || track.language || `Track ${track.id}`,
  track.friendlyCodec || track.codec,
  track.kind === 'audio' && formatMediaChannels(track.channelLayout, track.channels),
])

const friendlyDecoder = (value, fallback) => {
  const normalized = String(value || '').toLowerCase()
  if (normalized === 'videotoolbox-copy') return 'VideoToolbox (copy-back)'
  if (normalized === 'videotoolbox') return 'VideoToolbox'
  if (normalized === 'd3d11va-copy') return 'D3D11VA (copy-back)'
  if (normalized === 'd3d11va') return 'D3D11VA'
  if (normalized === 'dxva2-copy') return 'DXVA2 (copy-back)'
  return value || fallback || 'FFmpeg software'
}

const friendlyRenderer = (value = '') => {
  if (/gpu-next.*D3D11/.test(value)) return 'gpu-next / D3D11 / DXGI'
  if (/gpu-next.*MoltenVK.*Metal/.test(value)) return 'gpu-next / Vulkan / MoltenVK / Metal'
  if (/OpenGL/.test(value)) return 'OpenGL Render API'
  return value || 'Not configured'
}

const decodedPixelFormat = (value) => {
  const format = String(value || '')
  return format.toLowerCase() === 'videotoolbox' ? 'VideoToolbox' : format.toUpperCase()
}

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
  const windowsOutput = diagnostics.windowsOutput
  const isWindows = display.platform === 'windows'

  const sections = [
    {
      title: 'General',
      rows: [
        row('File', join([diagnostics.friendlyContainer || diagnostics.container || 'Unknown', formatMediaBytes(diagnostics.fileSize)]), diagnostics.container || ''),
        row('Duration', formatMediaDuration(diagnostics.duration || fallbackDuration)),
      ],
    },
    {
      title: 'Source video',
      rows: [
        row('Format', join([video.friendlyCodec || video.codec || 'Unknown', profile, diagnostics.bitDepth && `${diagnostics.bitDepth}-bit`]), rawVideo),
        row('Picture', join([
          video.width && video.height ? `${video.width}×${video.height}` : '',
          formatFrameRate(video.frameRate),
          video.progressive === false && 'Interlaced',
          formatMediaBitrate(video.bitrate),
        ])),
        row('Color', colorSummary, colorDetails),
        diagnostics.dolbyVisionProfile != null ? row('Dolby Vision metadata', join([`Profile ${diagnostics.dolbyVisionProfile}`, diagnostics.dolbyVisionLevel != null ? `Level ${diagnostics.dolbyVisionLevel}` : ''])) : null,
      ],
    },
    {
      title: 'Current audio',
      rows: [
        row('Format', join([
          audio.friendlyCodec || audio.codec || 'Unknown',
          formatMediaChannels(audio.channelLayout, audio.channelCount),
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
        row('Track', join([
          subtitle.friendlyFormat || subtitle.format,
          subtitle.friendlyLanguage || subtitle.language,
          subtitle.title,
          subtitle.forced ? 'Forced' : '',
        ]), rawSubtitle),
      ],
    })
  }

  sections.push({
    title: 'Decode',
    rows: [
      row('Decoder', friendlyDecoder(hardwareDecoder, diagnostics.decoder), hardwareDecoder || diagnostics.decoder || ''),
      row('Surface', decodedPixelFormat(diagnostics.sourcePixelFormat || diagnostics.pixelFormat)),
    ].filter(Boolean),
  }, {
    title: 'Processing',
    rows: [
      diagnostics.dolbyVisionProfile != null ? row('Dolby Vision', diagnostics.dolbyVisionProcessing || (isWindows ? 'Disabled' : diagnostics.dolbyVisionSupport)) : null,
      diagnostics.dolbyVisionProfile != null ? row('RPU', diagnostics.dolbyVisionRpu === true ? 'Detected in mpv frame representation' : 'Not verified') : null,
      diagnostics.dolbyVisionProfile != null ? row('System Dolby Vision output', diagnostics.systemDolbyVisionOutput === true ? 'Verified' : 'Not used') : null,
      row('Tone mapping', diagnostics.toneMapping === 'none' ? 'None' : diagnostics.toneMapping),
    ].filter(Boolean),
  }, {
    title: 'Presentation',
    rows: [
      row('Renderer', friendlyRenderer(diagnostics.renderer), diagnostics.renderer || ''),
      diagnostics.presentationFallbackReason ? row('Renderer fallback', diagnostics.presentationFallbackReason) : null,
    ].filter(Boolean),
  }, {
    title: 'Output',
    rows: [
      row('Output', output),
      windowsOutput ? row('Surface', windowsOutput.targetVerified ? windowsOutput.targetPixelFormat?.toUpperCase() : 'not verified', windowsOutput.formatEvidence) : null,
      display.metalPixelFormat != null ? row('Metal surface', display.surfaceFormat) : null,
      display.metalPixelFormat != null ? row('Layer colorspace', display.metalColorSpace || 'Not configured') : null,
      display.metalPixelFormat != null ? row('Layer EDR', display.metalEdrEnabled === true ? 'Enabled' : 'Disabled') : null,
      display.metalPixelFormat != null ? row('EDR metadata', display.metalEdrMetadataPresent === true ? 'Present' : 'Not present') : null,
      display.metalPixelFormat != null ? row('Display headroom', join([Number.isFinite(display.currentHeadroom) ? `${display.currentHeadroom.toFixed(2)}× current` : '', Number.isFinite(display.potentialHeadroom) ? `${display.potentialHeadroom.toFixed(2)}× potential` : ''])) : null,
      display.metalPixelFormat != null ? row('mpv target', join([diagnostics.targetTransfer, diagnostics.targetPrimaries])) : null,
      isWindows ? row('Windows HDR enabled', display.hdrStateVerified ? (display.hdrEnabled ? 'Yes' : 'No') : 'not verified') : null,
      diagnostics.fallbackReason ? row('Fallback reason', diagnostics.fallbackReason) : null,
    ].filter(Boolean),
  })

  return sections.map((section) => ({
    ...section,
    rows: section.rows.filter((item) => item && present(item.value)),
  })).filter((section) => section.rows.length)
}
