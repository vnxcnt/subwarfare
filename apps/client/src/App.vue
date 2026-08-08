<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { GAME_SERVER_URL } from './config';
import { Game } from './game/Game';

const stage = ref<HTMLDivElement | null>(null);
const error = ref<string | null>(null);
let game: Game | null = null;

onMounted(async () => {
  if (!stage.value) return;
  try {
    game = new Game();
    await game.init(stage.value);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
    console.error('[client] PixiJS konnte nicht initialisiert werden:', cause);
  }
});

onBeforeUnmount(() => {
  game?.destroy();
  game = null;
});
</script>

<template>
  <div class="app">
    <div ref="stage" class="app__stage"></div>

    <header class="hud">
      <span class="hud__title">Sub Warfare</span>
      <span class="hud__meta">{{ GAME_SERVER_URL }}</span>
    </header>

    <p v-if="error" class="app__error">Renderer-Fehler: {{ error }}</p>
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

.hud {
  position: absolute;
  top: 0;
  left: 0;
  display: flex;
  gap: 0.75rem;
  align-items: baseline;
  padding: 0.75rem 1rem;
  pointer-events: none;
  font-size: 0.8125rem;
  letter-spacing: 0.04em;
}

.hud__title {
  font-weight: 600;
  text-transform: uppercase;
}

.hud__meta {
  opacity: 0.5;
}

.app__error {
  position: absolute;
  inset: auto 1rem 1rem 1rem;
  margin: 0;
  padding: 0.75rem 1rem;
  border-left: 3px solid #e2555a;
  background: rgb(0 0 0 / 45%);
  font-size: 0.875rem;
}
</style>
