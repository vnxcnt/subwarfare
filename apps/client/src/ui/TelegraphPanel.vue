<script setup lang="ts">
import { TELEGRAPH_STANDARD } from '@subwarfare/shared';
import { computed, onBeforeUnmount, onMounted } from 'vue';
import { KNOTS } from '../config';
import { hud, nudgeTelegraph, orderTelegraph } from '../state/hud';
import { isTextEntry } from './dom';

/** Von unten nach oben anzeigen: Volle Kraft oben, Zurück unten. */
const rungs = computed(() =>
  TELEGRAPH_STANDARD.map((step, index) => ({ ...step, index })).reverse(),
);

const orderedKnots = computed(() => (hud.value.orderedSpeed / KNOTS).toFixed(1));
const actualKnots = computed(() => (hud.value.speed / KNOTS).toFixed(1));

/**
 * Wie weit die Ist-Fahrt der befohlenen nachhängt, als Anteil der Höchstfahrt.
 * Die sichtbare Lücke zwischen beiden Marken IST die Trägheit des Schiffs.
 */
const actualFraction = computed(() => hud.value.speed / hud.value.maxForward);
const orderedFraction = computed(() => hud.value.orderedSpeed / hud.value.maxForward);

function onWheel(event: WheelEvent): void {
  // Über dem Panel verstellt das Rad die Stufe statt die Karte zu zoomen.
  event.preventDefault();
  event.stopPropagation();
  nudgeTelegraph(event.deltaY < 0 ? 1 : -1);
}

function onKey(event: KeyboardEvent): void {
  if (isTextEntry(event.target)) return;

  const key = event.key.toLowerCase();
  if (key === 'w') nudgeTelegraph(event.shiftKey ? TELEGRAPH_STANDARD.length : 1);
  else if (key === 's') nudgeTelegraph(event.shiftKey ? -TELEGRAPH_STANDARD.length : -1);
  else if (key === 'x') orderTelegraph(3);
  else return;

  event.preventDefault();
}

onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <section class="hud__panel telegraph" aria-label="Maschinentelegraf" @wheel="onWheel">
    <h2 class="hud__panel-title">Maschinentelegraf</h2>

    <div class="telegraph__body">
      <ul class="telegraph__rungs">
        <li v-for="rung in rungs" :key="rung.index">
          <button
            type="button"
            class="telegraph__rung"
            :class="{
              'telegraph__rung--set': rung.index === hud.telegraphStep,
              'telegraph__rung--stop': rung.fraction === 0,
            }"
            :aria-pressed="rung.index === hud.telegraphStep"
            @click="orderTelegraph(rung.index)"
          >
            {{ rung.label }}
          </button>
        </li>
      </ul>

      <!-- Zwei Marken auf einer Achse: befohlen springt hart, ist läuft weich nach. -->
      <div class="telegraph__gauge" aria-hidden="true">
        <div class="telegraph__zero"></div>
        <div
          class="telegraph__lag"
          :style="{
            '--from': `${50 + Math.min(orderedFraction, actualFraction) * 50}%`,
            '--to': `${50 + Math.max(orderedFraction, actualFraction) * 50}%`,
          }"
        ></div>
        <div class="telegraph__ordered" :style="{ bottom: `${50 + orderedFraction * 50}%` }"></div>
        <div class="telegraph__actual" :style="{ bottom: `${50 + actualFraction * 50}%` }"></div>
      </div>
    </div>

    <p class="telegraph__readout hud__num">
      <span>befohlen {{ orderedKnots }} kn</span>
      <span class="telegraph__actual-text">ist {{ actualKnots }} kn</span>
    </p>
  </section>
</template>

<style scoped>
.telegraph {
  width: 168px;
}

.telegraph__body {
  display: flex;
  gap: 6px;
}

.telegraph__rungs {
  flex: 1;
  margin: 0;
  padding: 0;
  list-style: none;
}

.telegraph__rung {
  display: block;
  width: 100%;
  padding: 2px 5px;
  border: 0;
  border-left: 2px solid transparent;
  background: none;
  color: inherit;
  font: inherit;
  font-size: calc(0.6875rem * var(--ui-scale));
  text-align: left;
  opacity: 0.45;
  cursor: pointer;
}

.telegraph__rung:hover {
  opacity: 0.75;
  background: rgb(111 208 189 / 8%);
}

.telegraph__rung--stop {
  border-top: 1px solid var(--ui-border);
  border-bottom: 1px solid var(--ui-border);
}

.telegraph__rung--set {
  border-left-color: var(--ui-accent);
  background: rgb(111 208 189 / 14%);
  color: var(--ui-accent);
  opacity: 1;
}

.telegraph__gauge {
  position: relative;
  width: 10px;
  border: 1px solid var(--ui-border);
  border-radius: 1px;
}

.telegraph__zero {
  position: absolute;
  inset: auto 0 50% 0;
  border-bottom: 1px dashed var(--ui-border);
}

.telegraph__lag {
  position: absolute;
  left: 1px;
  right: 1px;
  bottom: var(--from);
  height: calc(var(--to) - var(--from));
  background: rgb(226 180 90 / 35%);
}

.telegraph__ordered,
.telegraph__actual {
  position: absolute;
  left: -2px;
  right: -2px;
  height: 2px;
}

.telegraph__ordered {
  background: var(--ui-accent);
}

.telegraph__actual {
  height: 1px;
  background: #e2b45a;
}

.telegraph__readout {
  display: flex;
  justify-content: space-between;
  gap: 0.5rem;
  margin: 0.4rem 0 0;
  font-size: calc(0.6875rem * var(--ui-scale));
  opacity: 0.6;
}

.telegraph__actual-text {
  color: #e2b45a;
}
</style>
