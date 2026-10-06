<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { filesystem } from "../api/filesystem.js";
import { createAddressNavigation } from "../utils/addressNavigation.js";
import { isComputerPath, isFilesystemRootEntry } from "../../shared/localFilesystem.js";
import { useFilesystem } from "../composables/useFilesystem.js";
import { useSettings } from "../composables/useSettings.js";
import { buildPathBreadcrumbs } from "../utils/pathBreadcrumbs.js";
import { getFilesystemPathName, getFilesystemParentPath } from "../utils/filesystemPath.js";
import { isSameOrDescendantPath } from "../utils/filesystemPath.js";
import { reconcileDirectorySelection } from "../utils/reconcileDirectorySelection.js";
import { selectFileEntries } from "../utils/fileSelection.js";
import FileTree from "./FileTree.vue";
import FolderPathMenu from "./FolderPathMenu.vue";
import SearchResults from "./SearchResults.vue";
import { useRecursiveSearch } from "../composables/useRecursiveSearch.js";
import { entryChange, relocatePath } from "../composables/useEntryChanges.js";
import { LOCAL_FILESYSTEM_PROVIDER } from "../api/filesystemLocation.js";
import { FILE_ENTRY_MIME, parseFileDragPayload } from "../utils/fileDrag.js";
import { fileDropKind } from "../utils/fileDrop.js";
import { externalFiles } from "../api/shellIntegration.js";
import { nativeDrag } from "../utils/nativeDragSession.js";
import { isPanelSwapHandle, restorePanelViewState } from "../utils/panelSwap.js";
import { availableExtensions, sortAndFilterEntries } from "../utils/fileDirectoryView.js";
import { reconcileFilteredSelection } from "../utils/reconcileFilteredSelection.js";
import { currentChildPath } from "../utils/folderMenu.js";

const props = defineProps({
	panelId: { type: String, required: true },
	initialViewState: { type: Object, default: null },
	side: {
		type: String,
		required: true,
		validator: (value) => ["left", "right"].includes(value),
	},
	active: {
		type: Boolean,
		default: false,
	},
	providerId: {
		type: String,
		default: LOCAL_FILESYSTEM_PROVIDER,
	},
	providerLabel: {
		type: String,
		default: "Local",
	},
	filesystemRevision: {
		type: Number,
		default: 0,
	},
	swapSource: {
		type: Boolean,
		default: false,
	},
	swapTarget: {
		type: Boolean,
		default: false,
	},
	watchActive: { type: Boolean, default: true },
});

