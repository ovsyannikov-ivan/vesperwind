<script setup>
import Modal from "bootstrap/js/dist/modal";
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useSettings } from "../composables/useSettings.js";
import { useTheme } from "../composables/useTheme.js";
import { editorThemes } from "../editor/themes/registry.js";
import { DEFAULT_FORMATTING } from "../../shared/editorFormatting.js";
import { parseEditableFilesText } from "../utils/editableFiles.js";

const props = defineProps({
	open: {
		type: Boolean,
		default: false,
	},
});

const emit = defineEmits(["close"]);
const { settings, storagePath, loadSettings, saveSettings, resetSettings } = useSettings();
const { setThemePreference } = useTheme();
const modalElement = ref(null);
const activeSection = ref("general");
const theme = ref("system");
const locale = ref("");
const suffixesText = ref("");
const editableFilesText = ref("");
const editorTheme = ref("auto");
const formatting = ref({ ...DEFAULT_FORMATTING });
const formattingCheckboxes = [{ key: "formatOnSave", label: "Format on save" }, { key: "useTabs", label: "Use tabs" }, { key: "semi", label: "Semicolons" }, { key: "singleQuote", label: "Single quotes" }, { key: "bracketSpacing", label: "Bracket spacing" }];
const loading = ref(false);
const saving = ref(false);
const errorMessage = ref("");
let modal = null;

const syncDraft = () => {
	editorTheme.value = settings.value.editor.theme;
	formatting.value = { ...settings.value.editor.formatting };
	theme.value = settings.value.appearance.theme;
	locale.value = settings.value.appearance.locale;
	suffixesText.value = settings.value.filesystem.hiddenNameSuffixes.join("\n");
	editableFilesText.value = settings.value.editor.editableFiles.join("\n");
};

const loadDraft = async () => {
	loading.value = true;
	errorMessage.value = "";
	const response = await loadSettings({ force: true });
	loading.value = false;

	if (!response?.ok) {
		errorMessage.value = response?.error?.message || "Unable to load settings";
		return;
	}

	syncDraft();
};

const show = () => {
	activeSection.value = "general";
	modal?.show();
	loadDraft();
};

const close = () => {
	if (!saving.value) {
		setThemePreference(settings.value.appearance.theme);
		emit("close");
	}
};

const handleHide = (event) => {
	if (saving.value) {
		event.preventDefault();
	}
};

const handleHidden = () => {
	if (props.open) {
		setThemePreference(settings.value.appearance.theme);
		emit("close");
	}
};

const save = async () => {
	saving.value = true;
	errorMessage.value = "";
	const hiddenNameSuffixes = suffixesText.value
		.split("\n")
		.map((value) => value.trim())
		.filter(Boolean);
	const editableFiles = parseEditableFilesText(editableFilesText.value);
	const response = await saveSettings({
		...settings.value,
		appearance: {
			...settings.value.appearance,
			theme: theme.value,
			locale: locale.value,
		},
		filesystem: {
			...settings.value.filesystem,
			hiddenNameSuffixes,
		},
		editor: {
			...settings.value.editor,
			theme: editorTheme.value,
			formatting: { ...formatting.value },
			editableFiles,
		},
	});
	saving.value = false;

	if (!response?.ok) {
		errorMessage.value = response?.error?.message || "Unable to save settings";
		return;
	}

	close();
};

const reset = async () => {
	saving.value = true;
	errorMessage.value = "";
	const response = await resetSettings();
	saving.value = false;

	if (!response?.ok) {
		errorMessage.value = response?.error?.message || "Unable to reset settings";
		return;
	}

	syncDraft();
};

watch(
	() => props.open,
	(isOpen) => {
		if (!modal) {
			return;
		}

		if (isOpen) {
			show();
		} else {
			modal.hide();
		}
	},
);

onMounted(() => {
	modal = new Modal(modalElement.value);
	modalElement.value.addEventListener("hide.bs.modal", handleHide);
	modalElement.value.addEventListener("hidden.bs.modal", handleHidden);

	if (props.open) {
		show();
	}
});

onBeforeUnmount(() => {
	modalElement.value?.removeEventListener("hide.bs.modal", handleHide);
	modalElement.value?.removeEventListener("hidden.bs.modal", handleHidden);
	modal?.dispose();
	modal = null;
});
</script>

