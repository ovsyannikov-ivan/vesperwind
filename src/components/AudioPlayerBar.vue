<script setup>
import { computed, ref, watch } from "vue";
import { trackLabel, mediaSourceLabel } from "../player/mediaSource.js";
import CustomMediaPlayer from "./CustomMediaPlayer.vue";
const props = defineProps({ audio: { type: Object, required: true }, expanded: { type: Boolean, default: false } });
const emit = defineEmits(["toggle-playlist"]);
const player = ref(null);
const playbackError = ref("");
const media = computed(() => props.audio.current.value);
const state = computed(() => props.audio.state);
const pause = () => {
	props.audio.state.autoplay = false;
	return player.value?.pause();
};
defineExpose({ pause });
watch(
	() => media.value?.id,
	() => {
		playbackError.value = "";
	},
);
watch(
	() => [media.value?.key, state.value.playRevision],
	async ([key], [previousKey]) => {
		// Only explicit replay of the same logical track drives the existing session.
		if (key === previousKey && player.value && media.value?.preparedSource && state.value.autoplay) await player.value.play();
	},
	{ flush: "post" },
);
const repeatTitle = computed(() => ({ off: "Repeat off", all: "Repeat all", one: "Repeat current track" })[state.value.repeat]);
</script>

<template>
	<section class="audio-player-bar" aria-label="Audio player">
		<i class="mdi mdi-music-circle-outline audio-player-icon" aria-hidden="true" />
		<div class="audio-player-details">
			<strong :title="media ? mediaSourceLabel(media) : undefined">{{ trackLabel(media) || "No track selected" }}</strong>
			<span v-if="media?.error || playbackError" class="text-danger" role="alert">{{ media?.error?.message || playbackError }}</span>
			<span v-else-if="media?.loading" class="text-body-secondary">Preparing file…</span>
			<span v-else class="text-body-secondary">{{ state.items.length }} {{ state.items.length === 1 ? "track" : "tracks" }}</span>
		</div>
		<div class="audio-track-controls">
			<button class="compact-icon-button" type="button" title="Previous track" aria-label="Previous track" :disabled="!audio.target(-1)" @click="audio.step(-1)">
				<i class="mdi mdi-skip-previous" aria-hidden="true" />
			</button>
			<button class="compact-icon-button" type="button" title="Next track" aria-label="Next track" :disabled="!audio.target(1)" @click="audio.step(1)"><i class="mdi mdi-skip-next" aria-hidden="true" /></button>
		</div>
		<CustomMediaPlayer
			v-if="media?.preparedSource"
			ref="player"
			:key="media.key"
			class="audio-player-control"
			kind="audio"
			:preserve-location-playback="true"
			:src="media.preparedSource"
			:source-type="media.sourceType"
			:source-url="media.url"
			:history-enabled="media.sourceType !== 'url'"
			:provider-id="media.providerId"
			:path="media.path"
			:autoplay="state.autoplay"
			@state="audio.acceptState(media.id, $event)"
			@ended="audio.ended($event)"
			@error="playbackError = 'This audio could not be played'"
		/>
		<div v-else class="audio-player-control audio-player-empty-controls">
			<span v-if="media?.loading" class="spinner-border spinner-border-sm" aria-label="Preparing audio" />
			<button v-else-if="media?.error" class="btn btn-sm btn-neutral" type="button" @click="audio.retry()">Retry</button>
			<button v-else-if="media" class="compact-icon-button" type="button" title="Play track" aria-label="Play track" @click="audio.play(media.id)"><i class="mdi mdi-play" aria-hidden="true" /></button>
		</div>
		<button
			class="compact-icon-button"
			:class="{ 'is-active': state.repeat !== 'off' }"
			type="button"
			:aria-pressed="state.repeat !== 'off'"
			:title="repeatTitle"
			:aria-label="repeatTitle"
			@click="audio.cycleRepeat()"
		>
			<i :class="['mdi', state.repeat === 'one' ? 'mdi-repeat-once' : 'mdi-repeat']" aria-hidden="true" />
		</button>
		<button class="compact-icon-button" :class="{ 'is-active': state.shuffle }" type="button" title="Shuffle" aria-label="Shuffle" :aria-pressed="state.shuffle" @click="audio.setShuffle(!state.shuffle)">
			<i class="mdi mdi-shuffle" aria-hidden="true" />
		</button>
		<button class="compact-button" :class="{ 'is-active': expanded }" type="button" title="Show or hide playlist" :aria-expanded="expanded" @click="emit('toggle-playlist')">
			<i class="mdi mdi-playlist-music" aria-hidden="true" /> Playlist
		</button>
		<button class="compact-icon-button audio-player-close" type="button" aria-label="Close audio player" title="Close audio player" @click="audio.hide()"><i class="mdi mdi-close" aria-hidden="true" /></button>
	</section>
</template>
