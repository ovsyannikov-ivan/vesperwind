import assert from 'node:assert/strict'
import test from 'node:test'
import { buildMediaInfoSections } from '../src/utils/mediaInfo.js'

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

  assert.equal(section(sections, 'General').Container.value, 'Matroska')
  assert.equal(section(sections, 'Video').Format.value, 'AVC / H.264 · High@L4.1')
  assert.equal(section(sections, 'Video').Picture.value, '1280×536 · 23.976 fps · Progressive')
  assert.equal(section(sections, 'Video')['Average bitrate'].value, '6.20 Mbps')
  assert.equal(section(sections, 'Video').Signal.value, '8-bit · YUV 4:2:0')
  assert.equal(section(sections, 'Video').Signal.title, '')
  assert.equal(section(sections, 'Video').Color.value, 'SDR · BT.709 · BT.1886')
  assert.match(section(sections, 'Video').Color.title, /Matrix: BT\.709/)
})

test('summarizes selected audio, subtitles, and runtime playback separately', () => {
  const sections = buildMediaInfoSections(diagnostics)

  assert.equal(section(sections, 'Current audio').Format.value, 'Dolby Digital Plus · 5.1 · 1.02 Mbps · 48 kHz')
  assert.equal(section(sections, 'Current audio').Track.value, 'Russian · Дубляж (MovieDalen)')
  assert.equal(section(sections, 'Subtitle').Format.value, 'SubRip / SRT')
  assert.equal(section(sections, 'Subtitle').Track.value, 'Russian · Форсированные (iTunes) · Default')
  assert.equal(section(sections, 'Playback').Decoder.value, 'VideoToolbox (copy-back)')
  assert.equal(section(sections, 'Playback')['Hardware decode'].value, 'Active')
  assert.equal(section(sections, 'Playback')['Decoded pixel format'].value, 'NV12')
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
