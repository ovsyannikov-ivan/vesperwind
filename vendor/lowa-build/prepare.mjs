// Reproducible build-time recipe. Never invoked by normal application builds.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

export const coreCommit = 'efaf0670b4d055f838a2849becb10f08aa06a257'
export const compilerCommit = '949ee1d40467b80e90a9fdc67155d443426fef2d'
export const profiles = {
  '1024-fixed': { initialMiB: 1024, maximumMiB: 1024, growth: false },
  '512-fixed': { initialMiB: 512, maximumMiB: 512, growth: false },
  '256-fixed': { initialMiB: 256, maximumMiB: 256, growth: false },
  '128-grow-512': { initialMiB: 128, maximumMiB: 512, growth: true },
  '256-grow-1024': { initialMiB: 256, maximumMiB: 1024, growth: true },
}
export function buildDirectory(scratch, trim, requested) {
  const leaf = requested || (trim ? 'build-curated' : 'build-headless')
  if (!/^[a-zA-Z0-9_-]+$/.test(leaf)) throw new Error('Build directory must be a scratch child name')
  return path.join(scratch, leaf)
}
export const unrelatedImporters = ['libcdr', 'libvisio', 'libmspub', 'libfreehand',
  'libpagemaker', 'libqxp', 'libzmf', 'libstaroffice', 'libmwaw', 'libwps',
  'libwpd', 'libwpg', 'libabw', 'libebook', 'libetonyek', 'libodfgen', 'librevenge']
export function foreignModulePatch(original) {
  const needle = '\twriterperfect \\\n'
  if (original.split(needle).length !== 2) throw new Error('Unexpected writerperfect module registration')
  // Native Word binary/RTF and OOXML filters live in sw/writerfilter/oox.
  // writerperfect hosts unrelated importers, and its common library requires
  // odfgen/revenge even when every foreign-format filter has been disabled.
  return original.replace(needle, '\t$(if $(filter LIBODFGEN LIBREVENGE,$(BUILD_TYPE)),writerperfect) \\\n')
}
export function staticListPatch(original) {
  const needle = '$(shell echo -n \\\n'
  if (original.split(needle).length !== 2) throw new Error('Unexpected static link list command')
  // macOS /bin/sh echo does not recognize -n. Use a portable argument writer.
  return original.replace(needle, "$(shell printf '%s ' \\\n")
}
export function crossLockPatch(original) {
  const needle = '$(if $(and $(filter-out ANDROID MACOSX iOS WNT,$(OS))),$(1),$(2))'
  if (original.split(needle).length !== 2) throw new Error('Unexpected lockfile build condition')
  // The Mac native-tool side normally has no static link lock. Its Emscripten
  // target does; build the pinned native helper for that cross configuration.
  return original.replace(needle, '$(if $(or $(and $(filter MACOSX,$(OS)),$(filter EMSCRIPTEN,$(BUILD_TYPE_FOR_HOST))),$(filter-out ANDROID MACOSX iOS WNT,$(OS))),$(1),$(2))')
}
export function memoryPatch(original, profile) {
  if (!profile || profile.initialMiB > profile.maximumMiB) throw new Error('Invalid memory profile')
  const needle = 'gb_EMSCRIPTEN_LDFLAGS += -s TOTAL_MEMORY=1GB'
  if (original.split(needle).length !== 2) throw new Error('Unexpected upstream memory configuration')
  return original.replace(needle,
    `gb_EMSCRIPTEN_LDFLAGS += -sINITIAL_MEMORY=${profile.initialMiB * 1048576} -sMAXIMUM_MEMORY=${profile.maximumMiB * 1048576} -sALLOW_MEMORY_GROWTH=${Number(profile.growth)}`)
}

