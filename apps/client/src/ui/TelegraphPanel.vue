<script setup lang="ts">
import { TELEGRAPH_STANDARD } from '@subwarfare/shared';
import { computed, onBeforeUnmount, onMounted } from 'vue';
import nadelUrl from '../assets/ui/ui_compass_needle.webp';
import kompassUrl from '../assets/ui/ui_compass.webp';
import hebelUrl from '../assets/ui/ui_mt_lever.webp';
import blattUrl from '../assets/ui/ui_mt.webp';
import { KNOTS } from '../config';
import { hud, nudgeTelegraph, orderTelegraph } from '../state/hud';
import { keys, settingsModalOpen } from '../state/settings';
import { isTextEntry } from './dom';

/**
 * Maschinentelegraf als echtes Instrument: das Telegrafenblatt (ui_mt) mit
 * einem Hebel (ui_mt_lever), der auf die befohlene Stufe schwenkt, daneben
 * ein Kompass mit drehender Windrose.
 *
 * Die Hebelwinkel sind gegen die Grafik KALIBRIERT (Bildschirmprobe aller neun
 * Stellungen), nicht errechnet — die Sektoren des Blatts sind ungleich breit.
 * Index = Stufe in TELEGRAPH_STANDARD, 0° = Hebel senkrecht nach oben.
 */
const WINKEL = [-107, -68, -33, -6, 27, 57, 88, 120, 152] as const;

/**
 * Drehpunkt des Hebels, per Alpha-Schwerpunkt aus der Grafik gemessen
 * (49.6/233.3 im 100×286-Original) und auf die Anzeigegröße gerechnet:
 * Blatt 300→150 px (×0.5), Hebel ×0.62 relativ zum Blatt → ×0.31.
 */
const hebelWinkel = computed(() => WINKEL[hud.value.telegraphStep] ?? WINKEL[3]);

const stufe = computed(() => TELEGRAPH_STANDARD[hud.value.telegraphStep]?.label ?? '');
const orderedKnots = computed(() => (hud.value.orderedSpeed / KNOTS).toFixed(1));
const actualKnots = computed(() => (hud.value.speed / KNOTS).toFixed(1));

/**
 * Kurs kommt in Grad (0 = Nord, rechtsdrehend). Das Kompassblatt steht fest
 * (N oben, Gradskala aufgedruckt) — die NADEL dreht MIT dem Kurs, ihre rote
 * Spitze zeigt den Kurs also direkt auf der Skala an.
 */
const kurs = computed(() => hud.value.course);
const kursText = computed(() => {
  const grad = Math.round(((kurs.value % 360) + 360) % 360) % 360;
  return `${String(grad).padStart(3, '0')}°`;
});

/**
 * Klick aufs Blatt befiehlt die Stufe, deren Hebelstellung der Klickrichtung
 * am nächsten liegt — dieselbe Geste wie am echten Telegrafen.
 */
function onDialClick(event: MouseEvent): void {
  const ziel = event.currentTarget as HTMLElement;
  const box = ziel.getBoundingClientRect();
  // Nabe des Blatts: waagerecht mittig, senkrecht bei 148/297 der Grafik.
  const dx = event.clientX - (box.left + box.width * 0.5);
  const dy = event.clientY - (box.top + box.height * (148 / 297));
  const richtung = (Math.atan2(dx, -dy) * 180) / Math.PI;

  let bester = 0;
  for (let i = 1; i < WINKEL.length; i += 1) {
    if (Math.abs(richtung - WINKEL[i]!) < Math.abs(richtung - WINKEL[bester]!)) bester = i;
  }
  orderTelegraph(bester);
}

function onWheel(event: WheelEvent): void {
  // Über dem Panel verstellt das Rad die Stufe statt die Karte zu zoomen.
  event.preventDefault();
  event.stopPropagation();
  nudgeTelegraph(event.deltaY < 0 ? 1 : -1);
}

function onKey(event: KeyboardEvent): void {
  if (isTextEntry(event.target) || settingsModalOpen.value) return;

  // Belegung aus den Einstellungen — `code` statt `key`, damit die Bindung an
  // der physischen Taste hängt und Shift die Bedeutung nicht verändert.
  if (event.code === keys.value.telegraphUp) {
    nudgeTelegraph(event.shiftKey ? TELEGRAPH_STANDARD.length : 1);
  } else if (event.code === keys.value.telegraphDown) {
    nudgeTelegraph(event.shiftKey ? -TELEGRAPH_STANDARD.length : -1);
  } else if (event.code === keys.value.telegraphStop) {
    orderTelegraph(3);
  } else return;

  event.preventDefault();
}

onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <section class="hud__panel mt" aria-label="Maschinentelegraf und Kompass" @wheel="onWheel">
    <div class="mt__instrumente">
      <div class="mt__instrument">
        <button type="button" class="mt__telegraf" :aria-label="`Maschinentelegraf: ${stufe}`" :title="stufe" @click="onDialClick">
          <img class="mt__blatt" :src="blattUrl" alt="" draggable="false" />
          <img
            class="mt__hebel"
            :src="hebelUrl"
            alt=""
            draggable="false"
            :style="{ transform: `rotate(${hebelWinkel}deg)` }"
          />
        </button>
        <p class="mt__wert hud__num">
          <span>befohlen {{ orderedKnots }} kn</span>
          <span class="mt__ist">ist {{ actualKnots }} kn</span>
        </p>
      </div>

      <div class="mt__instrument">
        <div class="mt__kompass" role="img" :aria-label="`Kompass: Kurs ${kursText}`">
          <img class="mt__kompass-blatt" :src="kompassUrl" alt="" draggable="false" />
          <img
            class="mt__kompass-nadel"
            :src="nadelUrl"
            alt=""
            draggable="false"
            :style="{ transform: `rotate(${kurs}deg)` }"
          />
        </div>
        <p class="mt__wert hud__num">Kurs {{ kursText }}</p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.mt__instrumente {
  display: flex;
  gap: 12px;
  /* Beide Zifferblätter auf einer Unterkante, die Wertzeilen darunter bündig. */
  align-items: flex-end;
}

.mt__instrument {
  display: flex;
  flex-direction: column;
  gap: 3px;
  align-items: center;
}

/* Gleiche Anzeige-Skala wie das Telegrafenblatt (×0.5) — die Grafiken sind
   als Paar gezeichnet, beide 300 px breit. */
.mt__kompass {
  position: relative;
  width: 150px;
  filter: drop-shadow(0 2px 4px rgb(0 0 0 / 40%));
}

.mt__kompass-blatt {
  display: block;
  width: 100%;
  height: auto;
  -webkit-user-drag: none;
}

/*
 * Die Nadel sitzt mit dem Zentrum ihres Nabenlochs (99.5/178.5 im Original,
 * per Alpha-Profil gemessen) auf der Messing-Kappe des Blatts (149.1/140.8).
 * Nadel ×0.62 relativ zum Blatt (kalibrierte Bildprobe) → ×0.31 der Anzeige.
 * KEINE Transition: der Kurs läuft im Frame-Takt herein, die Nadel folgt
 * direkt — eine Transition würde nur nachziehen und beim 360°-Umbruch lügen.
 */
.mt__kompass-nadel {
  position: absolute;
  top: 15.1px;
  left: 43.8px;
  width: 62px;
  height: auto;
  transform-origin: 30.8px 55.3px;
  pointer-events: none;
  -webkit-user-drag: none;
  filter: drop-shadow(0 2px 3px rgb(0 0 0 / 45%));
}

.mt__telegraf {
  position: relative;
  display: block;
  width: 150px;
  padding: 0;
  border: 0;
  background: none;
  cursor: pointer;
  filter: drop-shadow(0 2px 4px rgb(0 0 0 / 40%));
}

.mt__blatt {
  display: block;
  width: 100%;
  height: auto;
  -webkit-user-drag: none;
}

/*
 * Der Hebel sitzt mit seinem gemessenen Drehpunkt exakt auf der Nabe des
 * Blatts (75/74 bei 150 px Anzeigebreite). Die Werte sind Pixel, weil die
 * Grafiken Raster sind — skaliert das Blatt, müssen sie mitziehen.
 */
.mt__hebel {
  position: absolute;
  top: 1.7px;
  left: 59.6px;
  width: 31px;
  height: auto;
  transform-origin: 15.4px 72.3px;
  /* Leichtes Überschwingen: der Hebel wird geworfen, nicht geschoben. */
  transition: transform 0.35s cubic-bezier(0.3, 1.35, 0.55, 1);
  pointer-events: none;
  -webkit-user-drag: none;
  filter: drop-shadow(0 2px 3px rgb(0 0 0 / 45%));
}

.mt__wert {
  display: flex;
  gap: 0.5rem;
  margin: 0;
  font-size: calc(0.6875rem * var(--ui-scale));
  opacity: 0.6;
}

.mt__ist {
  color: #e2b45a;
}
</style>
