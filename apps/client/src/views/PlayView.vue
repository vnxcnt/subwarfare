<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { Game } from '../game/Game';
import { bindGame } from '../state/hud';
import { lastEndReason, takeSession } from '../state/lobby';
import HudOverlay from '../ui/HudOverlay.vue';

const router = useRouter();
const stage = ref<HTMLDivElement | null>(null);
const error = ref<string | null>(null);

let game: Game | null = null;

onMounted(async () => {
  if (!stage.value) return;

  // Auf die Karte führt ausschließlich ein Ticket aus der Lobby. Der
  // Router-Guard stellt das eigentlich sicher — aber ein direkter
  // Navigationspfad ohne Ticket darf trotzdem nie mit leerer Karte enden.
  const session = takeSession();
  if (!session) {
    await router.replace({ name: 'menu' });
    return;
  }

  try {
    game = new Game();
    await game.init(stage.value, {
      gameUrl: session.gameUrl,
      ticket: session.ticket,
      onEnded: (message) => {
        // Partie vorbei (Rauswurf, Verbindungsabriss): zurück ins Menü,
        // das den Grund einmalig anzeigt.
        lastEndReason.value = message;
        void router.replace({ name: 'menu' });
      },
    });
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
  <div class="play">
    <div ref="stage" class="play__stage"></div>
    <HudOverlay :error="error" />
  </div>
</template>

<style scoped>
.play {
  position: relative;
  width: 100%;
  height: 100%;
}

.play__stage {
  width: 100%;
  height: 100%;
}

.play__stage :deep(canvas) {
  display: block;
}
</style>
