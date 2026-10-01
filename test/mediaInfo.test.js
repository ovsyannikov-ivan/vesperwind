import assert from 'node:assert/strict'
import test from 'node:test'
import { buildMediaInfoSections, formatMediaChannels, formatMediaTrack } from '../src/utils/mediaInfo.js'

const diagnostics = {
  container: 'mkv',
  friendlyContainer: 'Matroska',
  fileSize: 10_445_909_602,
  duration: 6465,
  overallBitrate: 12_925_000,
  sourceFormat: 'SDR',
  transfer: 'bt.1886',
  friendlyTransfer: 'BT.1886',
  primaries: 'bt.709',
  friendlyPrimaries: 'BT.709',
  pixelFormat: 'nv12',
  bitDepth: 8,
  video: {
    codec: 'h264',
    friendlyCodec: 'AVC / H.264',
    profile: 'High',
    level: '4.1',
    width: 1280,
    height: 536,
    frameRate: 23.976,
    progressive: true,
    bitrate: 6_200_573,
    chroma: 'YUV 4:2:0',
    matrix: 'bt.709',
    friendlyMatrix: 'BT.709',
  },
  audio: {
    codec: 'eac3',
    friendlyCodec: 'Dolby Digital Plus',
    bitrate: 1_024_000,
    channelLayout: '5.1(side)',
    channelCount: 6,
    sampleRate: 48_000,
    language: 'ru',
    friendlyLanguage: 'Russian',
    title: 'Дубляж (MovieDalen)',
  },
  subtitle: {
    format: 'subrip',
    friendlyFormat: 'SubRip / SRT',
    language: 'ru',
    friendlyLanguage: 'Russian',
    title: 'Форсированные (iTunes)',
    default: true,
    forced: false,
  },
  hardwareDecoder: 'videotoolbox-copy',
  renderer: 'libmpv OpenGL Render API (vo=libmpv/vo_gpu)',
  outputMode: 'SDR',
  outputColorSpace: 'BT.709',
  toneMapping: 'none',
  display: {
    currentHeadroom: 1,
    potentialHeadroom: 1,
    surfaceFormat: 'RGBA16F NSOpenGL EDR',
  },
}

const section = (sections, title) => Object.fromEntries(
  sections.find((item) => item.title === title).rows.map((item) => [item.label, item]),
)

test('builds compact human-friendly media summaries while retaining raw details', () => {
  const sections = buildMediaInfoSections(diagnostics)

  assert.match(section(sections, 'General').File.value, /^Matroska · /)
  assert.equal(section(sections, 'Source video').Format.value, 'AVC / H.264 · High@L4.1 · 8-bit')
  assert.equal(section(sections, 'Source video').Picture.value, '1280×536 · 23.976 fps · 6.20 Mbps')
  assert.equal(section(sections, 'Source video').Color.value, 'SDR · BT.709 · BT.1886')
  assert.match(section(sections, 'Source video').Color.title, /Matrix: BT\.709/)
})

test('summarizes selected audio, subtitles, and runtime playback separately', () => {
  const sections = buildMediaInfoSections(diagnostics)

  assert.equal(section(sections, 'Current audio').Format.value, 'Dolby Digital Plus · 5.1 · 1.02 Mbps · 48 kHz')
  assert.equal(section(sections, 'Current audio').Track.value, 'Russian · Дубляж (MovieDalen)')
  assert.equal(section(sections, 'Subtitle').Track.value, 'SubRip / SRT · Russian · Форсированные (iTunes)')
  assert.equal(section(sections, 'Decode').Decoder.value, 'VideoToolbox (copy-back)')
  assert.equal(section(sections, 'Decode').Surface.value, 'NV12')
})

test('does not invent a surround layout from channel count alone', () => {
  const value = structuredClone(diagnostics)
  value.audio.channelLayout = null

  assert.equal(
    section(buildMediaInfoSections(value), 'Current audio').Format.value,
    'Dolby Digital Plus · 6 channels · 1.02 Mbps · 48 kHz',
  )
})

