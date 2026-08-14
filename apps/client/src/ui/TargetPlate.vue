<script setup lang="ts">
import { RANKS } from '@subwarfare/shared';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { hud, onFrame, selectionScreenPoint } from '../state/hud';
import { rankIconUrl } from './rankIcons';

/**
 * Namensschild des angeklickten Schiffs — Rang und Name, bewusst OHNE HP
 * (der genaue Zustand fremder Schiffe ist keine freie Aufklärung; sichtbar
 * ist nur der Rauch). Spieler zeigen ihren Dienstgrad aus dem Level, der
 * NPC-Verkehr eine Flottenbezeichnung.
 *
 * Die POSITION läuft über onFrame + worldToScreen direkt ins Style — das
 * Schild klebt damit bildgenau am Schiff, statt mit den 20 Hz der
 * Vue-Weckung hinterherzuruckeln. Vue rendert nur Ein-/Ausblenden und Text.
 */
const auswahl = computed(() => hud.value.selection);

const rang = computed(() => {
  const sel = auswahl.value;
  if (!sel) return '';
  if (sel.art === 'frachter') return 'Handelsmarine';
  if (sel.art === 'patrouille') return 'Patrouille';
  return RANKS[sel.level - 1] ?? 'Decksmann';
});

/** Rang-Abzeichen nur für Spieler — die Flotte trägt keins. */
const abzeichen = computed(() => {
  const sel = auswahl.value;
  return sel && sel.art === 'spieler' ? rankIconUrl(sel.level) : null;
});

const schild = ref<HTMLElement | null>(null);
let stopFrames: (() => void) | null = null;

onMounted(() => {
  stopFrames = onFrame(() => {
    const el = schild.value;
    if (!el) return;
    const punkt = selectionScreenPoint();
    if (!punkt) {
      el.style.opacity = '0';
      return;
    }
    el.style.opacity = '1';
    el.style.transform = `translate(${Math.round(punkt.x)}px, ${Math.round(punkt.y) + 40}px) translateX(-50%)`;
  });
});

onBeforeUnmount(() => stopFrames?.());
</script>

<template>
  <div v-if="auswahl" ref="schild" class="schild" aria-live="polite">
    <img v-if="abzeichen" class="schild__icon" :src="abzeichen" alt="" draggable="false" />
    <div class="schild__text">
      <span class="schild__rang">{{ rang }}</span>
      <span class="schild__name">{{ auswahl.name }}</span>
    </div>
  </div>
</template>

<style scoped>
/* Gleicher Rahmen wie Auftragsbuch, U-Boot- und Extraktions-Panel:
   quest-frame als 9-Slice, dunkler Grund unter dem Rahmenbild. */
.schild {
  position: absolute;
  top: 0;
  left: 0;
  box-sizing: border-box;
  display: flex;
  gap: 7px;
  align-items: center;
  padding: 1px 6px;
  border: 24px solid transparent;
  border-image: url('../assets/ui/quest-frame.png') 50 / 24px stretch;
  background: #141310;
  /* Nur Anzeige: Klicks gehen durchs Schild hindurch aufs Wasser. */
  pointer-events: none;
  opacity: 0;
  white-space: nowrap;
}

.schild__icon {
  width: 22px;
  height: auto;
  -webkit-user-drag: none;
}

.schild__text {
  display: flex;
  flex-direction: column;
  line-height: 1.25;
}

/* Das Gold der Extraktions-Anzeige — Dienstgrad gedeckt, Name leuchtend. */
.schild__rang {
  font-size: calc(0.625rem * var(--ui-scale));
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: #d6bf84;
}

.schild__name {
  font-size: calc(0.8125rem * var(--ui-scale));
  font-weight: 600;
  color: #fee584;
}
</style>
