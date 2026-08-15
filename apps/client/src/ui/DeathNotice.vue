<script setup lang="ts">
import { sunk } from '../state/hud';

/**
 * Vollbild-Meldung nach der eigenen Versenkung. Seit Protokoll 19 ist die
 * Versenkung das RUNDENENDE: kein Countdown mehr — der Server trennt nach
 * ~1,5 s, dann landet der Spieler mit der End-Meldung im Hauptmenü.
 */
</script>

<template>
  <div v-if="sunk" class="death">
    <div class="death__panel hud__panel">
      <span class="death__title">Versenkt!</span>
      <span class="death__sub">Dein Schiff liegt beschädigt in der Werft.</span>
    </div>
  </div>
</template>

<style scoped>
.death {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  /* Über allem HUD — die Meldung ist in dem Moment das Wichtigste im Bild. */
  z-index: 30;
  background: radial-gradient(ellipse at center, rgb(40 8 8 / 35%), rgb(4 10 16 / 55%));
}

.death__panel {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.4rem;
  padding: 1.2rem 2.4rem;
  border-color: #e2555a;
}

.death__title {
  font-size: calc(1.6rem * var(--ui-scale));
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: #f4b3b5;
}

.death__sub {
  font-size: calc(0.8rem * var(--ui-scale));
  opacity: 0.85;
}
</style>