const emit = defineEmits(["activate", "collapse", "drop-request", "open-file", "context-menu", "panel-drag-candidate", "state-change"]);
const { getRoot, listDirectory } = useFilesystem(() => props.providerId);
const { revision: settingsRevision } = useSettings();
const filesystemRoot = ref(null);
const homePath = ref("");
const root = ref(null);
const selectedNode = ref(null);
const selectedPath = ref("");
const selectedEntries = ref([]);
const selectionAnchorPath = ref("");
const expandedPaths = ref([]);
const scrollTop = ref(0);
const directoryView = ref({ name: "", extensions: [], keepFolders: true, sort: "name", direction: "asc" });
const rootEntries = ref([]);
const { search, results: searchResults, start: startSearch, cancel: cancelSearch, clear: clearSearch } = useRecursiveSearch();
const runSearch = () => startSearch({ providerId: props.providerId, basePath: search.scope === "root" ? filesystemRoot.value?.path : root.value?.path });
const closeSearch = async () => {
	clearSearch();
	await nextTick();
	if (panelContentRef.value) panelContentRef.value.scrollTop = scrollTop.value;
};
const openSearchResult = (node) => {
	if (node.isDirectory) {
		void closeSearch();
		openDirectory(node);
	} else openNode(node);
};
const revealSearchResult = (node) => {
	const parent = getFilesystemParentPath(node.path);
	void closeSearch();
	openDirectory({ name: getFilesystemPathName(parent), path: parent, type: "directory", isDirectory: true });
};
const filterMenuOpen = ref(false);
const filterButtonRef = ref(null);
const filterMenuRef = ref(null);
const filterMenuStyle = ref({});
const toggleFilterMenu = (event) => {
	filterMenuOpen.value = !filterMenuOpen.value;
	if (filterMenuOpen.value) {
		const rect = event.currentTarget.getBoundingClientRect();
		filterMenuStyle.value = { top: `${rect.bottom + 3}px`, left: `${Math.min(rect.left, window.innerWidth - 245)}px` };
	}
};
const closeFilterOnOutsidePointer = (event) => {
	if (!filterMenuOpen.value) return;
	if (filterButtonRef.value?.contains(event.target) || filterMenuRef.value?.contains(event.target)) return;
	filterMenuOpen.value = false;
};
const extensionChoices = computed(() => availableExtensions(rootEntries.value));
const filterActive = computed(() => Boolean(directoryView.value.name || directoryView.value.extensions.length));
const transformChildren = (entries, depth) => sortAndFilterEntries(entries, directoryView.value, depth);
const toggleSort = (sort) => {
	directoryView.value = { ...directoryView.value, sort, direction: directoryView.value.sort === sort && directoryView.value.direction === "asc" ? "desc" : "asc" };
};
const toggleExtension = (extension) => {
	const chosen = directoryView.value.extensions;
	directoryView.value = { ...directoryView.value, extensions: chosen.includes(extension) ? chosen.filter((value) => value !== extension) : [...chosen, extension] };
};
const clearFilters = () => {
	directoryView.value = { ...directoryView.value, name: "", extensions: [] };
};
const panelContentRef = ref(null);
let restoringScroll = false;
const renameRequest = ref(null);
let renameRequestSequence = 0;
const loading = ref(true);
const error = ref(null);
const breadcrumbsRef = ref(null);
const addressInput = ref(null);
const address = reactive({ editing: false, draft: "", busy: false, error: "" });
const addressNavigation = createAddressNavigation({
	state: address,
	getLocation: () => ({ providerId: props.providerId, path: root.value?.path }),
	resolve: filesystem.resolveLocation,
	navigate: (location) => openDirectory({ name: getFilesystemPathName(location.path), path: location.path, type: "directory", isDirectory: true }),
});
const editAddress = async () => {
	emit("activate");
	folderMenu.value = null;
	addressNavigation.edit();
	await nextTick();
	addressInput.value?.focus();
	addressInput.value?.select();
};
const rootDropTarget = ref(false);
const breadcrumbs = computed(() => buildPathBreadcrumbs(filesystemRoot.value, root.value?.path));
const selectedPaths = computed(() => selectedEntries.value.map((entry) => entry.path));
const panelState = computed(() => ({
	side: props.side,
	panelId: props.panelId,
	currentDirectory: root.value ? { ...root.value, providerId: props.providerId } : null,
	selected: selectedNode.value ? { ...selectedNode.value, providerId: props.providerId } : null,
	selectedEntries: search.open ? [] : selectedEntries.value.map((entry) => ({ ...entry, providerId: props.providerId })),
	canOperateSelected: Boolean(!search.open && selectedEntries.value.length > 0 && !selectedEntries.value.some(isFilesystemRootEntry)),
	viewState: {
		providerId: props.providerId,
		root: root.value,
		selectedNode: selectedNode.value,
		selectedEntries: selectedEntries.value,
		anchorPath: selectionAnchorPath.value,
		expandedPaths: expandedPaths.value,
		scrollTop: scrollTop.value,
		directoryView: directoryView.value,
		search: { open: search.open, query: search.query, type: search.type, scope: search.scope },
	},
}));

const restoreScroll = async () => {
	if (!restoringScroll) return;
	await nextTick();
	if (panelContentRef.value) panelContentRef.value.scrollTop = scrollTop.value;
};

const handlePanelScroll = (event) => {
	if (!search.open && !restoringScroll) scrollTop.value = event.target.scrollTop;
};

const stopScrollRestore = () => {
	restoringScroll = false;
	if (!search.open && panelContentRef.value) scrollTop.value = panelContentRef.value.scrollTop;
};

