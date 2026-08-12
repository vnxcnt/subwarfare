<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import eventIcon from '../assets/ui/log_event.png';
import localIcon from '../assets/ui/log_local.png';
import worldIcon from '../assets/ui/log_world.png';
import { logEntries } from '../state/hud';

/**
 * Ereignislog unten links, rechts neben dem Sonar.
 *
 * Bewusst TRANSPARENT — Lauftext über dem Wasser, kein Panel: das Log ist
 * Hintergrundrauschen, keine Anzeige, die um Aufmerksamkeit konkurriert.
 * Drei Kanäle, jeder mit seinem Icon vorweg: Welt (alle auf dem Server,
 * Versenkungen), Lokal (nur ich, geborgener Loot), Event (Platzhalter).
 *
 * Einträge altern: nach LEBENSDAUER Sekunden blenden sie aus und fallen aus
 * der Liste — ein Log, das sich selbst aufräumt, statt vollzulaufen.
 */
const ICONS = { welt: worldIcon, lokal: localIcon, event: eventIcon } as const;

/** Sekunden, die ein Eintrag voll sichtbar bleibt, plus 4 s Ausblendzeit. */
const LEBENSDAUER = 18;
const AUSBLENDEN = 4;

/*
 * Eigene langsame Uhr statt Frame-Takt: das Altern braucht Sekundengenauigkeit,
 * und ein setInterval pro Sekunde weckt Vue nur, wenn es Einträge gibt.
 */
const jetzt = ref(Date.now());
let uhr: number | null = null;
onMounted(() => {
  uhr = window.setInterval(() => {
    if (logEntries.value.length > 0) jetzt.value = Date.now();
  }, 1000);
});
onBeforeUnmount(() => {
  if (uhr !== null) window.clearInterval(uhr);
});

const sichtbare = computed(() =>
  logEntries.value
    .map((eintrag) => {
      const alter = (jetzt.value - eintrag.at) / 1000;
      const rest = LEBENSDAUER + AUSBLENDEN - alter;
      return { ...eintrag, opacity: Math.min(Math.max(rest / AUSBLENDEN, 0), 1) };
    })
    .filter((eintrag) => eintrag.opacity > 0),
);
</script>

<template>
  <ul v-if="sichtbare.length > 0" class="log" aria-label="Ereignisse" aria-live="polite">
    <li v-for="eintrag in sichtbare" :key="eintrag.id" class="log__zeile" :style="{ opacity: eintrag.opacity }">
      <img class="log__icon" :src="ICONS[eintrag.kind]" alt="" />
      <span class="log__text">{{ eintrag.text }}</span>
    </li>
  </ul>
</template>

<style scoped>
.log {
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  gap: 3px;
  margin: 0;
  padding: 0 0 4px;
  list-style: none;
  max-width: 22rem;
  /* Lauftext, kein Panel: Klicks gehen durch aufs Wasser. */
  pointer-events: none;
  user-select: none;
}

.log__zeile {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  transition: opacity 1s linear;
}

/* Die Icons sind 16 px hoch gebaut — nativ lassen, nicht skalieren. */
.log__icon {
  display: block;
  height: 16px;
  width: auto;
  filter: drop-shadow(0 1px 2px rgb(0 0 0 / 70%));
}

.log__text {
  font-size: calc(0.75rem * var(--ui-scale));
  letter-spacing: 0.03em;
  color: #dfe9f0;
  /* Doppelte Schattenkante: lesbar auf hellem Schaum wie auf dunkler See. */
  text-shadow:
    0 1px 2px rgb(0 0 0 / 85%),
    0 0 6px rgb(0 0 0 / 45%);
}
</style>
