# vim: set noet sw=4 ts=4:
# -*- Mode: makefile-gmake; tab-width: 4; indent-tabs-mode: t -*-
#
# This file is part of the LibreOffice project.
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

$(eval $(call gb_CustomTarget_CustomTarget,static/emscripten_fs_image))

gb_emscripten_fs_image_autoinstall :=
gb_emscripten_fs_image_filelists :=

# file_packager.py supports renaming files by using "<src>@<dest>" input with all
# @ escaped as @@ in both paths. Decoding this "encoding" in Makefile seems hard.
#
# Currently WASM simply assumes the image has the same layout then instdir. The
# command is run from $(BUILDDIR), so everything from $(BUILDDIR) can be just
# included "as it". Files from $(SRCDIR) are converted to the '@' syntax.
#
# Easiest workaround for most other limitations is probably to hack the filenames
# in soffice.data.js.metadata after the image generation or manually add additional
# commandline entries to the file_packager.py call.
#
gb_emscripten_fs_image_files := \
    $(call gb_UnoApi_get_target,offapi) \
    $(call gb_UnoApi_get_target,oovbaapi) \
    $(call gb_UnoApi_get_target,udkapi) \
    $(INSTROOT)/$(LIBO_ETC_FOLDER)/$(call gb_Helper_get_rcfile,bootstrap) \
    $(INSTROOT)/$(LIBO_ETC_FOLDER)/$(call gb_Helper_get_rcfile,fundamental) \
    $(INSTROOT)/$(LIBO_ETC_FOLDER)/$(call gb_Helper_get_rcfile,louno) \
    $(INSTROOT)/$(LIBO_ETC_FOLDER)/$(call gb_Helper_get_rcfile,setup) \
    $(INSTROOT)/$(LIBO_ETC_FOLDER)/$(call gb_Helper_get_rcfile,soffice) \
    $(INSTROOT)/$(LIBO_ETC_FOLDER)/$(call gb_Helper_get_rcfile,version) \
    $(INSTROOT)/$(LIBO_ETC_FOLDER)/services/services.rdb \
    $(INSTROOT)/$(LIBO_SHARE_FOLDER)/filter/oox-drawingml-adj-names \
    $(INSTROOT)/$(LIBO_SHARE_FOLDER)/filter/oox-drawingml-cs-presets \
    $(INSTROOT)/$(LIBO_SHARE_FOLDER)/filter/vml-shape-types \

ifneq ($(ENABLE_WASM_STRIP_WRITER),TRUE)
gb_emscripten_fs_image_files += \

endif # !ENABLE_WASM_STRIP_WRITER

ifneq ($(ENABLE_WASM_STRIP_BASIC_DRAW_MATH_IMPRESS),TRUE)
gb_emscripten_fs_image_files += \
    $(INSTROOT)/$(LIBO_SHARE_FOLDER)/config/soffice.cfg/simpress/layoutlist.xml \
    $(INSTROOT)/$(LIBO_SHARE_FOLDER)/config/soffice.cfg/simpress/objectlist.xml \
    $(INSTROOT)/$(LIBO_SHARE_FOLDER)/config/soffice.cfg/simpress/styles.xml \

endif # !ENABLE_WASM_STRIP_BASIC_DRAW_MATH_IMPRESS

ifneq ($(ENABLE_WASM_STRIP_CALC),TRUE)
gb_emscripten_fs_image_files += \

endif # !ENABLE_WASM_STRIP_CALC

gb_emscripten_fs_image_files += \
    $(INSTROOT)/$(LIBO_SHARE_FOLDER)/fonts/truetype/fc_local.conf \
    $(INSTROOT)/$(LIBO_SHARE_FOLDER)/registry/cjk.xcd \
    $(INSTROOT)/$(LIBO_SHARE_FOLDER)/registry/ctlseqcheck.xcd \
    $(INSTROOT)/$(LIBO_SHARE_FOLDER)/registry/ctl.xcd \
    $(INSTROOT)/$(LIBO_SHARE_FOLDER)/registry/graphicfilter.xcd \
    $(INSTROOT)/$(LIBO_SHARE_FOLDER)/registry/Langpack-en-US.xcd \
    $(INSTROOT)/$(LIBO_SHARE_FOLDER)/registry/lingucomponent.xcd \
    $(INSTROOT)/$(LIBO_SHARE_FOLDER)/registry/main.xcd \
    $(INSTROOT)/$(LIBO_SHARE_FOLDER)/registry/res/fcfg_langpack_en-US.xcd \
    $(INSTROOT)/$(LIBO_SHARE_FOLDER)/registry/res/registry_en-US.xcd \
    $(INSTROOT)/$(LIBO_SHARE_FOLDER)/registry/writer.xcd \
	$(INSTROOT)/$(LIBO_SHARE_FOLDER)/registry/calc.xcd \
    $(INSTROOT)/$(LIBO_SHARE_FOLDER)/registry/draw.xcd \
    $(INSTROOT)/$(LIBO_SHARE_FOLDER)/registry/impress.xcd \
    $(INSTROOT)/$(LIBO_SHARE_FOLDER)/registry/math.xcd \
    $(INSTROOT)/$(LIBO_SHARE_FOLDER)/registry/static.xcd \
    $(INSTROOT)/$(LIBO_SHARE_FOLDER)/registry/xsltfilter.xcd \
    $(INSTROOT)/$(LIBO_SHARE_PRESETS_FOLDER)/config/autotbl.fmt \
    $(INSTROOT)/$(LIBO_SHARE_RESOURCE_FOLDER)/common/fonts/opens___.ttf \
    $(INSTROOT)/$(LIBO_URE_ETC_FOLDER)/$(call gb_Helper_get_rcfile,uno) \
    $(INSTROOT)/$(LIBO_URE_MISC_FOLDER)/services.rdb \

