<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { mapLabel } from '../config';
import { Game } from '../game/Game';
import { bindGame } from '../state/hud';
import { lastEndReason, takeSession } from '../state/lobby';
import HudOverlay from '../ui/HudOverlay.vue';
import LoadingScreen from '../ui/LoadingScreen.vue';

const router = useRouter();
const stage = ref<HTMLDivElement | null>(null);
const error = ref<string | null>(null);

/**
 * Ladeschirm. `ladenFertig` startet die Ausblendung, `ladenSichtbar` nimmt das
 * Element danach aus dem Baum — getrennt, weil eine CSS-Überblendung ein
 * Element braucht, das währenddessen noch da ist.
 */
const ladenSichtbar = ref(true);
const ladenFertig = ref(false);
const ladeStand = ref(0);
const ladeText = ref('Verbindung wird vorbereitet');
const kartenName = ref('');

/**
 * Notbremse: bleibt die Fertigmeldung aus (Spielserver schweigt, es kommt nie
 * ein Lagebericht), soll der Spieler trotzdem sehen, was los ist — ein ewiger
 * Ladeschirm ist schlimmer als ein leeres Meer mit Anzeige.
 */
const LADE_NOTBREMSE_MS = 25_000;
let notbremse: number | null = null;
let ausblendUhr: number | null = null;

let game: Game | null = null;

function ladenBeenden(): void {
  if (ladenFertig.value) return;
  ladeStand.value = 1;
  ladenFertig.value = true;
  if (notbremse !== null) window.clearTimeout(notbremse);
  notbremse = null;
  // Etwas länger als die CSS-Überblendung (0,45 s), damit sie sicher durch ist.
  ausblendUhr = window.setTimeout(() => {
    ladenSichtbar.value = false;
  }, 550);
}

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
  kartenName.value = mapLabel(session.mapId);

  notbremse = window.setTimeout(() => {
    console.warn('[client] Beitritt hat nicht fertig gemeldet — Ladeschirm wird geräumt.');
    ladenBeenden();
  }, LADE_NOTBREMSE_MS);

  try {
    game = new Game();
    await game.init(
      stage.value,
      {
        gameUrl: session.gameUrl,
        ticket: session.ticket,
        onEnded: (message) => {
          // Partie vorbei (Rauswurf, Verbindungsabriss): zurück ins Menü,
          // das den Grund einmalig anzeigt.
          lastEndReason.value = message;
          void router.replace({ name: 'menu' });
        },
        onExtracted: (coins) => {
          // Dasselbe Ende, nur ein gutes: das Menü zeigt die Meldung einmal an,
          // der frisch geladene Kontostand enthält die Coins bereits.
          lastEndReason.value =
            coins > 0
              ? `Extraktion erfolgreich — ${coins} Coins gesichert.`
              : 'Extraktion erfolgreich — Ausrüstung zurück im Lager.';
          void router.replace({ name: 'menu' });
        },
      },
      {
        onProgress: (fortschritt) => {
          ladeStand.value = fortschritt.value;
          ladeText.value = fortschritt.label;
        },
        // Feuert erst, wenn das erste Bild MIT Inhalt gezeichnet ist.
        onReady: ladenBeenden,
      },
    );
    // Ab hier schreibt der Pixi-Ticker den HUD-Zustand — es gibt bewusst keine
    // zweite Uhr mehr, die unabhängig vom Rendering liest.
    bindGame(game);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
    console.error('[client] PixiJS konnte nicht initialisiert werden:', cause);
    // Der Fehler steht im HUD — hinter dem Ladeschirm sähe ihn niemand.
    ladenBeenden();
  }
});

onBeforeUnmount(() => {
  if (notbremse !== null) window.clearTimeout(notbremse);
  if (ausblendUhr !== null) window.clearTimeout(ausblendUhr);
  bindGame(null);
  game?.destroy();
  game = null;
});
</script>

<template>
  <div class="play">
    <div ref="stage" class="play__stage"></div>
    <HudOverlay :error="error" />
    <!-- Zuletzt im Baum UND mit eigenem z-index: er deckt Canvas und HUD. -->
    <LoadingScreen
      v-if="ladenSichtbar"
      :progress="ladeStand"
      :label="ladeText"
      :map-name="kartenName"
      :done="ladenFertig"
    />
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
