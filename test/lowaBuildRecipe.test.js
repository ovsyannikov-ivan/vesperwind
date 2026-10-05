import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { memoryPatch, packagePatch, nativeMappingPatch, archiveBuildIdPatch, opensslCrossPatch, argonExternalPatch, argonUnpackPatch, argonArchivePatch, emptyAutotextPatch, coreCommit, profiles } from '../vendor/lowa-build/prepare.mjs'
import { execFileSync } from 'node:child_process'
import { foreignModulePatch, staticListPatch, crossLockPatch } from '../vendor/lowa-build/prepare.mjs'

test('static link arguments do not contain literal echo -n on macOS', () => {
  const recipe = staticListPatch('args := $(shell echo -n \\\n-luno_sal -lcppu)\nall:;@echo $(args)\n')
  const output = execFileSync('/usr/bin/make', ['-f', '-'], { input: recipe, encoding: 'utf8' }).trim()
  assert.equal(output, '-luno_sal -lcppu')
  assert.throws(() => staticListPatch('changed'))
})

test('Emscripten cross build includes its native lock helper on Mac', () => {
  const original = '$(if $(and $(filter-out ANDROID MACOSX iOS WNT,$(OS))),$(1),$(2))'
  const recipe = 'define cond\n' + crossLockPatch(original) + '\nendef\nall:;@echo $(call cond,yes,no)\n'
  const run = (os, target = '') => execFileSync('/usr/bin/make', ['-f', '-', `OS=${os}`, `BUILD_TYPE_FOR_HOST=${target}`],
    { input: recipe, encoding: 'utf8' }).trim()
  assert.equal(run('MACOSX', 'LibO EMSCRIPTEN'), 'yes')
  assert.equal(run('MACOSX'), 'no')
  assert.equal(run('WNT', 'LibO EMSCRIPTEN'), 'no')
  assert.equal(run('LINUX'), 'yes')
  assert.equal(run('EMSCRIPTEN'), 'yes')
  assert.throws(() => crossLockPatch('changed'))
})

test('foreign module follows dependency gates without disabling Word/OOXML', () => {
  const original = 'modules := sw writerfilter oox \\\n\twriterperfect \\\n\txmloff\n'
  const recipe = foreignModulePatch(original) + 'all:;@echo $(modules)\n'
  const run = type => execFileSync('/usr/bin/make', ['-f', '-', `BUILD_TYPE=${type}`],
    { input: recipe, encoding: 'utf8' }).trim()
  assert.equal(run('EMSCRIPTEN'), 'sw writerfilter oox xmloff')
  assert.equal(run('EMSCRIPTEN LIBODFGEN LIBREVENGE'), 'sw writerfilter oox writerperfect xmloff')
  assert.throws(() => foreignModulePatch('changed'))
})

test('macOS native tools use dylib and versioned UNO names; Linux mapping is unchanged', () => {
  const original = 'gb_Library_FILENAMES_FOR_BUILD := $(subst $(gb_Library_PLAINEXT),$(gb_Library_PLAINEXT_FOR_BUILD),$(gb_Library_FILENAMES))\n'
  const recipe = ['gb_Library_PLAINEXT := .a', 'gb_Library_PLAINEXT_FOR_BUILD := .so',
    'gb_Library_FILENAMES := gcc3_uno:libgcc3_uno.a cppu:libuno_cppu.a cppuhelper:libuno_cppuhelpergcc3.a sax:libsaxlo.a',
    'gb_Library_UNOVERLIBS := cppu', 'gb_Library_RTVERLIBS := cppuhelper',
    nativeMappingPatch(original), 'all:;@echo $(gb_Library_FILENAMES_FOR_BUILD)'].join('\n')
  const run = host => execFileSync('/usr/bin/make', ['-f', '-', 'OS=EMSCRIPTEN', `OS_FOR_BUILD=${host}`],
    { input: recipe, encoding: 'utf8' }).trim()
  assert.equal(run('MACOSX'), 'gcc3_uno:libgcc3_uno.dylib cppu:libuno_cppu.dylib.3 cppuhelper:libuno_cppuhelpergcc3.dylib.3 sax:libsaxlo.dylib')
  assert.equal(run('LINUX'), 'gcc3_uno:libgcc3_uno.so cppu:libuno_cppu.so cppuhelper:libuno_cppuhelpergcc3.so sax:libsaxlo.so')
  assert.throws(() => nativeMappingPatch('source changed'))
})

test('growth variants set both initial and maximum memory explicitly', () => {
  const original = 'gb_EMSCRIPTEN_LDFLAGS += -s TOTAL_MEMORY=1GB\n'
  const result = memoryPatch(original, profiles['128-grow-512'])
  assert.match(result, /INITIAL_MEMORY=134217728/)
  assert.match(result, /MAXIMUM_MEMORY=536870912/)
  assert.match(result, /ALLOW_MEMORY_GROWTH=1/)
  assert.throws(() => memoryPatch('upstream changed', profiles['512-fixed']))
  assert.throws(() => memoryPatch(original, { initialMiB: 512, maximumMiB: 128 }))
})

