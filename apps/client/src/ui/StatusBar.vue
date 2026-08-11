<script setup lang="ts">
import { ROLE_DEVELOPER } from '@subwarfare/shared';
import { computed } from 'vue';
import { KNOTS } from '../config';
import { account } from '../state/auth';
import { hud } from '../state/hud';
import { keyLabel, keys } from '../state/settings';

const isDev = import.meta.env.DEV;
const isDeveloper = computed(() => (account.value?.role ?? 0) >= ROLE_DEVELOPER);

const emit = defineEmits<{ 'toggle-dev': []; 'toggle-settings': [] }>();

const position = computed(() =>
  hud.value.ready ? `${Math.round(hud.value.x)} / ${Math.round(hud.value.y)}` : '—',
);
const course = computed(() =>
  hud.value.ready ? `${Math.round(hud.value.course).toString().padStart(3, '0')}°` : '—',
);
// In Knoten, nicht in m/s — „20 kn" liest sich als Schiff, „10 m/s" nicht.
const speed = computed(() =>
  hud.value.ready ? `${(hud.value.speed / KNOTS).toFixed(1)} kn` : '—',
);
const tilt = computed(
  () => `${hud.value.tilt.toFixed(2)} · ${((Math.asin(hud.value.tilt) * 180) / Math.PI).toFixed(0)}°`,
);

/**
 * Wetterlage in Seemannssprache: Bordzeit, Bewölkung, Seegang.
 * Der Seegang wird auf die vertraute 0–9-Skala gebracht, nicht als 0..1 gezeigt.
 */
const weather = computed(() => {
  const { weather: w, hour } = hud.value;
  const stunde = Math.floor(hour);
  const minute = Math.floor((hour - stunde) * 60);
  const uhr = `${String(stunde).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  const himmel =
    w.cloudCover < 0.2
      ? 'klar'
      : w.cloudCover < 0.5
        ? 'heiter'
        : w.cloudCover < 0.85
          ? 'bedeckt'
          : 'geschlossen';
  return `${uhr} · ${himmel} · Seegang ${Math.round(w.seaState * 9)}`;
});

/** Der Hinweistext folgt der tatsächlichen Belegung — nicht den Defaults. */
const keyHint = computed(
  () =>
    `${keyLabel(keys.value.steerLeft)}/${keyLabel(keys.value.steerRight)} steuern, ` +
    `${keyLabel(keys.value.telegraphUp)}/${keyLabel(keys.value.telegraphDown)} Telegraf, ` +
    'Rad zoomt, Ziehen verschiebt',
);
</script>

<template>
  <header class="status">
    <span class="status__title">Sub Warfare</span>
    <span class="status__item">{{ hud.mapId }}</span>
    <span class="status__item">{{ weather }}</span>
    <span class="status__item hud__num">{{ position }}</span>
    <span class="status__item hud__num">{{ course }}</span>
    <span class="status__item hud__num">{{ speed }}</span>
    <span class="status__item hud__num">{{ hud.zoom.toFixed(2) }}×</span>
    <span class="status__chip" :class="{ 'status__chip--on': hud.following }">
      {{ hud.following ? 'Folgen an' : 'Folgen aus' }}
    </span>
    <span v-if="isDev" class="status__item hud__num">Neigung {{ tilt }}</span>
    <!--
      Hinweis und Knöpfe in EINEM rechtsbündigen Block: der Hinweis wird auf
      schmalen Fenstern ausgeblendet, und ein verschwundenes Element trägt
      keinen auto-Margin mehr — die Knöpfe blieben sonst links hängen.
    -->
    <span class="status__right">
      <span class="status__hint">
        {{ keyHint }}<template v-if="isDev">, [ ] neigt</template>
      </span>
      <!--
        Entwicklerwerkzeuge — nur mit Entwicklerrolle sichtbar. Die Anzeige ist
        Höflichkeit; durchgesetzt wird die Rolle server-seitig am dev:model-Handler.
      -->
      <button
        v-if="isDeveloper"
        class="status__dev"
        type="button"
        title="Entwicklermenü"
        aria-label="Entwicklermenü"
        @click="emit('toggle-dev')"
      >
        <span class="material-symbols-outlined">build_circle</span>
      </button>
      <button
        class="status__dev"
        type="button"
        title="Einstellungen"
        aria-label="Einstellungen"
        @click="emit('toggle-settings')"
      >
        <span class="material-symbols-outlined">settings</span>
      </button>
    </span>
  </header>
</template>

<style scoped>
.status {
  display: flex;
  gap: 0.75rem;
  align-items: baseline;
  /* Eigener Innenabstand: `.hud-root` hat keinen mehr, damit der Hintergrund
     bis an die Fensterkanten reicht. */
  padding: 0.5rem 16px;
  background: #363738;
  font-size: calc(0.8125rem * var(--ui-scale));
  letter-spacing: 0.04em;
  text-shadow: 0 1px 3px rgb(0 0 0 / 60%);
}

.status__title {
  font-weight: 600;
  text-transform: uppercase;
}

.status__item {
  opacity: 0.75;
}

.status__chip {
  padding: 0.1rem 0.45rem;
  border: 1px solid currentcolor;
  border-radius: 2px;
  opacity: 0.35;
  font-size: calc(0.6875rem * var(--ui-scale));
  text-transform: uppercase;
}

.status__chip--on {
  color: var(--ui-accent);
  opacity: 0.85;
}

.status__right {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 0.6rem;
}

.status__hint {
  opacity: 0.4;
}

.status__dev {
  display: inline-flex;
  align-items: center;
  padding: 0;
  border: none;
  background: none;
  color: var(--ui-accent);
  cursor: pointer;
  opacity: 0.8;
  /* Selbst zentrieren statt an der Baseline hängen — das Icon hat keine. */
  align-self: center;
}

.status__dev:hover {
  opacity: 1;
}

.status__dev .material-symbols-outlined {
  font-size: 20px;
}

@media (max-width: 900px) {
  .status__hint {
    display: none;
  }
}

/* Sehr schmal: umbrechen statt abschneiden — das Zahnrad muss klickbar
   bleiben, sonst sind die Einstellungen im Spiel unerreichbar. */
@media (max-width: 640px) {
  .status {
    flex-wrap: wrap;
  }
}
</style>