ifneq ($(ENABLE_WASM_STRIP_CHART),TRUE)
gb_emscripten_fs_image_files += \

endif # !ENABLE_WASM_STRIP_CHART

# Conversion-only: icon themes excluded from the FS image.

ifeq ($(WITH_FONTS),TRUE)
gb_emscripten_fs_image_autoinstall += $(call gb_AutoInstall_get_target,ooo_fonts)
endif

gb_emscripten_fs_image_filelists += $(call gb_Package_get_target,liblangtag_data)
gb_emscripten_fs_image_filelists += $(call gb_Package_get_target,fontconfig_data)

#
# Ruleset
#

emscripten_fs_image_WORKDIR := $(gb_CustomTarget_workdir)/static/emscripten_fs_image

# we just need data.js.link at link time, which is equal to soffice.data.js
$(call gb_CustomTarget_get_target,static/emscripten_fs_image): \
    $(emscripten_fs_image_WORKDIR)/soffice.data \
    $(emscripten_fs_image_WORKDIR)/soffice.data.js.link \
    $(emscripten_fs_image_WORKDIR)/soffice.data.js.metadata \

$(emscripten_fs_image_WORKDIR)/soffice.data $(emscripten_fs_image_WORKDIR)/soffice.data.js : $(emscripten_fs_image_WORKDIR)/soffice.data.js.metadata

.PRECIOUS: $(emscripten_fs_image_WORKDIR)/soffice.data.js.link
$(emscripten_fs_image_WORKDIR)/soffice.data.js.link: $(emscripten_fs_image_WORKDIR)/soffice.data.js
	$(call gb_Helper_copy_if_different_and_touch,$^,$@)

.PHONY: $(emscripten_fs_image_WORKDIR)/soffice.data.concat_lists
$(emscripten_fs_image_WORKDIR)/soffice.data.concat_lists: $(gb_emscripten_fs_image_filelists) $(gb_emscripten_fs_image_autoinstall)
	$(shell cat $(gb_emscripten_fs_image_filelists) >> $@.tmp)
	$(foreach list,$(shell sed -ne 's/PACKAGE_FILELIST.*,//' -e 's/.filelist.$$//p' $(gb_emscripten_fs_image_autoinstall)), \
	    $(shell cat $(call gb_Package_get_target,$(list)) >> $@.tmp))
	$(shell mv $@.tmp $@)

gb_emscripten_fs_image_all_files = $(gb_emscripten_fs_image_files) $(shell cat $(emscripten_fs_image_WORKDIR)/soffice.data.concat_lists)

.PHONY: $(emscripten_fs_image_WORKDIR)/soffice.data.filelist
$(emscripten_fs_image_WORKDIR)/soffice.data.filelist: \
		$(call gb_InstallModule_get_target,scp2/ooo) \
		$(emscripten_fs_image_WORKDIR)/soffice.data.concat_lists \
		$(gb_emscripten_fs_image_files) \
		| $(emscripten_fs_image_WORKDIR)/.dir
	$(file >$@,\
	    $(subst @,@@,$(subst $(BUILDDIR)/,,$(filter $(BUILDDIR)%,$(gb_emscripten_fs_image_all_files)))) \
	    $(foreach item,$(filter-out $(BUILDDIR)%,$(gb_emscripten_fs_image_all_files)),$(subst @,@@,$(item))@$(subst @,@@,$(subst $(SRCDIR)/,,$(item)))))

# Unfortunately the file packager just allows a cmdline file list, but all paths are
# relative to $(BUILDDIR), so we won't run out of cmdline space that fast...
$(emscripten_fs_image_WORKDIR)/soffice.data.js.metadata: $(emscripten_fs_image_WORKDIR)/soffice.data.filelist
	$(call gb_Output_announce,$(subst $(BUILDDIR)/,,$(emscripten_fs_image_WORKDIR)/soffice.data),$(true),GEN,2)
	cd $(BUILDDIR) && \
	$(EMSDK_FILE_PACKAGER) $(emscripten_fs_image_WORKDIR)/soffice.data --preload $(shell cat $^) --js-output=$(emscripten_fs_image_WORKDIR)/soffice.data.js --separate-metadata \
	    || rm -f $(emscripten_fs_image_WORKDIR)/soffice.data.js $(emscripten_fs_image_WORKDIR)/soffice.data $(emscripten_fs_image_WORKDIR)/soffice.data.js.metadata

# vim: set noet sw=4:
