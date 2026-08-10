<script setup lang="ts">
import { ROLE_DEVELOPER } from '@subwarfare/shared';
import { computed } from 'vue';
import { KNOTS } from '../config';
import { account } from '../state/auth';
import { hud } from '../state/hud';

const isDev = import.meta.env.DEV;
const isDeveloper = computed(() => (account.value?.role ?? 0) >= ROLE_DEVELOPER);

const emit = defineEmits<{ 'toggle-dev': [] }>();

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
</script>

<template>
  <header class="status">
    <span class="status__title">Sub Warfare</span>
    <span class="status__item">{{ hud.mapId }}</span>
    <span class="status__item hud__num">{{ position }}</span>
    <span class="status__item hud__num">{{ course }}</span>
    <span class="status__item hud__num">{{ speed }}</span>
    <span class="status__item hud__num">{{ hud.zoom.toFixed(2) }}×</span>
    <span class="status__chip" :class="{ 'status__chip--on': hud.following }">
      {{ hud.following ? 'Folgen an' : 'Folgen aus' }}
    </span>
    <span v-if="isDev" class="status__item hud__num">Neigung {{ tilt }}</span>
    <span class="status__hint">
      A/D steuern, W/S Telegraf, Rad zoomt, Ziehen verschiebt<template v-if="isDev">, [ ] neigt</template>
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

.status__hint {
  opacity: 0.4;
  margin-left: auto;
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
</style>
