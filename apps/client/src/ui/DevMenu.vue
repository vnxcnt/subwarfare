<script setup lang="ts">
import { ROLE_DEVELOPER, VESSEL_MODELS } from '@subwarfare/shared';
import { computed, ref } from 'vue';
import { account } from '../state/auth';
import { devSetModel, hud } from '../state/hud';

/**
 * Entwicklermenü — geöffnet über den Build-Circle-Knopf in der Topbar.
 *
 * Der Knopf erscheint nur mit Entwicklerrolle, aber das ist Anzeige-Logik:
 * durchgesetzt wird die Rolle am Server (`dev:model`-Handler). Erste Funktion
 * ist die Wahl des eigenen Schiffsmodells; weitere Werkzeuge docken hier an.
 */
const open = ref(false);

export interface DevMenuApi {
  toggle: () => void;
}

defineExpose<DevMenuApi>({ toggle: () => (open.value = !open.value) });

const isDeveloper = computed(() => (account.value?.role ?? 0) >= ROLE_DEVELOPER);

const MODEL_LABELS: Record<string, string> = {
  fregatte01: 'Fregatte',
  yachtgun01: 'Kanonenyacht',
  submarine01: 'U-Boot',
  speedster01: 'Speedster',
};

function choose(model: (typeof VESSEL_MODELS)[number]): void {
  devSetModel(model);
}
</script>

<template>
  <section v-if="open && isDeveloper" class="hud__panel devmenu" aria-label="Entwicklermenü">
    <h2 class="hud__panel-title">Entwicklermenü</h2>

    <p class="devmenu__group">Eigenes Schiffsmodell</p>
    <ul class="devmenu__list">
      <li v-for="model in VESSEL_MODELS" :key="model">
        <button
          type="button"
          class="devmenu__model"
          :class="{ 'devmenu__model--active': hud.model === model }"
          @click="choose(model)"
        >
          <span>{{ MODEL_LABELS[model] ?? model }}</span>
          <code class="devmenu__id">{{ model }}</code>
        </button>
      </li>
    </ul>

    <p class="devmenu__hint">Wird hier später erweitert.</p>
  </section>
</template>

<style scoped>
.devmenu {
  width: 240px;
}

.devmenu__group {
  margin: 0 0 0.35rem;
  font-size: calc(0.6875rem * var(--ui-scale));
  text-transform: uppercase;
  letter-spacing: 0.1em;
  opacity: 0.55;
}

.devmenu__list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 0.3rem;
}

.devmenu__model {
  width: 100%;
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 0.5rem;
  padding: 0.4rem 0.55rem;
  border: 1px solid var(--ui-border);
  border-radius: 2px;
  background: none;
  color: var(--ui-text);
  font: inherit;
  font-size: calc(0.75rem * var(--ui-scale));
  text-align: left;
  cursor: pointer;
}

.devmenu__model:hover {
  background: rgb(111 208 189 / 10%);
}

.devmenu__model--active {
  border-color: var(--ui-accent);
  color: var(--ui-accent);
}

.devmenu__id {
  font-size: calc(0.625rem * var(--ui-scale));
  opacity: 0.5;
}

.devmenu__hint {
  margin: 0.6rem 0 0;
  opacity: 0.4;
  font-size: calc(0.6875rem * var(--ui-scale));
}
</style>