<template>
	<Teleport to="body">
		<div ref="modalElement" class="modal fade" tabindex="-1" aria-labelledby="settings-title" aria-hidden="true">
			<div class="modal-dialog modal-lg modal-dialog-centered modal-dialog-scrollable settings-modal-dialog">
				<div class="modal-content">
					<div class="modal-header">
						<h1 id="settings-title" class="modal-title fs-6 d-flex align-items-center gap-2">
							<i class="mdi mdi-cog-outline" aria-hidden="true" />
							Settings
						</h1>
						<button class="btn-close" type="button" aria-label="Close" :disabled="saving" @click="close" />
					</div>

					<div class="modal-body p-0">
						<div class="settings-content">
							<nav class="settings-navigation nav nav-pills flex-column" role="tablist" aria-label="Settings sections">
								<button
									class="nav-link d-flex align-items-center gap-2 text-start"
									:class="{ active: activeSection === 'general' }"
									type="button"
									role="tab"
									:aria-selected="activeSection === 'general'"
									@click="activeSection = 'general'"
								>
									<i class="mdi mdi-tune-variant" aria-hidden="true" />
									General
								</button>
								<button
									class="nav-link d-flex align-items-center gap-2 text-start"
									:class="{ active: activeSection === 'editor' }"
									type="button"
									role="tab"
									:aria-selected="activeSection === 'editor'"
									@click="activeSection = 'editor'"
								>
									<i class="mdi mdi-file-document-edit-outline" aria-hidden="true" />
									Editor
								</button>
							</nav>

							<section class="settings-page" :aria-busy="loading">
								<div class="settings-panels">
									<section class="settings-panel" :class="{ 'is-active': activeSection === 'general' }" :aria-hidden="activeSection !== 'general'" :inert="activeSection !== 'general'">
										<h2 class="h6 mb-1">Appearance and locale</h2>
										<p class="text-body-secondary mb-3">Choose the color mode and date formatting used by the application.</p>

										<label class="form-label" for="appearance-theme"> Theme </label>
										<select id="appearance-theme" v-model="theme" class="form-select form-select-sm" @change="setThemePreference(theme)">
											<option value="system">System</option>
											<option value="dark">Dark</option>
											<option value="light">Light</option>
										</select>
										<div class="form-text">System follows the current OS appearance automatically.</div>

										<label class="form-label mt-3" for="appearance-locale"> Locale </label>
										<select id="appearance-locale" v-model="locale" class="form-select form-select-sm">
											<option value="">Default — DD.MM.YYYY HH:mm</option>
											<option value="ru-RU">Russian — ru-RU</option>
											<option value="en-GB">English — en-GB</option>
										</select>
										<div class="form-text">Locale-specific formats use the browser’s Intl date formatter.</div>

										<hr class="my-4" />

										<h2 class="h6 mb-1">File visibility</h2>
										<p class="text-body-secondary mb-4">Control which entries are hidden in both file panels.</p>

										<label class="form-label" for="hidden-name-suffixes"> Hidden name suffixes </label>
										<textarea
											id="hidden-name-suffixes"
											v-model="suffixesText"
											class="form-control form-control-sm font-monospace settings-textarea"
											rows="7"
											spellcheck="false"
											placeholder=".localized"
										/>
										<div class="form-text">One suffix per line. Matching is case-insensitive and applies to files and folders.</div>
									</section>

									<section class="settings-panel" :class="{ 'is-active': activeSection === 'editor' }" :aria-hidden="activeSection !== 'editor'" :inert="activeSection !== 'editor'">
										<h2 class="h6 mb-2">Editor appearance</h2>
                                        <label class="form-label" for="editor-theme">Theme</label>
                                        <select id="editor-theme" v-model="editorTheme" class="form-select form-select-sm">
                                            <option v-for="item in editorThemes" :key="item.id" :value="item.id">{{ item.name }}</option>
                                        </select>
                                        <div class="form-text">Applies to Monaco only. Themes are available offline.</div>
                                        <hr class="my-3" />
                                        <h2 class="h6 mb-2">Formatting</h2>
                                        <div class="row g-2 mb-3">
                                            <div v-for="item in formattingCheckboxes" :key="item.key" class="col-sm-6">
                                                <div class="form-check">
                                                    <input :id="`formatting-${item.key}`" v-model="formatting[item.key]" class="form-check-input" type="checkbox" />
                                                    <label class="form-check-label" :for="`formatting-${item.key}`">{{ item.label }}</label>
                                                </div>
                                            </div>
                                        </div>
                                        <div class="row g-2">
                                            <div class="col-sm-6">
                                                <label class="form-label" for="formatting-print-width">Print width</label>
                                                <input id="formatting-print-width" v-model.number="formatting.printWidth" class="form-control form-control-sm" type="number" min="40" max="300" step="1" />
                                            </div>
                                            <div class="col-sm-6">
                                                <label class="form-label" for="formatting-tab-width">Tab width</label>
                                                <input id="formatting-tab-width" v-model.number="formatting.tabWidth" class="form-control form-control-sm" type="number" min="1" max="8" step="1" />
                                            </div>
                                            <div class="col-sm-6">
                                                <label class="form-label" for="formatting-trailing-comma">Trailing commas</label>
                                                <select id="formatting-trailing-comma" v-model="formatting.trailingComma" class="form-select form-select-sm"><option value="all">All</option><option value="es5">ES5</option><option value="none">None</option></select>
                                            </div>
                                            <div class="col-sm-6">
                                                <label class="form-label" for="formatting-arrow-parens">Arrow parentheses</label>
                                                <select id="formatting-arrow-parens" v-model="formatting.arrowParens" class="form-select form-select-sm"><option value="always">Always</option><option value="avoid">Avoid</option></select>
                                            </div>
                                            <div class="col-sm-6">
                                                <label class="form-label" for="formatting-eol">End of line</label>
                                                <select id="formatting-eol" v-model="formatting.endOfLine" class="form-select form-select-sm"><option value="auto">Auto</option><option value="lf">LF</option><option value="crlf">CRLF</option><option value="cr">CR</option></select>
                                            </div>
                                        </div>
                                        <div class="form-text">Prettier options are independent of Monaco indentation controls. A formatting error cancels saving.</div>
                                        <hr class="my-3" />
                                        <h2 class="h6 mb-2">Editable files</h2>
                                        <label class="form-label" for="editable-files"> Editable files </label>
										<textarea
											id="editable-files"
											v-model="editableFilesText"
											class="form-control form-control-sm font-monospace settings-textarea"
											rows="9"
											spellcheck="false"
											placeholder=".js .ts .vue .env"
										/>
										<div class="form-text">Separate values with spaces, commas, or new lines. Extensions are case-insensitive; exact names such as Dockerfile are supported too.</div>
									</section>
								</div>

								<div class="alert alert-secondary d-flex align-items-start gap-2 mt-4 mb-0" role="status">
									<i class="mdi mdi-database-outline" aria-hidden="true" />
									<div class="min-w-0">
										<div>Stored locally as JSON</div>
										<code class="settings-storage-path">{{ storagePath }}</code>
									</div>
								</div>

								<div v-if="errorMessage" class="alert alert-danger d-flex align-items-center gap-2 mt-4 mb-0" role="alert">
									<i class="mdi mdi-alert-outline" aria-hidden="true" />
									{{ errorMessage }}
								</div>

								<div v-if="loading" class="settings-loading-overlay text-body-secondary">
									<span class="spinner-border spinner-border-sm" aria-hidden="true" />
									Loading settings…
								</div>
							</section>
						</div>
					</div>

					<div class="modal-footer justify-content-between">
						<button class="btn btn-sm btn-neutral" type="button" :disabled="loading || saving" @click="reset">Reset defaults</button>
						<div class="d-flex gap-2">
							<button class="btn btn-sm btn-neutral" type="button" :disabled="saving" @click="close">Cancel</button>
							<button class="btn btn-sm btn-primary" type="button" :disabled="loading || saving" @click="save">
								<span v-if="saving" class="spinner-border spinner-border-sm me-2" aria-hidden="true" />
								Save
							</button>
						</div>
					</div>
				</div>
			</div>
		</div>
	</Teleport>
</template>
