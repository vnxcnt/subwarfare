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
    <!-- Sonarscheibe: reine CSS-Geometrie, keine Grafik. Sie dreht langsam
         weiter und macht den Bildschirm lebendig, ohne etwas nachzuladen. -->
    <div class="laden__sonar" aria-hidden="true">
      <span class="laden__strahl"></span>
    </div>

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
   * Das Hafenbild des Menüs liegt zu diesem Zeitpunkt IMMER schon im Cache —
   * auf die Karte kommt man nur über das Menü (ohne Ticket im Speicher schickt
   * die Ansicht zurück). Es kostet hier also nichts und macht aus dem schwarzen
   * Warteschirm einen Teil der Menüwelt. Der dunkle Schleier davor hält den
   * Text lesbar, der Verlauf darunter trägt den Bildschirm auch ohne Bild.
   */
  background:
    linear-gradient(rgb(2 10 16 / 82%), rgb(2 10 16 / 92%)),
    url('../assets/ui/menu-bg.webp') center / cover no-repeat,
    radial-gradient(ellipse at center, #0a2233 0%, #04141f 70%, #020a10 100%);
  color: #e9e2cd;
  /* Nach dem Ausblenden dürfen Klicks wieder ans Spiel. */
  transition: opacity 0.45s ease-out;
}

.laden--fertig {
  opacity: 0;
  pointer-events: none;
}

/*
 * Sonarscheibe hinter der Mitte. Sie liegt in der Schichtung UNTER dem Text
 * (kein z-index nötig: sie steht im Fluss davor und ist absolut positioniert)
 * und ist bewusst schwach — sie soll Stimmung machen, nicht ablenken.
 */
.laden__sonar {
  position: absolute;
  width: min(30rem, 62vh);
  aspect-ratio: 1;
  border-radius: 50%;
  border: 1px solid rgb(111 208 189 / 10%);
  background:
    radial-gradient(circle, transparent 0 34%, rgb(111 208 189 / 6%) 34% calc(34% + 1px), transparent calc(34% + 1px)),
    radial-gradient(circle, transparent 0 67%, rgb(111 208 189 / 6%) 67% calc(67% + 1px), transparent calc(67% + 1px));
  overflow: hidden;
}

.laden__strahl {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  /* Keilförmiger Nachlauf wie auf der Sonaranzeige. */
  background: conic-gradient(from 0deg, rgb(111 208 189 / 13%) 0deg, transparent 42deg);
  /* Zur Mitte hin ausgeblendet: ungemasked lief der helle Keil quer durch den
     Kartennamen und nahm der Schrift den Kontrast. Außen bleibt er kräftig.
     Mit Präfix für ältere WebKit-Fassungen — fehlt die Maske dort, ist der
     Keil eben durchgehend, kaputt ist nichts. */
  -webkit-mask-image: radial-gradient(circle, transparent 0 32%, #000 62%);
  mask-image: radial-gradient(circle, transparent 0 32%, #000 62%);
  animation: laden-sweep 4.5s linear infinite;
}

@keyframes laden-sweep {
  to {
    transform: rotate(360deg);
  }
}

/* Wer Bewegung nicht verträgt, bekommt den Strahl still — der Bildschirm
   funktioniert ohne ihn genauso. */
@media (prefers-reduced-motion: reduce) {
  .laden__strahl {
    animation: none;
  }
}

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
