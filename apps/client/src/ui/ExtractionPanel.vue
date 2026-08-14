<script setup lang="ts">
import { EXTRACTION_SECONDS } from '@subwarfare/shared';
import { computed } from 'vue';
import { hud } from '../state/hud';

/**
 * Extraktionsfortschritt — sichtbar NUR in der Zone.
 *
 * Die acht Sekunden sind eine Verwundbarkeitsphase: man liegt vorhersagbar in
 * einem markierten Kreis. Der Balken muss deshalb groß und mittig stehen —
 * er ist in dem Moment die wichtigste Information auf dem Schirm.
 */
const sichtbar = computed(() => hud.value.ready && hud.value.extractionSeconds > 0);
const anteil = computed(() =>
  Math.min(hud.value.extractionSeconds / EXTRACTION_SECONDS, 1),
);
const rest = computed(() =>
  Math.max(EXTRACTION_SECONDS - hud.value.extractionSeconds, 0).toFixed(1),
);
</script>

<template>
  <div v-if="sichtbar" class="extraktion" aria-live="polite">
    <p class="extraktion__titel">Extraktion läuft</p>
    <div class="extraktion__balken">
      <span class="extraktion__fuellung" :style="{ width: `${anteil * 100}%` }"></span>
    </div>
    <p class="extraktion__rest hud__num">noch {{ rest }} s — im Kreis bleiben</p>
  </div>
</template>

<style scoped>
/* Gleicher Rahmen wie Auftragsbuch und U-Boot-Panel: quest-frame als
   9-Slice, dunkler Grund unter dem Rahmenbild. */
.extraktion {
  position: absolute;
  top: 18%;
  left: 50%;
  transform: translateX(-50%);
  box-sizing: border-box;
  width: min(22rem, 60vw);
  padding: 0.35rem 0.6rem 0.5rem;
  border: 24px solid transparent;
  border-image: url('../assets/ui/quest-frame.png') 50 / 24px stretch;
  background: #141310;
  text-align: center;
  pointer-events: none;
}

.extraktion__titel {
  margin: 0 0 0.45rem;
  font-size: calc(0.8125rem * var(--ui-scale));
  font-weight: 600;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: #fee584;
}

.extraktion__balken {
  position: relative;
  height: 6px;
  background: rgb(7 14 20 / 90%);
  border: 1px solid rgb(230 207 120 / 30%);
}

.extraktion__fuellung {
  position: absolute;
  inset: 0 auto 0 0;
  background: linear-gradient(90deg, #a8842e, #fee584);
  /* Schneller als die Server-Updates (4 Hz) — der Balken soll gleiten. */
  transition: width 0.25s linear;
}

.extraktion__rest {
  margin: 0.4rem 0 0;
  font-size: calc(0.6875rem * var(--ui-scale));
  letter-spacing: 0.06em;
  opacity: 0.8;
}
</style>