let rootGeneration = 0;
let panelDisposed = false;
const loadRoot = async () => {
	const generation = ++rootGeneration;
	const providerId = props.providerId;
	const initialPath = root.value?.path;
	loading.value = true;
	error.value = null;
	try {
		const response = await getRoot();
		if (panelDisposed || generation !== rootGeneration || providerId !== props.providerId || initialPath !== root.value?.path) return;
		if (!response?.ok) {
			error.value = response?.error || { message: "Unable to load filesystem root" };
			return;
		}
		filesystemRoot.value = response.root;
		homePath.value = response.homePath || "";
		const initial = response.initial || response.root;
		const view = restorePanelViewState(props.initialViewState, props.providerId, response.root, initial);
		root.value = view.root;
		selectedNode.value = view.selectedNode;
		selectedPath.value = selectedNode.value.path;
		selectedEntries.value = view.selectedEntries;
		selectionAnchorPath.value = view.anchorPath;
		expandedPaths.value = view.expandedPaths;
		scrollTop.value = view.scrollTop;
		directoryView.value = props.initialViewState?.providerId === props.providerId && props.initialViewState.directoryView ? { ...directoryView.value, ...props.initialViewState.directoryView } : directoryView.value;
		restoringScroll = view.restored;
		if (props.initialViewState?.providerId === props.providerId && props.initialViewState.search) {
			Object.assign(search, props.initialViewState.search);
			if (search.open && search.query.trim()) runSearch();
		}
		await restoreScroll();
	} catch (failure) {
		if (!panelDisposed && generation === rootGeneration) error.value = { message: failure.message || "Unable to load filesystem root" };
	} finally {
		if (!panelDisposed && generation === rootGeneration) loading.value = false;
	}
};

const visibleEntries = () =>
	Array.from(panelContentRef.value?.querySelectorAll(".tree-row[data-file-path]") || [])
		.filter((row) => row.getClientRects().length > 0)
		.map((row) => ({
			providerId: props.providerId,
			path: row.dataset.filePath,
			name: row.dataset.fileName,
			isDirectory: row.dataset.fileDirectory === "true",
		}));

const selectNode = (payload) => {
	const node = payload?.node || payload;
	if (!node) return;
	if (node.path === filesystemRoot.value?.path) {
		selectedEntries.value = [];
		selectionAnchorPath.value = "";
		selectedNode.value = node;
		selectedPath.value = node.path;
		return;
	}
	const clicked = { ...node, providerId: props.providerId };
	const next = selectFileEntries({
		entries: selectedEntries.value,
		anchorPath: selectionAnchorPath.value,
		clicked,
		visibleEntries: visibleEntries(),
		shiftKey: Boolean(payload?.shiftKey),
		additiveKey: Boolean(payload?.metaKey || payload?.ctrlKey),
	});
	selectedEntries.value = next.entries;
	selectionAnchorPath.value = next.anchorPath;
	selectedNode.value = next.active || root.value;
	selectedPath.value = selectedNode.value?.path || "";
};

const updateExpanded = ({ path, expanded }) => {
	expandedPaths.value = expanded ? [...new Set([...expandedPaths.value, path])] : expandedPaths.value.filter((value) => value !== path);
};

const reconcileSelection = ({ path, entries }) => {
	const next = reconcileDirectorySelection(
		{
			selectedEntries: selectedEntries.value,
			anchorPath: selectionAnchorPath.value,
			selectedNode: selectedNode.value,
			rootPath: root.value?.path,
			root: root.value,
		},
		path,
		entries,
		props.providerId,
	);
	selectedEntries.value = next.selectedEntries;
	selectionAnchorPath.value = next.anchorPath;
	selectedNode.value = next.selectedNode;
	selectedPath.value = next.selectedPath;
};
const pruneHiddenSelection = () => {
	if (!rootEntries.value.length) return;
	const next = reconcileFilteredSelection({ selectedEntries: selectedEntries.value, anchorPath: selectionAnchorPath.value }, rootEntries.value, directoryView.value);
	selectedEntries.value = next.selectedEntries;
	selectionAnchorPath.value = next.anchorPath;
	if (!selectedEntries.value.some((entry) => entry.path === selectedNode.value?.path)) {
		selectedNode.value = selectedEntries.value.at(-1) || root.value;
		selectedPath.value = selectedNode.value?.path || "";
	}
};
watch(
	directoryView,
	() => {
		pruneHiddenSelection();
	},
	{ deep: true },
);
const handleChildrenLoaded = (payload) => {
	if (payload.providerId !== props.providerId || !isSameOrDescendantPath(root.value?.path || "", payload.path)) return;
	if (payload.path === root.value?.path) rootEntries.value = payload.entries;
	reconcileSelection(payload);
	pruneHiddenSelection();
	void restoreScroll();
};