// Static WASM library filenames are not the filenames of the native macOS
// generators' shared libraries. Upstream's .a -> .so substitution assumes Linux.
// Mirror macosx.mk's extension and versioned UNO ABI names for build tools only.
export function nativeMappingPatch(original) {
  const needle = 'gb_Library_FILENAMES_FOR_BUILD := $(subst $(gb_Library_PLAINEXT),$(gb_Library_PLAINEXT_FOR_BUILD),$(gb_Library_FILENAMES))'
  if (original.split(needle).length !== 2) throw new Error('Unexpected native library mapping')
  return original.replace(needle, needle + `

ifeq ($(OS),EMSCRIPTEN)
ifeq ($(OS_FOR_BUILD),MACOSX)
gb_Library_FILENAMES_FOR_BUILD := $(subst .so,.dylib,$(gb_Library_FILENAMES_FOR_BUILD))
gb_Library_FILENAMES_FOR_BUILD := $(foreach mapping,$(gb_Library_FILENAMES_FOR_BUILD),$(if $(filter $(firstword $(subst :, ,$(mapping))),$(gb_Library_RTVERLIBS) $(gb_Library_UNOVERLIBS)),$(mapping).3,$(mapping)))
endif
endif`)
}

export function archiveBuildIdPatch(original) {
  const needle = '$(shell cd $(SRCDIR) && git log -1 --format=%H)'
  if (original.split(needle).length !== 3) throw new Error('Unexpected archive build-id lookup')
  return original.replaceAll(needle, coreCommit)
}

export function opensslCrossPatch(original) {
  const platform = '$(if $(filter EMSCRIPTEN,$(OS)),no-engine '
  const configure = '$(filter LINUX MACOSX FREEBSD ANDROID SOLARIS iOS,$(OS))'
  if (original.split(platform).length !== 2 || original.split(configure).length !== 2) {
    throw new Error('Unexpected OpenSSL cross configure')
  }
  // ./config detects the BUILD machine and injects -arch arm64. Force the
  // generic 32-bit C target; no native assembly or macOS architecture flags.
  return original.replace(platform, '$(if $(filter EMSCRIPTEN,$(OS)),linux-generic32 no-engine ')
    .replace(configure, '$(filter LINUX MACOSX FREEBSD ANDROID SOLARIS iOS EMSCRIPTEN,$(OS))')
}

export function argonExternalPatch(original) {
  const needle = 'MAKEFLAGS= $(MAKE) \\\n'
  if (original.split(needle).length !== 2) throw new Error('Unexpected Argon2 build command')
  return original.replace(needle, 'MAKEFLAGS= $(MAKE) $(if $(filter EMSCRIPTEN,$(OS)),libargon2.a AR="$(AR)") \\\n')
}

export function argonUnpackPatch(original) {
  const needle = '\texternal/argon2/private-symbols.patch.0 \\\n'
  if (original.split(needle).length !== 2) throw new Error('Unexpected Argon2 patch list')
  return original.replace(needle, needle + '\texternal/argon2/vesperwind-cross-ar.patch.0 \\\n')
}

export const argonArchivePatch = `--- Makefile
+++ Makefile
@@ -182,7 +182,7 @@
 \t\t$(CC) $(CFLAGS) $(LIB_CFLAGS) $(LDFLAGS) $(SO_LDFLAGS) $^ -o $@
\x20
 $(LIB_ST): \t$(OBJ)
-\t\tar rcs $@ $^
+\t\t$(AR) rcs $@ $^
\x20
 .PHONY: clean
 clean:
`

export function emptyAutotextPatch(original) {
  const first = '$(WSL) zip -q0X --filesync --must-match $@ mimetype && \\\n'
  const second = '$(WSL) zip -qrX --must-match $@ $(call extras_AUTOTEXTSHARE_XMLFILES_RELATIVE,$*))'
  if (original.split(first).length !== 2 || original.split(second).length !== 2) {
    throw new Error('Unexpected autotext ZIP recipe')
  }
  // user/mytexts legitimately has only a mimetype. Calling zip with zero
  // additional inputs fails on macOS; preserve the first valid ZIP instead.
  return original.replace(first, '$(WSL) zip -q0X --filesync --must-match $@ mimetype \\\n')
    .replace(second, '$(if $(call extras_AUTOTEXTSHARE_XMLFILES_RELATIVE,$*),&& $(WSL) zip -qrX --must-match $@ $(call extras_AUTOTEXTSHARE_XMLFILES_RELATIVE,$*)))')
}