test('archive build metadata uses the verified source pin rather than an empty git lookup', () => {
  const original = 'buildid=$(shell cd $(SRCDIR) && git log -1 --format=%H)\n' +
    'buildid=$(shell cd $(SRCDIR) && git log -1 --format=%H)\n'
  assert.equal(archiveBuildIdPatch(original), `buildid=${coreCommit}\nbuildid=${coreCommit}\n`)
  assert.throws(() => archiveBuildIdPatch('upstream changed'))
})

test('OpenSSL cross configure uses a generic WASM C target instead of host detection', () => {
  const original = '$(if $(filter EMSCRIPTEN,$(OS)),no-engine no-asm)\n' +
    '$(if $(filter LINUX MACOSX FREEBSD ANDROID SOLARIS iOS,$(OS)),./Configure,./config)'
  const patched = opensslCrossPatch(original)
  assert.match(patched, /linux-generic32 no-engine no-asm/)
  assert.match(patched, /iOS EMSCRIPTEN,\$\(OS\)/)
  assert.throws(() => opensslCrossPatch('changed'))
})

test('Argon2 builds the needed static archive with the target archiver', () => {
  const original = 'MAKEFLAGS= $(MAKE) \\\n\tOPTTARGET=forcefail'
  assert.match(argonExternalPatch(original), /EMSCRIPTEN,\$\(OS\)\),libargon2\.a AR="\$\(AR\)"/)
  assert.match(argonUnpackPatch('\texternal/argon2/private-symbols.patch.0 \\\n'), /vesperwind-cross-ar\.patch\.0/)
  assert.match(argonArchivePatch, /\+\t\t\$\(AR\) rcs/)
  assert.throws(() => argonExternalPatch('changed'))
  assert.throws(() => argonUnpackPatch('changed'))
})

test('empty autotext keeps the valid ZIP without an empty second zip invocation', () => {
  const original = '$(WSL) zip -q0X --filesync --must-match $@ mimetype && \\\n' +
    '$(WSL) zip -qrX --must-match $@ $(call extras_AUTOTEXTSHARE_XMLFILES_RELATIVE,$*))'
  const patched = emptyAutotextPatch(original)
  assert.doesNotMatch(patched, /mimetype &&/)
  assert.match(patched, /\$\(if \$\(call extras_AUTOTEXTSHARE_XMLFILES_RELATIVE,\$\*\),&&/)
  assert.throws(() => emptyAutotextPatch('changed'))
})

test('conversion packager excludes chrome while retaining registries and font support', () => {
  const original = [
    'gb_emscripten_fs_image_files := \\',
    '    $(INSTROOT)/$(LIBO_SHARE_FOLDER)/config/soffice.cfg/cui/ui/aboutdialog.ui \\',
    '    $(INSTROOT)/$(LIBO_SHARE_FOLDER)/config/soffice.cfg/simpress/styles.xml \\',
    '    $(INSTROOT)/$(LIBO_SHARE_FOLDER)/config/soffice.cfg/simpress/layoutlist.xml \\',
    '    $(INSTROOT)/$(LIBO_SHARE_FOLDER)/config/soffice.cfg/simpress/objectlist.xml \\',
    '    $(INSTROOT)/$(LIBO_ETC_FOLDER)/services/services.rdb \\',
    '    $(INSTROOT)/$(LIBO_BIN_FOLDER)/intro.png \\',
    '    $(INSTROOT)/$(LIBO_SHARE_FOLDER)/config/wizard/form/styles/water.css \\',
    '    $(SRCDIR)/android/default-document/example.odt \\',
    '',
    '$(foreach theme,$(WITH_THEMES), \\',
    '    $(eval gb_emscripten_fs_image_files += $(INSTROOT)/$(LIBO_SHARE_FOLDER)/config/images_$(theme).zip))',
    'gb_emscripten_fs_image_filelists += $(call gb_Package_get_target,fontconfig_data)',
  ].join('\n')
  const { patched, removed } = packagePatch(original)
  assert.equal(removed.length, 4)
  assert.match(patched, /services\/services.rdb/)
  assert.match(patched, /fontconfig_data/)
  assert.match(patched, /simpress\/styles\.xml/)
  assert.match(patched, /simpress\/layoutlist\.xml/)
  assert.match(patched, /simpress\/objectlist\.xml/)
  assert.doesNotMatch(patched, /aboutdialog|intro\.png|example\.odt|images_\$\(theme\)/)
})

// This optional source check verifies recipe drift, not conversion fidelity.
if (process.env.LOWA_ORIGINAL_PACKAGER) {
  test('patch accepts the pinned real source packager', () => {
    const { patched, removed } = packagePatch(fs.readFileSync(process.env.LOWA_ORIGINAL_PACKAGER, 'utf8'))
    assert.ok(removed.length > 1000)
    assert.match(patched, /fontconfig_data/)
    assert.match(patched, /services\/services.rdb/)
  })
}
