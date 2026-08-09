<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { Game } from './game/Game';
import { bindGame } from './state/hud';
import HudOverlay from './ui/HudOverlay.vue';

const stage = ref<HTMLDivElement | null>(null);
const error = ref<string | null>(null);

let game: Game | null = null;

onMounted(async () => {
  if (!stage.value) return;
  try {
    game = new Game();
    await game.init(stage.value);
    // Ab hier schreibt der Pixi-Ticker den HUD-Zustand — es gibt bewusst keine
    // zweite Uhr mehr, die unabhängig vom Rendering liest.
    bindGame(game);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
    console.error('[client] PixiJS konnte nicht initialisiert werden:', cause);
  }
});

onBeforeUnmount(() => {
  bindGame(null);
  game?.destroy();
  game = null;
});
</script>

<template>
  <div class="app">
    <div ref="stage" class="app__stage"></div>
    <HudOverlay :error="error" />
  </div>
</template>

<style scoped>
.app {
  position: relative;
  width: 100%;
  height: 100%;
}

.app__stage {
  width: 100%;
  height: 100%;
}

.app__stage :deep(canvas) {
  display: block;
}
</style>