// Exclude presentation chrome, not draw/chart/math code or registries. A profile
// using this package patch is UNACCEPTED until its complete conversion run passes.
export function packagePatch(original) {
  const lines = original.split('\n')
  const removed = []
  const filtered = lines.filter(line => {
    // These are semantic presentation defaults, not dialog/chrome assets.
    // DrawDocument loads them even in hidden/headless mode; losing styles.xml
    // makes the minimal PPTX load return an empty model.
    const presentationDefaults = /config\/soffice\.cfg\/simpress\/(styles|layoutlist|objectlist)\.xml\b/.test(line)
    const unwanted = !presentationDefaults && /^\s+\$\((INSTROOT|SRCDIR)\)/.test(line) &&
      (/config\/(soffice\.cfg|wizard)\//.test(line) || /\/shell\//.test(line) || /\/intro(-highres)?\.png/.test(line) ||
       /\/(gallery|template|basic|autotext)\//.test(line) || /android\/default-document\//.test(line))
    if (unwanted) removed.push(line.trim())
    return !unwanted
  }).join('\n')
  const themes = ['$(foreach theme,$(WITH_THEMES), \\',
    '    $(eval gb_emscripten_fs_image_files += $(INSTROOT)/$(LIBO_SHARE_FOLDER)/config/images_$(theme).zip))'].join('\n')
  if (!filtered.includes(themes) || !removed.length) throw new Error('Unexpected upstream packager')
  return { patched: filtered.replace(themes, '# Conversion-only: icon themes excluded from the FS image.'), removed }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const scratch = fs.realpathSync(process.env.LOWA_SCRATCH || '/private/tmp/vesperwind-lowa-rebuild')
  if (/\s/.test(scratch)) throw new Error('LibreOffice requires a space-free real build path')
  const source = path.join(scratch, 'core-' + coreCommit)
  const profileName = process.env.LOWA_MEMORY_PROFILE || '128-grow-512'
  const profile = profiles[profileName]
  if (!profile) throw new Error('Unknown memory profile')
  const trim = process.env.LOWA_TRIM_PACKAGE !== '0'
  const build = buildDirectory(scratch, trim, process.env.LOWA_BUILD_DIRECTORY)
  fs.mkdirSync(build, { recursive: true })
  const hash = text => createHash('sha256').update(text).digest('hex')
  const writeChanged = (target, text) => {
    if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== text) fs.writeFileSync(target, text)
  }
  const patchFile = (relative, expected, transform) => {
    const target = path.join(source, relative), backup = target + '.vesperwind-original'
    const original = fs.readFileSync(fs.existsSync(backup) ? backup : target, 'utf8')
    if (hash(original) !== expected) throw new Error('Source checksum mismatch: ' + relative)
    if (!fs.existsSync(backup)) fs.writeFileSync(backup, original, { flag: 'wx' })
    const result = transform(original)
    writeChanged(target, result)
    return { relative, originalSha256: expected, patchedSha256: hash(result) }
  }
  const changes = [patchFile('solenv/gbuild/platform/EMSCRIPTEN_INTEL_GCC.mk',
    'd55660f02b9987a45076f93f75b97a0be42a56859cc2460dce988caf8b22b018', text => memoryPatch(text, profile))]
  changes.push(patchFile('static/CustomTarget_emscripten_fs_image.mk',
    'd8cbce11662ab599844b27c3f4bf88b463ace32656b56743a254104672e8b26a', text => trim ? packagePatch(text).patched : text))
  changes.push(patchFile('RepositoryFixes.mk',
    '0c0ddc4ddf14f992eb5cc138ca833d4c420f8dc01baca40b1db8786e462d6936', nativeMappingPatch))
  changes.push(patchFile('instsetoo_native/CustomTarget_setup.mk',
    '92ece121c45fa26fd6d26ad1a0a0d095c19bf5b3473f5803a426f795d31de3f8', archiveBuildIdPatch))
  changes.push(patchFile('external/openssl/ExternalProject_openssl.mk',
    'a88b664d8cb9ad3fb0aaace6021953a2e7db1485c3a352fe8ff0e8a54d2382b7', opensslCrossPatch))
  changes.push(patchFile('external/argon2/ExternalProject_argon2.mk',
    '272ded8f9f7794049e09e1018a27fe4885e1e21ae6510ca73b037d760e77956b', argonExternalPatch))
  changes.push(patchFile('external/argon2/UnpackedTarball_argon2.mk',
    'f8a5b3c48ea02b9f006fdec72297c03a87e4d43d2451cbe3f191dcff0c39239f', argonUnpackPatch))
  const addedPatch = 'external/argon2/vesperwind-cross-ar.patch.0'
  writeChanged(path.join(source, addedPatch), argonArchivePatch)
  changes.push({ relative: addedPatch, originalSha256: null, patchedSha256: hash(argonArchivePatch) })
  changes.push(patchFile('extras/CustomTarget_autotextshare.mk',
    '5ab4891bf917cf9f4f91fcea3bb4b85277b1928720fccfb90b3c70d027e4e43c', emptyAutotextPatch))
  changes.push(patchFile('RepositoryModule_host.mk',
    'f668206ff6ad8de6c9eaa797fd2a3b8c6ca87192654924c5234235c9dcfe50e0', text => trim ? foreignModulePatch(text) : text))
  changes.push(patchFile('solenv/gbuild/platform/unxgcc.mk',
    '6c149aeb1689ae67ac4c7c51e04af8e41986d75b3e475983804712defb9ae77d', staticListPatch))
  changes.push(patchFile('solenv/gbuild/Conditions.mk',
    '247df5264b0316b4b66d48e340d36160f90a64570ff68635b82ef8d17739b014', crossLockPatch))
  const options = [
    '--host=wasm32-local-emscripten', '--disable-gui', '--with-wasm-module=writer impress',
    '--with-package-format=emscripten', '--enable-mpl-subset', '--disable-debug', '--disable-symbols',
    '--disable-qt5', '--disable-qt6', '--without-java', '--enable-python=no', '--disable-scripting',
    '--disable-extensions', '--disable-extension-integration', '--disable-extension-update',
    '--disable-database-connectivity', '--disable-report-builder', '--disable-firebird-sdbc',
    '--disable-postgresql-sdbc', '--disable-coinmp', '--disable-odk', '--disable-crashdump',
    '--disable-online-update', '--disable-online-update-mar', '--disable-emscripten-proxy-posix-sockets',
    '--disable-avmedia', '--disable-gstreamer-1-0', '--disable-dbus', '--disable-dconf', '--disable-cups',
    '--disable-gtk3', '--disable-gtk4', '--disable-pdfimport', '--disable-pdfium', '--without-help',
    '--without-helppack-integration', '--with-galleries=no', '--with-templates=no', '--without-myspell-dicts',
    '--without-lxml', '--disable-compiler-plugins', '--disable-ccache', '--with-lang=en-US',
    '--enable-dependency-tracking', '--enable-bogus-pkg-config',
    '--with-build-platform-configure-options=--enable-bogus-pkg-config',
    '--with-external-tar=' + path.join(scratch, 'tarballs'),
  ]
  const configureEnv = trim ? Object.fromEntries(unrelatedImporters.map(name => ['test_' + name, 'no'])) : {}
  if (trim) options.push('--disable-curl', '--disable-breakpad', '--disable-libcmis', '--without-webdav', '--with-theme=no')
  // Fonts remain in the baseline. Removing fonts requires a separate curated
  // font manifest and fidelity acceptance; merely disabling fonts is not safe.
  writeChanged(path.join(build, 'autogen.input'), options.join('\n') + '\n')
  writeChanged(path.join(scratch, 'emscripten.config'), [
    `LLVM_ROOT = ${JSON.stringify(path.join(scratch, 'sdk/install/bin'))}`,
    `BINARYEN_ROOT = ${JSON.stringify(path.join(scratch, 'sdk/install'))}`,
    `NODE_JS = ${JSON.stringify(path.join(scratch, 'node-v20.14.0-darwin-arm64/bin/node'))}`,
    `CACHE = ${JSON.stringify(path.join(scratch, 'emscripten-cache'))}`,
  ].join('\n') + '\n')
  fs.mkdirSync(path.join(scratch, 'tarballs'), { recursive: true })
  fs.writeFileSync(path.join(build, 'recipe.json'), JSON.stringify({
    schemaVersion: 1, coreCommit, compilerCommit, profileName, profile, trim,
    source, build, options, configureEnv, changes, buildCompleted: false, reproducibilityVerified: false,
  }, null, 2) + '\n')
  console.log({ source, build, profileName, trim, changes })
}