const removeSelectedPaths = (sources) => {
	const removed = sources.filter((source) => source.providerId === props.providerId);
	selectedEntries.value = selectedEntries.value.filter((entry) => !removed.some((source) => isSameOrDescendantPath(source.path, entry.path)));
	selectedNode.value = selectedEntries.value.at(-1) || root.value;
	selectedPath.value = selectedNode.value?.path || "";
	if (!selectedEntries.value.some((entry) => entry.path === selectionAnchorPath.value)) {
		selectionAnchorPath.value = selectedEntries.value[0]?.path || "";
	}
};

const requestRename = (node) => {
	if (!node) {
		return;
	}

	selectNode(node);
	renameRequest.value = {
		path: node.path,
		sequence: ++renameRequestSequence,
	};
};

const openDirectory = (node) => {
	if (!node?.isDirectory) {
		return;
	}

	clearSearch();
	filterMenuOpen.value = false;
	root.value = node;
	rootEntries.value = [];
	selectedNode.value = node;
	selectedPath.value = node.path;
	selectedEntries.value = [];
	selectionAnchorPath.value = "";
};

const openNode = (payload) => {
	const node = payload?.node || payload;

	if (node?.isDirectory) {
		openDirectory(node);
	} else if (node) {
		emit("open-file", {
			node,
			siblings: Array.isArray(payload?.siblings) ? payload.siblings : [node],
			filesystemId: props.providerId,
			sourcePane: props.side,
			sourceRootPath: root.value?.path,
			sourceRootName: root.value?.name,
			filesystemRoot: filesystemRoot.value,
			homePath: homePath.value,
		});
	}
};

const entryContext = (payload) => ({
	node: { ...payload.node, providerId: props.providerId },
	siblings: Array.isArray(payload.siblings) ? payload.siblings : [payload.node],
	filesystemId: props.providerId,
	sourcePane: props.side,
	sourceRootPath: root.value?.path,
	sourceRootName: root.value?.name,
	filesystemRoot: filesystemRoot.value,
	homePath: homePath.value,
});

const openEntryContextMenu = (payload) => {
	if (!search.open && !selectedEntries.value.some((entry) => entry.path === payload.node.path)) {
		selectNode(payload.node);
	}
	emit("context-menu", {
		...entryContext(payload),
		x: payload.x,
		y: payload.y,
	});
};

const isDirectoryDropTarget = (event) => Boolean(event.target?.closest?.("[data-directory-drop-target]"));

const clearRootDropTarget = () => {
	rootDropTarget.value = false;
};

const handlePanelDragOver = (event) => {
	if (!root.value?.isDirectory || isComputerPath(root.value.path) || !fileDropKind(event)) {
		clearRootDropTarget();
		return;
	}

	if (isDirectoryDropTarget(event)) {
		clearRootDropTarget();
		return;
	}

	event.preventDefault();
	event.dataTransfer.dropEffect = "copy";
	rootDropTarget.value = true;
};

const handlePanelDragLeave = (event) => {
	if (event.currentTarget.contains(event.relatedTarget)) {
		return;
	}

	clearRootDropTarget();
};

