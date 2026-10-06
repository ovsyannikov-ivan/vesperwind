// Dolby Vision build provenance shared by the bundle packagers and verifiers.
// libplacebo's built-in `dovi` reshaping is LGPL-2.1+ code that consumes
// FFmpeg's parsed RPU; the external `libdovi` parser is never allowed.
//
// A manifest platform entry separates two configurations:
// - `requiredLibplaceboOptions` / `doviProcessing`: the checked-in artifact,
//   which its own BUILD-INFO evidence must match;
// - `buildRecipeLibplaceboOptions` (optional, defaults to the artifact): what
//   the platform build script produces now.
// While they differ the entry must say `artifactPendingRebuild: true`; the
// packager clears it when it records a rebuilt artifact.

export const doviNote = (state) =>
  `libplacebo built-in Dolby Vision RPU reshaping: ${state}; libdovi: disabled; system Dolby Vision output: not used`

export const doviState = (options = []) => {
  if (!options.includes('-Dlibdovi=disabled')) {
    throw new Error('libplacebo must be built with -Dlibdovi=disabled')
  }
  if (options.includes('-Ddovi=enabled')) return 'enabled'
  if (options.includes('-Ddovi=disabled')) return 'disabled'
  throw new Error('libplacebo options must state -Ddovi=enabled or -Ddovi=disabled')
}

// Returns the checked-in artifact's state and the build recipe's state.
export const checkDoviManifest = (platform) => {
  const artifact = doviState(platform.requiredLibplaceboOptions)
  const recipe = doviState(platform.buildRecipeLibplaceboOptions ?? platform.requiredLibplaceboOptions)
  if (!platform.doviProcessing?.startsWith(doviNote(artifact))) {
    throw new Error(`Manifest doviProcessing must start with: ${doviNote(artifact)}`)
  }
  const pending = artifact !== recipe
  if (pending !== (platform.artifactPendingRebuild === true)) {
    throw new Error(pending
      ? `Build recipe has -Ddovi=${recipe} but the artifact has -Ddovi=${artifact}; set artifactPendingRebuild`
      : 'artifactPendingRebuild is set although the artifact matches its build recipe')
  }
  return { artifact, recipe, pending }
}

// Packaging records the artifact that was actually built: its resolved Meson
// options replace the previous artifact entry. A build that does not honour
// the recipe is rejected rather than recorded.
export const recordBuiltArtifact = (platform, libplaceboOptions) => {
  const built = doviState(libplaceboOptions)
  const recipe = doviState(platform.buildRecipeLibplaceboOptions ?? platform.requiredLibplaceboOptions)
  if (built !== recipe) throw new Error(`Built libplacebo has -Ddovi=${built}; the recipe requires -Ddovi=${recipe}`)
  const next = { ...platform, requiredLibplaceboOptions: [...libplaceboOptions], doviProcessing: doviNote(built) }
  delete next.artifactPendingRebuild
  return next
}

// macOS BUILD-INFO.txt is text written by build-libmpv-macos.sh.
export const checkMacosDoviEvidence = (buildInfo, state) => {
  const required = [`libplacebo dovi: ${state}; libdovi: disabled`]
  if (state === 'enabled') {
    required.push(
      'libplacebo pkg-config: pl_has_dovi=1 pl_has_libdovi=0',
      'mpv Dolby Vision metadata mapping: PL_HAVE_LAV_DOLBY_VISION defined',
    )
  }
  for (const evidence of required) {
    if (!buildInfo.includes(evidence)) throw new Error(`Missing Dolby Vision build evidence: ${evidence}`)
  }
  if (/pl_has_libdovi=1|libdovi: enabled/.test(buildInfo)) {
    throw new Error('The bundle was built with libdovi')
  }
}

// Windows BUILD-INFO.txt is JSON with libplacebo's resolved Meson options and,
// for dovi builds, its pkg-config variables and the mpv header check.
export const checkWindowsDoviEvidence = (info, state) => {
  for (const flag of [`-Ddovi=${state}`, '-Dlibdovi=disabled']) {
    if (!info.libplaceboOptions?.includes(flag)) throw new Error(`Missing libplacebo flag: ${flag}`)
  }
  if (info.libplaceboPkgConfig?.pl_has_libdovi === '1') throw new Error('The bundle was built with libdovi')
  if (state !== 'enabled') return
  if (info.libplaceboPkgConfig?.pl_has_dovi !== '1' || info.libplaceboPkgConfig?.pl_has_libdovi !== '0') {
    throw new Error('Missing libplacebo pkg-config evidence: pl_has_dovi=1 pl_has_libdovi=0')
  }
  if (!info.doviMapping?.includes('PL_HAVE_LAV_DOLBY_VISION defined')) {
    throw new Error('Missing mpv Dolby Vision metadata mapping evidence')
  }
}
