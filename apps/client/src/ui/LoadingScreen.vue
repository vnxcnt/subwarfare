<script setup lang="ts">
import { computed } from 'vue';

/**
 * Vollbild-Ladeschirm über der Karte.
 *
 * Er liegt ÜBER Canvas und HUD und verschwindet erst, wenn wirklich alles steht:
 * Grafiken geladen, Verbindung angemeldet, erster Lagebericht da und das erste
 * Bild gezeichnet. Vorher sah man das Gefecht sich zusammensetzen — Wasser,
 * dann Rahmen, dann Schiffe.
 *
 * Bewusst OHNE Rahmengrafik und ohne Hintergrundbild: dieser Bildschirm muss
 * sofort dastehen. Ein 9-Slice-Rahmen aus einer 538-kB-PNG wäre genau das
 * Nachladen, das er verhindern soll — also ist er ganz aus CSS gebaut.
 */
const props = defineProps<{
  /** 0..1 */
  progress: number;
  label: string;
  mapName: string;
  /** Blendet aus, sobald das Spiel steht — das Element bleibt kurz stehen. */
  done: boolean;
}>();

const prozent = computed(() => Math.round(Math.min(Math.max(props.progress, 0), 1) * 100));
</script>

<template>
  <div class="laden" :class="{ 'laden--fertig': done }" aria-live="polite">
    <div class="laden__mitte">
      <p class="laden__marke">Sub Warfare</p>
      <h1 class="laden__karte">{{ mapName }}</h1>

      <div class="laden__balken">
        <span class="laden__fuellung" :style="{ width: `${prozent}%` }"></span>
      </div>

      <p class="laden__zeile">
        <span class="laden__text">{{ label }}</span>
        <span class="laden__zahl">{{ prozent }} %</span>
      </p>
    </div>

    <p class="laden__hinweis">
      A/D steuern das Ruder · W/S den Telegrafen · Leertaste feuert
    </p>
  </div>
</template>

<style scoped>
.laden {
  position: absolute;
  inset: 0;
  z-index: 50;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2.5rem;
  /*
   * Deckend: hier darf NICHTS durchscheinen, sonst sieht man doch wieder das
   * halb aufgebaute Gefecht.
   *
   * Das eigene Ladebild (U-Boot im Abendlicht, 128 kB WebP) lädt parallel zu
   * den Spielgrafiken; bis es da ist, trägt der dunkle Verlauf darunter den
   * Bildschirm. Der Schleier davor ist bewusst MILD — das Bild soll wirken,
   * der Text bleibt lesbar, weil die Bildmitte ohnehin dunkel ist. Nach dem
   * ersten Einsatz kommt das Bild aus dem Cache.
   */
  background:
    linear-gradient(rgb(2 10 16 / 22%), rgb(2 10 16 / 45%)),
    url('../assets/ui/loading-bg.webp') center / cover no-repeat,
    radial-gradient(ellipse at center, #0a2233 0%, #04141f 70%, #020a10 100%);
  color: #e9e2cd;
  /* Nach dem Ausblenden dürfen Klicks wieder ans Spiel. */
  transition: opacity 0.45s ease-out;
}

.laden--fertig {
  opacity: 0;
  pointer-events: none;
}

/* Die frühere CSS-Sonarscheibe ist raus: über dem Ladebild las sie sich als
   Schlieren-Artefakt. Das Artwork trägt den Bildschirm jetzt allein. */
.laden__mitte {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  width: min(30rem, 78vw);
}

.laden__marke {
  margin: 0;
  font-size: calc(0.6875rem * var(--ui-scale));
  font-weight: 600;
  letter-spacing: 0.42em;
  text-transform: uppercase;
  /* Der Sperrsatz schiebt das letzte Zeichen nach rechts aus der Mitte —
     der halbe Wert holt die Zeile optisch zurück. */
  text-indent: 0.42em;
  color: #e6cf78;
  opacity: 0.7;
}

.laden__karte {
  margin: 0.35rem 0 1.6rem;
  font-size: calc(1.75rem * var(--ui-scale));
  font-weight: 500;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  text-indent: 0.16em;
  color: #fee584;
  text-shadow: 0 0 24px rgb(254 229 132 / 22%);
}

.laden__balken {
  position: relative;
  width: 100%;
  height: 6px;
  background: rgb(4 20 31 / 85%);
  border: 1px solid rgb(230 207 120 / 28%);
}

.laden__fuellung {
  position: absolute;
  inset: 0 auto 0 0;
  background: linear-gradient(90deg, #a8842e 0%, #e6cf78 60%, #fee584 100%);
  /* Etwas träger als die Meldungen: der Balken soll gleiten, nicht springen. */
  transition: width 0.3s ease-out;
}

.laden__zeile {
  display: flex;
  justify-content: space-between;
  width: 100%;
  margin: 0.6rem 0 0;
  font-size: calc(0.75rem * var(--ui-scale));
  letter-spacing: 0.08em;
}

.laden__text {
  opacity: 0.75;
}

.laden__zahl {
  font-variant-numeric: tabular-nums;
  color: #e6cf78;
}

.laden__hinweis {
  position: absolute;
  bottom: 2.5rem;
  margin: 0;
  font-size: calc(0.6875rem * var(--ui-scale));
  letter-spacing: 0.1em;
  opacity: 0.35;
}
</style>