test('shows AAC stereo bitrate and sample rate on one current-audio line', () => {
  const value = structuredClone(diagnostics)
  value.audio = {
    codec: 'aac', friendlyCodec: 'AAC', channelLayout: 'stereo',
    channelCount: 2, bitrate: 209_000, sampleRate: 48_000,
  }
  assert.equal(
    section(buildMediaInfoSections(value), 'Current audio').Format.value,
    'AAC · Stereo · 209 kbps · 48 kHz',
  )
})

test('reports the active D3D11 renderer and preserves a separate presentation fallback reason', () => {
  const value = structuredClone(diagnostics)
  value.renderer = 'libmpv-owned gpu-next / D3D11 (SDR)'
  let playback = section(buildMediaInfoSections(value), 'Presentation')
  assert.equal(playback.Renderer.value, 'gpu-next / D3D11 / DXGI')
  assert.equal(playback.Renderer.title, value.renderer)
  assert.equal(playback['Renderer fallback'], undefined)
  value.renderer = diagnostics.renderer
  value.presentationFallbackReason = 'D3D11 video output could not initialize'
  playback = section(buildMediaInfoSections(value), 'Presentation')
  assert.equal(playback.Renderer.value, 'OpenGL Render API')
  assert.equal(playback.Renderer.title, diagnostics.renderer)
  assert.equal(playback['Renderer fallback'].value, value.presentationFallbackReason)
})

test('HDR10 diagnostics keep source, decode, processing, presentation and output evidence separate', () => {
  const value = structuredClone(diagnostics)
  Object.assign(value, {
    sourceFormat: 'Dolby Vision profile 8', dolbyVisionProfile: 8,
    transfer: 'pq', primaries: 'bt.2020', friendlyTransfer: 'PQ / ST 2084', friendlyPrimaries: 'BT.2020',
    hardwareDecoder: 'd3d11va', sourcePixelFormat: 'd3d11',
    renderer: 'libmpv-owned gpu-next / D3D11 / DXGI',
    outputMode: 'HDR10 (mpv target verified)', outputColorSpace: 'PQ / BT.2020',
    toneMapping: 'HDR display mapping (libplacebo)',
    display: { platform: 'windows', hdrCapable: true, hdrEnabled: true,
      hdrStateVerified: true, hdrCapabilityVerified: true, advancedColorEnabled: true },
    windowsOutput: { requested: 'HDR10 / PQ / BT.2020', targetVerified: true,
      targetTransfer: 'pq', targetPrimaries: 'bt.2020', targetPixelFormat: 'rgb10a2',
      dxgiFormat: 'DXGI_FORMAT_R10G10B10A2_UNORM',
      expectedDxgiColorSpace: 'DXGI_COLOR_SPACE_RGB_FULL_G2084_NONE_P2020',
      hdrMetadataState: 'not verified: public API has no delivery acknowledgement' },
  })
  const sections = buildMediaInfoSections(value)
  assert.match(section(sections, 'Source video').Color.value, /Dolby Vision profile 8/)
  assert.match(section(sections, 'Decode').Surface.value, /D3D11/i)
  assert.equal(section(sections, 'Processing')['Dolby Vision'].value, 'Disabled')
  assert.doesNotMatch(section(sections, 'Processing')['Tone mapping'].value, /SDR fallback|passthrough/)
  assert.equal(section(sections, 'Output').Surface.value, 'RGB10A2')
  assert.equal(section(sections, 'Output').Output.value, 'HDR10 (mpv target verified) · PQ / BT.2020')
  assert.equal(section(sections, 'Source video').Output, undefined)
})

