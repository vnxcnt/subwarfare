<script setup lang="ts">
import { computed } from 'vue';
import { hud, orderDive } from '../state/hud';

/**
 * Tauchsteuerung — erscheint nur, wenn das eigene Schiff laut Server-Katalog
 * tauchen kann (Typ Submarine). Der Knopf schickt die Absicht; Tiefe und
 * Übergang (5 s) rechnet der Server, die Anzeige folgt dem Broadcast.
 * Auch mitten im Übergang umkehrbar.
 */
const label = computed(() => (hud.value.diveTarget ? 'Auftauchen' : 'Abtauchen'));

/** Übergang läuft, solange Tiefe und Ziel nicht deckungsgleich sind. */
const inTransition = computed(() => {
  const ziel = hud.value.diveTarget ? 1 : 0;
  return Math.abs(hud.value.depth - ziel) > 0.001;
});

const depthPercent = computed(() => Math.round(hud.value.depth * 100));

function toggle(): void {
  orderDive(!hud.value.diveTarget);
}
</script>

<template>
  <section v-if="hud.canDive" class="hud__panel dive" aria-label="Tauchsteuerung">
    <h2 class="hud__panel-title">Tauchen</h2>

    <button class="dive__button" type="button" @click="toggle">{{ label }}</button>

    <div class="dive__gauge" :class="{ 'dive__gauge--active': inTransition }">
      <div class="dive__fill" :style="{ height: `${depthPercent}%` }"></div>
    </div>
    <p class="dive__depth hud__num">
      <template v-if="inTransition">{{ depthPercent }} %</template>
      <template v-else>{{ hud.depth > 0.5 ? 'getaucht' : 'aufgetaucht' }}</template>
    </p>
  </section>
</template>

<style scoped>
.dive {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.4rem;
  width: 92px;
}

.dive__button {
  width: 100%;
  padding: 0.4rem 0.3rem;
  border: 1px solid var(--ui-accent);
  border-radius: 2px;
  background: rgb(111 208 189 / 10%);
  color: var(--ui-accent);
  font: inherit;
  font-size: calc(0.6875rem * var(--ui-scale));
  letter-spacing: 0.06em;
  text-transform: uppercase;
  cursor: pointer;
}

.dive__button:hover {
  background: rgb(111 208 189 / 20%);
}

/* Tiefenanzeige: füllt sich von OBEN — das Boot sinkt ja hinab. */
.dive__gauge {
  width: 100%;
  height: 34px;
  border: 1px solid var(--ui-border);
  background: rgb(0 0 0 / 30%);
  overflow: hidden;
}

.dive__fill {
  width: 100%;
  background: linear-gradient(180deg, rgb(111 208 189 / 35%), rgb(20 60 82 / 85%));
  transition: height 120ms linear;
}

.dive__gauge--active {
  border-color: var(--ui-accent);
}

.dive__depth {
  margin: 0;
  font-size: calc(0.625rem * var(--ui-scale));
  opacity: 0.6;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
</style>