const handlePanelDrop = (event) => {
	clearRootDropTarget();
	const kind = fileDropKind(event);

	if (!root.value?.isDirectory || isComputerPath(root.value.path) || isDirectoryDropTarget(event) || !kind) {
		return;
	}

	event.preventDefault();
	event.stopPropagation();
	// Our own native drag is resolved by the native layer (native-drag:drop).
	if (kind === "native") return;
	const target = {
		providerId: props.providerId,
		path: root.value.path,
		name: root.value.name,
		isDirectory: true,
	};
	if (kind === "external") {
		emit("drop-request", {
			external: externalFiles.readDrop(event.dataTransfer),
			target,
			targetPanel: props.side,
			x: event.clientX,
			y: event.clientY,
		});
		return;
	}
	const source = parseFileDragPayload(event.dataTransfer.getData(FILE_ENTRY_MIME));

	if (!source || (source.providerId === props.providerId && source.path === root.value.path)) {
		return;
	}

	emit("drop-request", {
		source,
		target,
		targetPanel: props.side,
		x: event.clientX,
		y: event.clientY,
	});
};

// Right-click on empty panel space: Paste into the current folder.
const openBackgroundContextMenu = (event) => {
	if (search.open || !root.value?.isDirectory || isComputerPath(root.value.path)) return;
	if (event.target.closest?.(".tree-row, input, textarea, button, .dropdown-menu")) return;
	event.preventDefault();
	emit("activate");
	emit("context-menu", {
		...entryContext({ node: root.value, siblings: [] }),
		background: true,
		x: event.clientX,
		y: event.clientY,
	});
};

watch(
	() => nativeDrag.active,
	(active) => {
		if (!active) clearRootDropTarget();
	},
);

const navigateToBreadcrumb = (crumb) => {
	if (crumb.path === root.value?.path) {
		return;
	}

	openDirectory({
		name: crumb.name,
		path: crumb.path,
		type: "directory",
		isDirectory: true,
		isSymbolicLink: false,
	});
};

const folderMenu = ref(null);
let folderMenuSequence = 0;
const openFolderMenu = (event, crumb, index) => {
	const rect = event.currentTarget.getBoundingClientRect();
	folderMenu.value = {
		id: ++folderMenuSequence,
		path: crumb.path,
		name: crumb.name,
		anchor: { left: rect.left, bottom: rect.bottom },
		currentPath: currentChildPath(breadcrumbs.value, index),
	};
};
const selectMenuFolder = (folder) => {
	folderMenu.value = null;
	if (folder.path !== root.value?.path) openDirectory({ ...folder, type: "directory", isDirectory: true });
};

const handleHeaderPointerDown = (event) => {
	if (event.button !== 0 || !isPanelSwapHandle(event.target)) {
		return;
	}

	emit("panel-drag-candidate", {
		side: props.side,
		pointerId: event.pointerId,
		startX: event.clientX,
		startY: event.clientY,
	});
};

watch(
	() => root.value?.path,
	async () => {
		await nextTick();

		if (breadcrumbsRef.value) {
			breadcrumbsRef.value.scrollLeft = breadcrumbsRef.value.scrollWidth;
		}
	},
);

watch(
	() => props.providerId,
	() => {
		addressNavigation.cancel();
		cancelSearch();
		search.open = false;
		folderMenu.value = null;
		rootGeneration++;
		root.value = null;
		rootEntries.value = [];
		filesystemRoot.value = null;
		void loadRoot();
	},
);
watch(
	() => root.value?.path,
	() => {
		addressNavigation.cancel();
		folderMenu.value = null;
	},
);
watch(panelState, (state) => emit("state-change", state), { immediate: true, flush: "sync" });

onMounted(() => {
	loadRoot();
	window.addEventListener("dragend", clearRootDropTarget);
	window.addEventListener("drop", clearRootDropTarget);
	document.addEventListener("pointerdown", closeFilterOnOutsidePointer, true);
});

onBeforeUnmount(() => {
	panelDisposed = true;
	rootGeneration++;
	addressNavigation.dispose();
	window.removeEventListener("dragend", clearRootDropTarget);
	window.removeEventListener("drop", clearRootDropTarget);
	document.removeEventListener("pointerdown", closeFilterOnOutsidePointer, true);
});

