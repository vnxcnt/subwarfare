<script setup lang="ts">
import type { WeaponId } from '@subwarfare/shared';
import { computed, onBeforeUnmount, onMounted } from 'vue';
import { WEAPON_SLOTS } from '../config';
import { hud, orderFire } from '../state/hud';
import { keys, settingsModalOpen } from '../state/settings';
import { isTextEntry } from './dom';

/**
 * Zeigt die Bewaffnung des EIGENEN Boots — welche Waffen das sind, sagt der
 * Server über den Schiffskatalog (ships-Tabelle), die Stückzahlen kommen live
 * aus dem `own`-Ereignis. Gefeuert wird über Absichts-Events; ob ein Schuss
 * wirklich fällt, entscheidet allein der Server (Munition, Rohr-Sperre).
 *
 * Feuerbar sind Torpedo und Täuschkörper. Die übrigen Waffen zeigen ihre
 * Platzhalterzahl gedimmt, bis sie server-seitig existieren.
 */
const FIREABLE = new Set(['torpedo', 'taeuschkoerper', 'geschuetz']);

const slots = computed(() =>
  hud.value.armament
    .map((id) => ({
      id,
      def: WEAPON_SLOTS[id],
      count: hud.value.ammo[id] ?? WEAPON_SLOTS[id]?.count ?? 0,
      fireable: FIREABLE.has(id),
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
  orderFire(slot.id as WeaponId);
}

/** Ziffern 1..n feuern den jeweiligen Slot, die Feuertaste den Torpedo. */
function onKey(event: KeyboardEvent): void {
  // Offene Einstellungen: die Leertaste aktiviert dort Dialog-Knöpfe — sie
  // darf dabei nicht nebenbei einen echten Torpedo abfeuern.
  if (isTextEntry(event.target) || settingsModalOpen.value) return;

  if (event.code === keys.value.fireTorpedo) {
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
    <div v-if="hud.ready" class="ammo__hull" aria-label="Rumpf">
      <span class="ammo__hull-track">
        <span
          class="ammo__hull-fill"
          :style="{ width: `${hull * 100}%`, background: hullColor }"
        ></span>
        <span class="ammo__hull-num hud__num">{{ Math.round(hud.hp) }}</span>
      </span>
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
  gap: 4px;
  pointer-events: none;
}

/*
 * Rumpfleiste im eigenen health.png-Rahmen (9-Slice): die Ecken bleiben
 * maßstäblich, nur die Bänder dehnen sich. `fill` zieht die (transparente)
 * Bildmitte als Hintergrund mit — darunter liegt unser eigener dunkler Track.
 */
.ammo__hull {
  width: min(300px, 100%);
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

.ammo__hull-track {
  position: relative;
  display: block;
  height: calc(16px * var(--ui-scale));
  background: rgb(7 14 20 / 90%);
  overflow: hidden;
}

.ammo__hull-fill {
  position: absolute;
  inset: 0 auto 0 0;
  transition: width 0.25s ease-out;
}

/* HP-Zahl zentriert IN der Leiste — mit Schattenkante, damit sie auf der
   grünen Füllung wie auf dem dunklen Rest lesbar bleibt. */
.ammo__hull-num {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: calc(0.75rem * var(--ui-scale));
  color: #eef4f8;
  text-shadow: 0 1px 2px rgb(0 0 0 / 85%);
}

/*
 * Munitionsblock im middlemenu.png-Rahmen (9-Slice, halbtransparente Mitte
 * als Hintergrund). Die Kacheln liegen als Flex-Zeile darin.
 */
.ammo__slots {
  display: flex;
  justify-content: center;
  gap: 8px;
  margin: 0;
  padding: 4px 6px;
  list-style: none;
  border: 18px solid transparent;
  border-image: url('../assets/ui/middlemenu.png') 90 fill / 18px 26px;
  /* Wie bei der Rumpfleiste: volle Füllung unterm Rahmen, Ecken eingezogen. */
  background-color: #141310;
  border-radius: 12px;
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
