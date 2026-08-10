<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue';
import { WEAPON_SLOTS } from '../config';
import { hud, orderFire } from '../state/hud';
import { isTextEntry } from './dom';

/**
 * Zeigt die Bewaffnung des EIGENEN Boots — welche Waffen das sind, sagt der
 * Server über den Schiffskatalog (ships-Tabelle), die Stückzahlen kommen live
 * aus dem `own`-Ereignis. Gefeuert wird über Absichts-Events; ob ein Schuss
 * wirklich fällt, entscheidet allein der Server (Munition, Rohr-Sperre).
 *
 * v1 feuert nur der Torpedo. Die übrigen Waffen zeigen ihre Platzhalterzahl
 * gedimmt, bis sie server-seitig existieren.
 */
const slots = computed(() =>
  hud.value.armament
    .map((id) => ({
      id,
      def: WEAPON_SLOTS[id],
      count: hud.value.ammo[id] ?? WEAPON_SLOTS[id]?.count ?? 0,
      fireable: id === 'torpedo',
    }))
    .filter((eintrag) => eintrag.def !== undefined),
);

/** Rumpfzustand für die schmale Leiste über den Slots. */
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

function fire(slot: { id: string; fireable: boolean; count: number }): void {
  if (!slot.fireable || slot.count <= 0) return;
  orderFire('torpedo');
}

/** Ziffern 1..n feuern den jeweiligen Slot, Leertaste den Torpedo. */
function onKey(event: KeyboardEvent): void {
  if (isTextEntry(event.target)) return;

  if (event.code === 'Space') {
    const torpedo = slots.value.find((slot) => slot.id === 'torpedo');
    if (torpedo) {
      fire(torpedo);
      event.preventDefault();
    }
    return;
  }

  const index = Number.parseInt(event.key, 10) - 1;
  if (Number.isInteger(index) && index >= 0 && index < slots.value.length) {
    const slot = slots.value[index];
    if (slot?.fireable) {
      fire(slot);
      event.preventDefault();
    }
  }
}

onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <section class="ammo" aria-label="Munition">
    <!-- Rumpfzustand — dieselbe Wahrheit, die der Server für Treffer führt. -->
    <div v-if="hud.ready" class="ammo__hull hud__panel" aria-label="Rumpf">
      <span class="ammo__hull-label">Rumpf</span>
      <span class="ammo__hull-track">
        <span
          class="ammo__hull-fill"
          :style="{ width: `${hull * 100}%`, background: hullColor }"
        ></span>
      </span>
      <span class="ammo__hull-num hud__num">{{ Math.round(hud.hp) }}</span>
    </div>

    <ul class="ammo__slots">
      <li
        v-for="(slot, index) in slots"
        :key="slot.id"
        class="hud__panel ammo__slot"
        :class="{
          'ammo__slot--armed': slot.fireable && slot.count > 0,
          'ammo__slot--empty': slot.fireable && slot.count <= 0,
        }"
        @click="fire(slot)"
      >
        <span class="ammo__key">{{ index + 1 }}</span>

        <img v-if="slot.def!.icon" class="ammo__icon" :src="slot.def!.icon" :alt="slot.def!.label" />
        <!-- Ohne Grafik das Kürzel, damit der Slot nicht leer dasteht. -->
        <span v-else class="ammo__icon ammo__short">{{ slot.def!.short }}</span>

        <span class="ammo__count hud__num">{{ slot.count }}</span>
        <span class="ammo__label">{{ slot.def!.label }}</span>
      </li>
    </ul>
  </section>
</template>

<style scoped>
/*
 * Der Container bleibt durchlässig — sonst finge ein unsichtbarer Streifen
 * mitten im Bild die Fahrbefehle ab. Nur die Kacheln selbst fangen Klicks
 * (über .hud__panel).
 */
.ammo {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  pointer-events: none;
}

.ammo__hull {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0.25rem 0.6rem;
  width: min(260px, 100%);
}

.ammo__hull-label {
  font-size: calc(0.5625rem * var(--ui-scale));
  opacity: 0.55;
}

.ammo__hull-track {
  flex: 1;
  height: 5px;
  border-radius: 3px;
  background: rgb(9 20 28 / 85%);
  overflow: hidden;
}

.ammo__hull-fill {
  display: block;
  height: 100%;
  border-radius: 3px;
  transition: width 0.25s ease-out;
}

.ammo__hull-num {
  font-size: calc(0.6875rem * var(--ui-scale));
  min-width: 2.2em;
  text-align: right;
}

.ammo__slots {
  /*
   * Flex-Zeile statt auto-fit-Grid: der Container ist eine zentrierende
   * Flex-Spalte, die Liste bekommt dadurch nur ihre Inhaltsbreite — ein
   * auto-fit-Raster kollabierte darin zu EINER Spalte (Kacheln stapelten
   * sich senkrecht durchs Bild).
   */
  display: flex;
  justify-content: center;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.ammo__slot {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
  width: 64px;
  padding: 0.4rem 0.25rem 0.3rem;
  opacity: 0.6;
}

/* Feuerbereite Waffe: voll sichtbar und als Knopf erkennbar. */
.ammo__slot--armed {
  opacity: 1;
  cursor: pointer;
}

.ammo__slot--armed:hover {
  outline: 1px solid rgb(207 230 242 / 45%);
}

.ammo__slot--empty {
  opacity: 0.35;
}

.ammo__key {
  position: absolute;
  top: 2px;
  left: 4px;
  font-size: calc(0.5625rem * var(--ui-scale));
  opacity: 0.45;
}

.ammo__icon {
  display: block;
  width: 100%;
  height: calc(30px * var(--ui-scale));
  object-fit: contain;
  /*
   * Heller Konturschimmer. Die Icons liegen in unterschiedlichen
   * Helligkeitsbereichen — der Torpedo hat gegen den Panel-Hintergrund nur rund
   * 1,8:1 Kontrast und verschwände sonst, während die Wasserbombe bei 11,5:1
   * liegt. Der Schimmer hebt dunkle Silhouetten an, ohne helle zu stören.
   */
  filter: drop-shadow(0 0 1px rgb(207 230 242 / 55%));
}

.ammo__short {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: calc(0.75rem * var(--ui-scale));
  letter-spacing: 0.1em;
  opacity: 0.45;
  filter: none;
}

.ammo__count {
  font-size: calc(1.0625rem * var(--ui-scale));
  line-height: 1.1;
  color: var(--ui-accent);
}

.ammo__label {
  font-size: calc(0.5625rem * var(--ui-scale));
  opacity: 0.4;
}

@media (max-width: 760px) {
  .ammo__slot {
    width: 44px;
  }

  .ammo__label {
    display: none;
  }
}
</style>