test('SDR fallback and unknown Windows state do not inherit HDR source claims', () => {
  const value = { ...diagnostics, sourceFormat: 'HDR10 / PQ', outputMode: 'SDR fallback',
    fallbackReason: 'Windows HDR disabled', toneMapping: 'HDR-to-SDR fallback',
    display: { platform: 'windows', hdrStateVerified: false, hdrCapabilityVerified: false },
    droppedFrames: 0, decoderDroppedFrames: 0, delayedFrames: 0 }
  const sections = buildMediaInfoSections(value)
  assert.equal(section(sections, 'Output').Output.value, 'SDR fallback · BT.709')
  assert.equal(section(sections, 'Output')['Fallback reason'].value, 'Windows HDR disabled')
  assert.equal(section(sections, 'Output')['Windows HDR enabled'].value, 'not verified')
  assert.ok(!JSON.stringify(sections).includes('false'))
})

test('Info omits raw HDR metadata, long floats, and requested output details', () => {
  const value = { ...diagnostics, sourceHdrMetadata: { minLuminanceNits: 0.0020296412334634 },
    windowsOutput: { requested: 'HDR10 / PQ / BT.2020', targetVerified: false, targetPixelFormat: 'rgb10a2',
      targetHdrMetadata: { minLuminanceNits: 0.0020296412334634 } } }
  const sections = buildMediaInfoSections(value)
  assert.ok(sections.flatMap((item) => item.rows).length <= 20)
  assert.doesNotMatch(JSON.stringify(sections), /0\.002029|Min .*nits|Requested rendering|DXGI_COLOR_SPACE/)
  assert.equal(section(sections, 'Output').Surface.value, 'not verified')
})

test('unknown mpv channel layouts get a readable count in menus and Info', () => {
  const track = { id: 8, kind: 'audio', friendlyLanguage: 'English', friendlyCodec: 'DTS-HD MA', channelLayout: 'undefined8' }
  assert.equal(formatMediaChannels('undefined8'), '8 channels')
  assert.equal(formatMediaChannels('unknown', '6'), '6 channels')
  assert.equal(formatMediaChannels('undefined'), '')
  assert.equal(formatMediaTrack(track), 'English · DTS-HD MA · 8 channels')
  assert.equal(formatMediaTrack({ id: 3, kind: 'audio' }), 'Track 3')
  assert.match(section(buildMediaInfoSections({ ...diagnostics,
    audio: { ...diagnostics.audio, channelLayout: 'undefined8', channelCount: 8 } }), 'Current audio').Format.value, /8 channels/)
})


test('Metal info shows actual surface and unknown output without inventing HDR or DV', () => {
  const value = {
    ...diagnostics, renderer: 'gpu-next / Vulkan / MoltenVK / Metal (runtime VO/context verified)',
    outputMode: 'Not verified (output changing or unavailable)', outputHdrActive: false,
    targetTransfer: 'pq', targetPrimaries: 'bt.2020', dolbyVisionProfile: 8,
    dolbyVisionProcessing: 'Not observed; base-layer fallback', dolbyVisionRpu: null,
    systemDolbyVisionOutput: false,
    display: { platform: 'macos', metalPixelFormat: 115, surfaceFormat: 'mpv-owned Metal / RGBA16Float (115)',
      metalColorSpace: 'kCGColorSpaceITUR_2100_PQ', metalEdrEnabled: true, metalEdrMetadataPresent: false,
      currentHeadroom: 1, potentialHeadroom: 2 },
  }
  const sections = buildMediaInfoSections(value)
  assert.equal(section(sections, 'Presentation').Renderer.value, 'gpu-next / Vulkan / MoltenVK / Metal')
  assert.equal(section(sections, 'Output')['Metal surface'].value, value.display.surfaceFormat)
  assert.equal(section(sections, 'Output')['Layer colorspace'].value, value.display.metalColorSpace)
  assert.match(section(sections, 'Output').Output.value, /Not verified/)
  assert.equal(section(sections, 'Processing').RPU.value, 'Not verified')
  assert.equal(section(sections, 'Processing')['System Dolby Vision output'].value, 'Not used')
})
