<script setup lang="ts">
import { wrapCoord } from '@subwarfare/shared';
import { computed } from 'vue';
import { currentMapInfo, hud } from '../state/hud';
import { minimapAlpha, setMinimapAlpha } from '../state/settings';

/**
 * Minimap als zentriertes Overlay (Taste M): die ganze Karte auf einen Blick,
 * mit Extraktionszonen und der eigenen Position samt Kurs.
 *
 * Die eigene Lage kommt aus dem HUD in RENDER-Koordinaten — auf der
 * Endlos-Karte können die jenseits der Naht liegen, deshalb werden sie für
 * die Kartenanzeige zurück in [0, Kante) gewrappt. Die Deckkraft ist eine
 * persönliche Einstellung und wandert in den localStorage.
 */
const karte = computed(() => currentMapInfo());

const eigene = computed(() => {
  const map = karte.value;
  if (!map || !hud.value.ready) return null;
  return {
    x: wrapCoord(hud.value.x, map.width),
    y: wrapCoord(hud.value.y, map.height),
    kurs: hud.value.course,
  };
});

/** Gitterlinien alle 5 km — Orientierung ohne Beschriftungslärm. */
const gitter = computed(() => {
  const map = karte.value;
  if (!map) return [];
  const linien: number[] = [];
  for (let schritt = 5000; schritt < map.width; schritt += 5000) linien.push(schritt);
  return linien;
});

function onAlpha(event: Event): void {
  setMinimapAlpha(Number((event.target as HTMLInputElement).value));
}

const emit = defineEmits<{ close: [] }>();
</script>

<template>
  <div class="minimap" role="dialog" aria-label="Karte" @click.self="emit('close')">
    <section class="minimap__panel" :style="{ opacity: minimapAlpha }">
      <header class="minimap__kopf">
        <h2 class="minimap__titel">{{ hud.mapId || 'Karte' }}</h2>
        <button type="button" class="minimap__zu" aria-label="Schließen" @click="emit('close')">
          ✕
        </button>
      </header>

      <svg
        v-if="karte"
        class="minimap__karte"
        :viewBox="`0 0 ${karte.width} ${karte.height}`"
        preserveAspectRatio="xMidYMid meet"
      >
        <rect x="0" y="0" :width="karte.width" :height="karte.height" fill="#0a2233" />
        <g stroke="#1c3d54" stroke-width="30">
          <line v-for="x in gitter" :key="`v${x}`" :x1="x" y1="0" :x2="x" :y2="karte.height" />
          <line v-for="y in gitter" :key="`h${y}`" x1="0" :y1="y" :x2="karte.width" :y2="y" />
        </g>
        <!-- Naht-Hinweis: die Karte ist endlos, der Rand nur eine Zeichengrenze. -->
        <rect
          x="0"
          y="0"
          :width="karte.width"
          :height="karte.height"
          fill="none"
          stroke="#2a5a7d"
          stroke-width="60"
          stroke-dasharray="400 300"
        />

        <!-- Extraktionszonen: echter Radius plus ein gut sichtbarer Ring. -->
        <g v-for="exit in karte.exits" :key="exit.id">
          <circle :cx="exit.x" :cy="exit.y" :r="exit.radius" fill="rgb(111 208 189 / 25%)" />
          <circle
            :cx="exit.x"
            :cy="exit.y"
            :r="Math.max(exit.radius, karte.width * 0.018)"
            fill="none"
            stroke="#6fd0bd"
            stroke-width="70"
          />
          <text
            :x="exit.x"
            :y="exit.y - karte.width * 0.028"
            text-anchor="middle"
            class="minimap__exitlabel"
          >
            EXTRAKT
          </text>
        </g>

        <!-- Eigene Position: Punkt plus Kursstrich. -->
        <g v-if="eigene">
          <line
            :x1="eigene.x"
            :y1="eigene.y"
            :x2="eigene.x + Math.sin((eigene.kurs * Math.PI) / 180) * karte.width * 0.035"
            :y2="eigene.y - Math.cos((eigene.kurs * Math.PI) / 180) * karte.width * 0.035"
            stroke="#e2c25a"
            stroke-width="90"
          />
          <circle :cx="eigene.x" :cy="eigene.y" :r="karte.width * 0.008" fill="#e2c25a" />
        </g>
      </svg>
      <p v-else class="minimap__leer">Karte noch nicht geladen.</p>

      <footer class="minimap__fuss">
        <label class="minimap__regler">
          <span>Transparenz</span>
          <input
            type="range"
            min="0.2"
            max="1"
            step="0.05"
            :value="minimapAlpha"
            @input="onAlpha"
          />
        </label>
        <span class="minimap__hinweis">M schließt</span>
      </footer>
    </section>
  </div>
</template>

<style scoped>
/* Abdunkelnder Schleier, Klick daneben schließt. */
.minimap {
  position: absolute;
  inset: 0;
  z-index: 40;
  display: grid;
  place-items: center;
  background: rgb(2 8 12 / 35%);
  pointer-events: auto;
}

/* Gleicher Rahmen wie Auftragsbuch und Instrumente. */
.minimap__panel {
  box-sizing: border-box;
  width: min(62vh, 82vw);
  padding: 2px 8px 6px;
  border: 24px solid transparent;
  border-image: url('../assets/ui/quest-frame.png') 50 / 24px stretch;
  background: #141310;
}

.minimap__kopf {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  padding: 0 2px 4px;
}

.minimap__titel {
  margin: 0;
  font-size: calc(0.6875rem * var(--ui-scale));
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  opacity: 0.7;
}

.minimap__zu {
  padding: 0 4px;
  border: 0;
  background: none;
  color: var(--ui-text);
  font: inherit;
  opacity: 0.55;
  cursor: pointer;
}

.minimap__zu:hover {
  opacity: 1;
}

.minimap__karte {
  display: block;
  width: 100%;
  aspect-ratio: 1;
}

.minimap__exitlabel {
  font-size: 560px;
  letter-spacing: 0.14em;
  fill: #6fd0bd;
}

.minimap__leer {
  margin: 2rem 0;
  text-align: center;
  opacity: 0.5;
}

.minimap__fuss {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
  padding: 6px 2px 0;
}

.minimap__regler {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: calc(0.6875rem * var(--ui-scale));
  opacity: 0.75;
}

.minimap__regler input {
  width: 9rem;
  accent-color: var(--ui-accent);
}

.minimap__hinweis {
  font-size: calc(0.625rem * var(--ui-scale));
  text-transform: uppercase;
  letter-spacing: 0.1em;
  opacity: 0.4;
}
</style>
