<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { sunkUntil } from '../state/hud';

/**
 * Vollbild-Meldung nach der eigenen Versenkung, mit Countdown bis zum
 * Wiedereinstieg. Eigene Uhr per Intervall statt `hud.time`: nach dem
 * Untergang existiert kein eigenes Boot mehr, `writeHud` läuft nicht weiter —
 * die HUD-Uhr stünde still.
 */
const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  timer = setInterval(() => {
    now.value = Date.now();
  }, 200);
});
onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
});

const secondsLeft = computed(() => {
  if (sunkUntil.value === null) return null;
  return Math.max(0, Math.ceil((sunkUntil.value - now.value) / 1000));
});
</script>

<template>
  <div v-if="secondsLeft !== null" class="death">
    <div class="death__panel hud__panel">
      <span class="death__title">Versenkt!</span>
      <span v-if="secondsLeft > 0" class="death__sub">
        Wiedereinstieg in <span class="hud__num">{{ secondsLeft }}</span> s …
      </span>
      <span v-else class="death__sub">Neues Schiff läuft aus …</span>
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
