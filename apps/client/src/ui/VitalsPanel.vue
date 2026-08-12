<script setup lang="ts">
import { isItemId, itemById } from '@subwarfare/shared';
import { computed } from 'vue';
import { hud } from '../state/hud';

/**
 * Rumpf und Panzerung — die beiden Zustände, die über das eigene Überleben
 * entscheiden. Steht oben rechts, wo der Blick beim Zielen ohnehin hinwandert.
 *
 * Beide Werte kommen aus dem `own`-Ereignis und damit direkt vom Server. Sie
 * gehen NUR an den Besitzer: wie angeschlagen oder wie gut gepanzert ein Gegner
 * ist, ist Aufklärung, keine Anzeige.
 */

/** Rumpfzustand 0..1. */
const hull = computed(() => {
  const anteil = hud.value.maxHp > 0 ? hud.value.hp / hud.value.maxHp : 1;
  return Math.min(Math.max(anteil, 0), 1);
});

/** Von Grün über Gelb nach Rot, je angeschlagener der Rumpf. */
const hullColor = computed(() => {
  const anteil = hull.value;
  if (anteil > 0.55) return '#6fd08c';
  if (anteil > 0.25) return '#e2c25a';
  return '#e2555a';
});

/**
 * Panzerung. `null` heißt ungepanzert — dann fehlt die Leiste ganz, statt 0 %
 * zu behaupten: das wäre von „aufgerissener Panzerung" nicht zu unterscheiden.
 */
const armor = computed(() => hud.value.armor);

/** Restintegrität 0..1 für die Leistenbreite. */
const armorAnteil = computed(() => {
  const wert = armor.value;
  if (!wert) return 0;
  return Math.min(Math.max(wert.percent / 100, 0), 1);
});

/**
 * Gelbton: voll ist warmes Messing, aufgerissen ein stumpfes Ocker. Bewusst
 * innerhalb DERSELBEN Farbfamilie — die Panzerung soll sich vom Rumpf
 * unterscheiden lassen, ohne dass ihre Restanzeige mit dessen Rot/Grün
 * verwechselt werden kann.
 */
const armorColor = computed(() => (armorAnteil.value > 0.35 ? '#e2c25a' : '#a8842e'));

/** Beschriftung aus dem Item-Katalog; sonst schlicht die Stufe. */
const armorLabel = computed(() => {
  const wert = armor.value;
  if (!wert) return '';
  return isItemId(wert.itemId) ? itemById(wert.itemId).name : `Panzerung Stufe ${wert.level}`;
});

/**
 * Stufe als römische Zahl — die Items heißen „Panzerung MK III", und das Kürzel
 * in der Leiste soll sich auf einen Blick als dasselbe lesen. Über V hinaus
 * (heute nicht vorgesehen) bleibt die Ziffer stehen, statt still zu raten.
 */
const ROEMISCH = ['', 'I', 'II', 'III', 'IV', 'V'];
const armorMark = computed(() => {
  const stufe = armor.value?.level ?? 0;
  return `MK ${ROEMISCH[stufe] ?? stufe}`;
});
</script>

<template>
  <section v-if="hud.ready" class="vitals" aria-label="Rumpf und Panzerung">
    <!-- Rumpfzustand — dieselbe Wahrheit, die der Server für Treffer führt. -->
    <div class="vitals__bar" aria-label="Rumpf">
      <span class="vitals__track">
        <span
          class="vitals__fill"
          :style="{ width: `${hull * 100}%`, background: hullColor }"
        ></span>
        <span class="vitals__num hud__num">{{ Math.round(hud.hp) }}</span>
      </span>
    </div>

    <!-- Panzerung: gleicher Rahmen, gleicher Aufbau, eigener Farbraum. -->
    <div v-if="armor" class="vitals__bar" :aria-label="armorLabel" :title="armorLabel">
      <span class="vitals__track">
        <span
          class="vitals__fill"
          :style="{ width: `${armorAnteil * 100}%`, background: armorColor }"
        ></span>
        <span class="vitals__num hud__num">
          <span class="vitals__mark">{{ armorMark }}</span>
          {{ Math.round(armor.percent) }} %
        </span>
      </span>
    </div>
  </section>
</template>

<style scoped>
.vitals {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 4px;
  width: min(260px, 34vw);
  /* Durchlässig bis auf die Leisten selbst — sonst finge eine unsichtbare
     Fläche in der oberen Ecke Fahrbefehle ab. */
  pointer-events: none;
}

/*
 * Leiste im health.png-Rahmen (9-Slice): die Ecken bleiben maßstäblich, nur die
 * Bänder dehnen sich. `fill` zieht die (transparente) Bildmitte als Hintergrund
 * mit — darunter liegt unser eigener dunkler Track.
 */
.vitals__bar {
  padding: 4px 6px;
  border: 14px solid transparent;
  border-image: url('../assets/ui/health.png') 70 fill / 14px 20px;
  /* VOLLE Füllung bis unter die Rahmenbänder (die sind halbtransparent).
     Der Radius zieht die Ecken der Füllung ein, damit sie nicht hinter den
     schrägen Eckbeschlägen des PNGs hervorblitzen — border-image selbst
     bleibt von border-radius unberührt. */
  background-color: #141310;
  border-radius: 10px;
  pointer-events: auto;
}

.vitals__track {
  position: relative;
  display: block;
  height: calc(16px * var(--ui-scale));
  background: rgb(7 14 20 / 90%);
  overflow: hidden;
}

.vitals__fill {
  position: absolute;
  inset: 0 auto 0 0;
  transition: width 0.25s ease-out;
}

/* Zahl zentriert IN der Leiste — mit Schattenkante, damit sie auf der hellen
   Füllung wie auf dem dunklen Rest lesbar bleibt. */
.vitals__num {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.4em;
  font-size: calc(0.75rem * var(--ui-scale));
  color: #eef4f8;
  text-shadow: 0 1px 2px rgb(0 0 0 / 85%);
}

/*
 * Die Stufe steht daneben, nicht darüber: welche Panzerung man trägt, ändert
 * sich im Einsatz nie — der Prozentwert dauernd. Deshalb kleiner, aber NICHT
 * ausgegraut: auf der hellen gelben Füllung verschwand ein Grauton bei 65 %
 * Deckkraft praktisch ganz (im Screenshot geprüft).
 */
.vitals__mark {
  font-size: calc(0.5625rem * var(--ui-scale));
  letter-spacing: 0.1em;
}

@media (max-width: 760px) {
  .vitals {
    width: min(190px, 44vw);
  }
}
</style>