const quickLookContext = () => ({
	node: selectedNode.value,
	siblings: visibleEntries(),
	filesystemId: props.providerId,
});
defineExpose({ openNode, requestRename, removeSelectedPaths, editAddress, quickLookContext, openDirectory, hasOpenMenu: () => Boolean(filterMenuOpen.value || folderMenu.value) });

watch(entryChange, (change) => {
	if (change?.action !== "rename" || change.providerId !== props.providerId) return;
	const relocateNode = (node) => {
		if (!node) return node;
		const path = relocatePath(node.path, change);
		return path === node.path ? node : { ...node, path, name: getFilesystemPathName(path) };
	};
	root.value = relocateNode(root.value);
	selectedNode.value = relocateNode(selectedNode.value);
	selectedPath.value = relocatePath(selectedPath.value, change);
	selectedEntries.value = selectedEntries.value.map(relocateNode);
	selectionAnchorPath.value = relocatePath(selectionAnchorPath.value, change);
	expandedPaths.value = expandedPaths.value.map((path) => relocatePath(path, change));
});
</script>

<template>
	<section
		class="file-panel"
		:class="{
			'is-active': active,
			'is-root-drop-target': rootDropTarget,
			'is-panel-swap-source': swapSource,
			'is-panel-swap-target': swapTarget,
		}"
		:aria-label="`${side} file panel`"
		:data-panel-side="side"
		:data-provider-id="providerId"
		:data-current-path="root?.isDirectory && !isComputerPath(root.path) ? root.path : undefined"
		:data-current-name="root?.name"
		@pointerdown="$emit('activate')"
		@dragover.capture="handlePanelDragOver"
		@dragleave="handlePanelDragLeave"
		@drop="handlePanelDrop"
	>
		<header class="panel-header" :data-panel-swap-target="side" @pointerdown="handleHeaderPointerDown">
			<div class="panel-title">
				<i class="mdi mdi-folder-multiple-outline" aria-hidden="true" />
				<strong>{{ side === "left" ? "Left" : "Right" }}</strong>
				<span class="badge text-bg-secondary panel-provider-label">{{ providerLabel }}</span>
				<nav v-if="breadcrumbs.length && !address.editing" ref="breadcrumbsRef" class="panel-breadcrumbs" :aria-label="`${side} panel path`">
					<template v-for="(crumb, index) in breadcrumbs" :key="crumb.path">
						<i v-if="index > 0" class="mdi mdi-chevron-right breadcrumb-separator" aria-hidden="true" />
						<button
							class="path-segment"
							:class="{ 'is-current': index === breadcrumbs.length - 1 }"
							:aria-current="index === breadcrumbs.length - 1 ? 'location' : undefined"
							type="button"
							:title="crumb.path"
							aria-haspopup="menu"
							:aria-expanded="folderMenu?.path === crumb.path"
							@click.stop="navigateToBreadcrumb(crumb)"
							@contextmenu.prevent.stop="openFolderMenu($event, crumb, index)"
						>
							{{ crumb.name }}
						</button>
					</template>
				</nav>
				<form v-else-if="address.editing" class="panel-address-form" @submit.prevent="addressNavigation.submit" @keydown.esc.prevent.stop="addressNavigation.cancel">
					<input
						ref="addressInput"
						v-model="address.draft"
						class="form-control form-control-sm"
						:aria-label="`${side} panel full path`"
						:aria-invalid="Boolean(address.error)"
						:aria-describedby="address.error ? `${panelId}-address-error` : undefined"
						:readonly="address.busy"
						autocomplete="off"
						spellcheck="false"
					/>
					<div class="panel-address-actions">
						<button class="compact-icon-button" type="submit" title="Open folder (Enter)" :aria-label="`Open the ${side} panel path`" :disabled="address.busy" @pointerdown.prevent>
							<i class="mdi" :class="address.busy ? 'mdi-loading mdi-spin' : 'mdi-check'" aria-hidden="true" />
						</button>
						<button class="compact-icon-button" type="button" title="Cancel (Esc)" :aria-label="`Cancel editing the ${side} panel path`" @pointerdown.prevent @click="addressNavigation.cancel">
							<i class="mdi mdi-close" aria-hidden="true" />
						</button>
					</div>
				</form>
				<span v-else class="panel-path">Loading…</span>
				<button v-if="root && !address.editing" class="compact-icon-button" type="button" title="Edit path (Ctrl/Cmd+L)" :aria-label="`Edit ${side} panel path`" @click.stop="editAddress">
					<i class="mdi mdi-form-textbox" aria-hidden="true" />
				</button>
				<FolderPathMenu v-if="folderMenu" :key="folderMenu.id" :request="folderMenu" :list-directory="listDirectory" @select="selectMenuFolder" @cancel="folderMenu = null" />
			</div>
			<button class="panel-action compact-icon-button" type="button" :aria-label="`Search ${side} panel`" title="Search files" @click.stop="search.open ? closeSearch() : (search.open = true)">
				<i class="mdi mdi-magnify" aria-hidden="true" />
			</button>
			<button class="panel-action compact-icon-button" type="button" :aria-label="`Hide ${side} panel`" :title="`Hide ${side} panel`" @click.stop="$emit('collapse')">
				<i class="mdi" :class="side === 'left' ? 'mdi-chevron-left' : 'mdi-chevron-right'" aria-hidden="true" />
			</button>
		</header>
		<div v-if="address.error" :id="`${panelId}-address-error`" class="alert alert-danger py-1 px-2 m-1 small" role="alert">{{ address.error }}</div>

		<form v-if="search.open" class="search-controls" role="search" @submit.prevent="runSearch" @keydown.esc.prevent="closeSearch">
			<input v-model="search.query" class="form-control form-control-sm" aria-label="Search file or path" placeholder="Search names and paths" @input="cancelSearch" />
			<select v-model="search.type" class="form-select form-select-sm" aria-label="Search type" @change="cancelSearch">
				<option value="all">All</option>
				<option value="files">Files</option>
				<option value="folders">Folders</option>
			</select>
			<select v-model="search.scope" class="form-select form-select-sm" aria-label="Search scope" @change="cancelSearch">
				<option value="current">Current folder</option>
				<option value="root">Provider root</option>
			</select>
			<button class="btn btn-sm btn-primary" type="submit" title="Start search"><i class="mdi mdi-magnify" aria-hidden="true" /></button>
			<button class="btn btn-sm btn-neutral" type="button" title="Close search" aria-label="Close search" @click="closeSearch"><i class="mdi mdi-close" aria-hidden="true" /></button>
		</form>
		<div ref="panelContentRef" class="panel-content" @contextmenu="openBackgroundContextMenu" @scroll="handlePanelScroll" @wheel.capture="stopScrollRestore" @touchstart.capture="stopScrollRestore">
			<div v-if="loading" class="panel-message">
				<i class="mdi mdi-loading mdi-spin" aria-hidden="true" />
				Reading root folder…
			</div>
			<div v-else-if="error" class="panel-message panel-message-error" role="alert">
				<i class="mdi mdi-alert-outline" aria-hidden="true" />
				<span>{{ error.message }}</span>
				<button class="btn btn-sm btn-outline-secondary" type="button" @click="loadRoot">Retry</button>
			</div>
			<div v-if="search.open" class="panel-search-results">
				<div class="search-status" role="status">
					{{ search.status === "searching" ? `Searching… ${searchResults.length} found` : search.error || (search.limited ? "10,000+ results — refine your search" : `${searchResults.length} results`) }}
				</div>
				<SearchResults :results="searchResults" @open="openSearchResult" @reveal="revealSearchResult" @context-menu="openEntryContextMenu({ ...$event, siblings: [$event.node] })" />
			</div>
			<div v-if="root" v-show="!search.open" class="tree-table">
				<div class="tree-columns-header">
					<div class="tree-column-name tree-column-heading">
						<button class="tree-column-sort" type="button" :aria-label="`Sort by name ${directoryView.direction === 'asc' ? 'descending' : 'ascending'}`" @click="toggleSort('name')">
							Name <i v-if="directoryView.sort === 'name'" class="mdi" :class="directoryView.direction === 'asc' ? 'mdi-arrow-up' : 'mdi-arrow-down'" aria-hidden="true" />
						</button>
						<button
							ref="filterButtonRef"
							class="tree-column-filter"
							:class="{ 'is-active': filterActive }"
							type="button"
							aria-label="Filter files"
							:aria-expanded="filterMenuOpen"
							@click="toggleFilterMenu($event)"
						>
							<i class="mdi mdi-filter-variant" aria-hidden="true" />
						</button>
						<Teleport to="body"
							><div v-if="filterMenuOpen" ref="filterMenuRef" class="dropdown-menu show tree-filter-menu" :style="filterMenuStyle" @keydown.esc.stop="filterMenuOpen = false">
								<input :id="`name-filter-${panelId}`" v-model="directoryView.name" class="form-control form-control-sm" placeholder="Name or *.ext" aria-label="Filter by name" />
								<div class="tree-filter-title">Extensions</div>
								<div class="tree-filter-extensions">
									<label v-for="extension in extensionChoices" :key="extension" class="dropdown-item tree-filter-choice">
										<input type="checkbox" :checked="directoryView.extensions.includes(extension)" @change="toggleExtension(extension)" />
										{{ extension || "Files without extension" }}
									</label>
									<span v-if="!extensionChoices.length" class="text-muted">No files in this folder</span>
								</div>
								<label class="dropdown-item tree-filter-choice"><input v-model="directoryView.keepFolders" type="checkbox" /> Keep folders visible</label>
								<div class="tree-filter-actions">
									<button class="btn btn-sm toolbar-button toolbar-command align-self-center" type="button" @click="directoryView.name = ''">Clear name</button
									><button class="btn btn-sm toolbar-button toolbar-command align-self-center" type="button" @click="clearFilters">Clear all filters</button>
								</div>
							</div></Teleport
						>
					</div>
					<div class="tree-column-size">
						<button class="tree-column-sort" type="button" @click="toggleSort('size')">
							Size <i v-if="directoryView.sort === 'size'" class="mdi" :class="directoryView.direction === 'asc' ? 'mdi-arrow-up' : 'mdi-arrow-down'" aria-hidden="true" />
						</button>
					</div>
					<div class="tree-column-date">
						<button class="tree-column-sort" type="button" @click="toggleSort('date')">
							Date <i v-if="directoryView.sort === 'date'" class="mdi" :class="directoryView.direction === 'asc' ? 'mdi-arrow-up' : 'mdi-arrow-down'" aria-hidden="true" />
						</button>
					</div>
				</div>
				<FileTree
					:key="`${providerId}:${root.path}:${settingsRevision}`"
					:root="root"
					:home-path="homePath"
					:provider-id="providerId"
					:panel-side="side"
					:selected-path="selectedPath"
					:selected-paths="selectedPaths"
					:selected-entries="selectedEntries"
					:expanded-paths="expandedPaths"
					:rename-request="renameRequest"
					:list-directory="listDirectory"
					:transform-children="transformChildren"
					:watch-active="watchActive"
					:refresh-revision="filesystemRevision"
					@select="selectNode"
					@open="openNode"
					@drop-request="$emit('drop-request', $event)"
					@context-menu="openEntryContextMenu"
					@expanded-change="updateExpanded"
					@children-loaded="handleChildrenLoaded"
				/>
			</div>
		</div>
	</section>
</template>

<style scoped lang="scss">
.panel-address-form {
	position: relative;
	input {
		font-family: monospace;
		height: auto;
		font-size: 0.75rem;
		// Room for the confirm/cancel buttons; focus comes from main/_forms.scss.
		padding: 0.15rem 3rem 0.15rem 0.5rem;
	}
}

.panel-address-actions {
	position: absolute;
	inset: 0 3px 0 auto;
	display: flex;
	align-items: center;
	gap: 1px;
	.compact-icon-button {
		width: 20px;
		height: 20px;
		flex-basis: 20px;
	}
}
</style>
