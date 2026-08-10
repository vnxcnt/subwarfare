<script setup lang="ts">
import { computed } from 'vue';
import { hud, orderPeriscope } from '../state/hud';

/**
 * Periskop-Steuerung — Zwilling der Tauchsteuerung (gleiches Muster, 3 s
 * Übergang statt 5). Erscheint nur bei tauchfähigen Booten; der Server prüft
 * den Befehl ohnehin selbst. Ausgefahren ersetzt es unter Wasser den
 * Sichtkreis durch den Sichtkegel in Fahrtrichtung.
 */
const label = computed(() => (hud.value.periscopeTarget ? 'Einfahren' : 'Ausfahren'));

const inTransition = computed(() => {
  const ziel = hud.value.periscopeTarget ? 1 : 0;
  return Math.abs(hud.value.periscope - ziel) > 0.001;
});

const percent = computed(() => Math.round(hud.value.periscope * 100));

function toggle(): void {
  orderPeriscope(!hud.value.periscopeTarget);
}
</script>

<template>
  <section v-if="hud.canDive" class="hud__panel scope" aria-label="Periskop">
    <h2 class="hud__panel-title">Periskop</h2>

    <button class="scope__button" type="button" @click="toggle">{{ label }}</button>

    <div class="scope__gauge" :class="{ 'scope__gauge--active': inTransition }">
      <div class="scope__fill" :style="{ height: `${percent}%` }"></div>
    </div>
    <p class="scope__state hud__num">
      <template v-if="inTransition">{{ percent }} %</template>
      <template v-else>{{ hud.periscope > 0.5 ? 'ausgefahren' : 'eingefahren' }}</template>
    </p>
  </section>
</template>

<style scoped>
.scope {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.4rem;
  width: 92px;
}

.scope__button {
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

.scope__button:hover {
  background: rgb(111 208 189 / 20%);
}

/* Füllt sich von UNTEN — das Periskop steigt aus dem Turm auf. */
.scope__gauge {
  width: 100%;
  height: 34px;
  border: 1px solid var(--ui-border);
  background: rgb(0 0 0 / 30%);
  overflow: hidden;
  display: flex;
  align-items: flex-end;
}

.scope__fill {
  width: 100%;
  background: linear-gradient(0deg, rgb(20 60 82 / 85%), rgb(111 208 189 / 35%));
  transition: height 120ms linear;
}

.scope__gauge--active {
  border-color: var(--ui-accent);
}

.scope__state {
  margin: 0;
  font-size: calc(0.625rem * var(--ui-scale));
  opacity: 0.6;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
</style>
