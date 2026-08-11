<script setup lang="ts">
import type { WeaponId } from '@subwarfare/shared';
import { TUBE_LABELS } from '@subwarfare/shared';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { WEAPON_SLOTS } from '../config';
import { hud, orderFire, orderTube } from '../state/hud';
import { keyLabel, keys, settingsModalOpen } from '../state/settings';
import { isTextEntry } from './dom';

/**
 * Gefechtsleiste: Rumpfzustand, Waffenwahl und Torpedorohre.
 *
 * Die Waffe wird GEWÄHLT (Ziffern 1..n oder Klick) und dann mit der Feuertaste
 * abgefeuert — statt wie früher jede Waffe auf ihrer eigenen Taste zu haben.
 * Das ist die Voraussetzung für die Rohr-Mechanik: der Torpedo ist kein
 * einzelner Schuss mehr, sondern eine Salve aus den Rohren, die man vorher
 * geladen und scharf geschaltet hat.
 *
 * Welche Waffen ein Schiff führt und wie viele Rohre es hat, sagt der Server.
 */
const slots = computed(() =>
  hud.value.armament
    .map((id) => ({
      id,
      def: WEAPON_SLOTS[id],
      count: hud.value.ammo[id] ?? 0,
    }))
    .filter((eintrag) => eintrag.def !== undefined),
);

/** Gewählte Waffe. Null heißt: noch keine Wahl getroffen. */
const chosen = ref<string | null>(null);

/**
 * Die tatsächlich gewählte Waffe — fällt auf die erste vorhandene zurück.
 * Nötig, weil sich die Bewaffnung mit dem Schiff ändern kann (Respawn,
 * Dev-Modellwechsel) und eine Wahl dann ins Leere zeigt.
 */
const active = computed(() => {
  const liste = slots.value;
  if (liste.length === 0) return null;
  const gewaehlt = liste.find((slot) => slot.id === chosen.value);
  return gewaehlt ?? liste[0]!;
});

const tubes = computed(() => hud.value.tubes);
/** Nur beim Torpedo ist das Rohr-Rack relevant. */
const showTubes = computed(() => tubes.value.length > 0 && active.value?.id === 'torpedo');

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

/**
 * Feuerbereit? Beim Torpedo zählt NICHT der Vorrat, sondern ob mindestens ein
 * Rohr scharf und geladen ist — genau das schießt.
 */
const ready = computed(() => {
  const waffe = active.value;
  if (!waffe) return false;
  if (waffe.id === 'torpedo') {
    return tubes.value.some((rohr) => rohr.armed && rohr.status === 'geladen');
  }
  return waffe.count > 0;
});

function choose(id: string): void {
  chosen.value = id;
}

function fire(): void {
  const waffe = active.value;
  if (waffe) orderFire(waffe.id as WeaponId);
}

/** Hinweiszeile unter der Leiste — folgt der tatsächlichen Belegung. */
const hint = computed(() => {
  const feuern = `${keyLabel(keys.value.fire)} feuern`;
  if (!showTubes.value) return feuern;
  return `${keyLabel(keys.value.loadTubes)} laden · ${keyLabel(keys.value.armTubes)} scharf · ${feuern}`;
});

function onKey(event: KeyboardEvent): void {
  // Offene Einstellungen: die Leertaste aktiviert dort Dialog-Knöpfe — sie
  // darf dabei nicht nebenbei einen echten Torpedo abfeuern.
  if (isTextEntry(event.target) || settingsModalOpen.value) return;

  if (event.code === keys.value.fire) {
    fire();
    event.preventDefault();
    return;
  }
  if (event.code === keys.value.loadTubes) {
    orderTube(-1, 'laden');
    event.preventDefault();
    return;
  }
  if (event.code === keys.value.armTubes) {
    orderTube(-1, 'scharf');
    event.preventDefault();
    return;
  }

  // Ziffern: erst die Waffen, danach die Rohre. Wer zwei Waffen und drei
  // Rohre hat, wählt also mit 1–2 die Waffe und schaltet mit 3–5 die Rohre.
  const ziffer = Number.parseInt(event.key, 10);
  if (!Number.isInteger(ziffer) || ziffer < 1) return;
  const index = ziffer - 1;
  if (index < slots.value.length) {
    choose(slots.value[index]!.id);
    event.preventDefault();
    return;
  }
  if (!showTubes.value) return;
  const rohr = index - slots.value.length;
  if (rohr < tubes.value.length) {
    toggleTube(rohr);
    event.preventDefault();
  }
}

/** Klick/Taste auf ein Rohr: geladen → scharf schalten, leer → nachladen. */
function toggleTube(index: number): void {
  const rohr = tubes.value[index];
  if (!rohr) return;
  if (rohr.status === 'leer') orderTube(index, 'laden');
  else if (rohr.status === 'geladen') orderTube(index, 'scharf', !rohr.armed);
}

/** Ziffer, die dieses Rohr schaltet — sie zählt hinter den Waffen weiter. */
function tubeKey(index: number): number {
  return slots.value.length + index + 1;
}

onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <section class="ammo" aria-label="Bewaffnung">
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

    <div class="ammo__block">
      <ul class="ammo__slots">
        <li
          v-for="(slot, index) in slots"
          :key="slot.id"
          class="ammo__slot"
          :class="{
            'ammo__slot--active': active?.id === slot.id,
            'ammo__slot--empty': slot.count <= 0 && slot.id !== 'torpedo',
          }"
          @click="choose(slot.id)"
        >
          <span class="ammo__key">{{ index + 1 }}</span>

          <img v-if="slot.def!.icon" class="ammo__icon" :src="slot.def!.icon" :alt="slot.def!.label" />
          <!-- Ohne Grafik das Kürzel, damit der Slot nicht leer dasteht. -->
          <span v-else class="ammo__icon ammo__short">{{ slot.def!.short }}</span>

          <span class="ammo__count hud__num">{{ slot.count }}</span>
          <span class="ammo__label">{{ slot.def!.label }}</span>
        </li>
      </ul>

      <!-- Rohr-Rack: nur beim Torpedo, und nur wenn das Schiff Rohre hat. -->
      <ul v-if="showTubes" class="ammo__tubes" aria-label="Torpedorohre">
        <li
          v-for="(tube, index) in tubes"
          :key="index"
          class="ammo__tube"
          :class="[`ammo__tube--${tube.status}`, { 'ammo__tube--armed': tube.armed }]"
          :title="tube.status === 'leer' ? 'Nachladen' : 'Scharf schalten'"
          @click="toggleTube(index)"
        >
          <span class="ammo__key">{{ tubeKey(index) }}</span>
          <span class="ammo__tube-pos">{{ TUBE_LABELS[tube.position] }}</span>
          <!-- Ladebalken füllt die Kachel von unten; bei „geladen" ist er voll. -->
          <span
            class="ammo__tube-fill"
            :style="{ height: `${(tube.status === 'geladen' ? 1 : tube.progress) * 100}%` }"
          ></span>
          <span class="ammo__tube-state">
            {{ tube.status === 'geladen' ? (tube.armed ? 'SCHARF' : 'BEREIT') : tube.status === 'laedt' ? 'LÄDT' : 'LEER' }}
          </span>
        </li>
      </ul>

      <button
        class="ammo__fire"
        type="button"
        :disabled="!ready"
        @click="fire"
      >
        {{ active?.def?.label ?? 'Feuern' }}
      </button>
      <p class="ammo__hint">{{ hint }}</p>
    </div>
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
 * Gefechtsblock im middlemenu.png-Rahmen (9-Slice, halbtransparente Mitte als
 * Hintergrund). Er trägt jetzt Waffenwahl, Rohre und Feuerknopf — deshalb ist
 * er deutlich höher als die alte reine Munitionszeile.
 */
.ammo__block {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border: 18px solid transparent;
  border-image: url('../assets/ui/middlemenu.png') 90 fill / 18px 26px;
  /* Wie bei der Rumpfleiste: volle Füllung unterm Rahmen, Ecken eingezogen. */
  background-color: #141310;
  border-radius: 12px;
  pointer-events: auto;
}

.ammo__slots {
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
  border: 1px solid transparent;
  opacity: 0.55;
  cursor: pointer;
}

.ammo__slot:hover {
  opacity: 0.85;
}

/* Gewählte Waffe: die feuert die Feuertaste. */
.ammo__slot--active {
  opacity: 1;
  border-color: rgb(111 208 189 / 55%);
  background: rgb(111 208 189 / 8%);
}

.ammo__slot--empty {
  opacity: 0.3;
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

/* --- Rohr-Rack ---------------------------------------------------------- */

.ammo__tubes {
  display: flex;
  justify-content: center;
  gap: 5px;
  margin: 0;
  padding: 5px 0 0;
  list-style: none;
  border-top: 1px solid rgb(207 230 242 / 12%);
  width: 100%;
}

.ammo__tube {
  position: relative;
  width: 46px;
  height: calc(40px * var(--ui-scale));
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: space-between;
  padding: 3px 2px;
  border: 1px solid rgb(207 230 242 / 25%);
  background: rgb(7 14 20 / 80%);
  overflow: hidden;
  cursor: pointer;
}

/* Der Ladestand liegt HINTER der Beschriftung — deshalb ein eigener Layer
   statt eines Hintergrund-Verlaufs auf der Kachel selbst. */
.ammo__tube-fill {
  position: absolute;
  inset: auto 0 0 0;
  background: rgb(111 208 189 / 18%);
  transition: height 0.2s linear;
  pointer-events: none;
}

.ammo__tube-pos,
.ammo__tube-state {
  position: relative;
  font-size: calc(0.5rem * var(--ui-scale));
  letter-spacing: 0.08em;
}

.ammo__tube-pos {
  opacity: 0.55;
}

.ammo__tube-state {
  opacity: 0.75;
}

.ammo__tube--geladen {
  border-color: rgb(111 208 189 / 55%);
}

/* Scharf: das ist der Zustand, der bei der nächsten Salve wirklich feuert —
   er muss auf einen Blick vom bloß geladenen Rohr zu unterscheiden sein. */
.ammo__tube--armed {
  border-color: #e2c25a;
  box-shadow: inset 0 0 0 1px rgb(226 194 90 / 45%);
}

.ammo__tube--armed .ammo__tube-state {
  color: #e2c25a;
  opacity: 1;
}

.ammo__tube--leer {
  opacity: 0.45;
}

/* --- Feuerknopf und Hinweis --------------------------------------------- */

.ammo__fire {
  width: 100%;
  padding: 0.3rem 0.6rem;
  border: 1px solid rgb(111 208 189 / 45%);
  background: rgb(111 208 189 / 10%);
  color: var(--ui-accent);
  font: inherit;
  font-size: calc(0.6875rem * var(--ui-scale));
  letter-spacing: 0.1em;
  text-transform: uppercase;
  cursor: pointer;
}

.ammo__fire:hover:not(:disabled) {
  background: rgb(111 208 189 / 20%);
}

.ammo__fire:disabled {
  opacity: 0.35;
  cursor: default;
}

.ammo__hint {
  margin: 0;
  font-size: calc(0.5625rem * var(--ui-scale));
  opacity: 0.4;
}

@media (max-width: 760px) {
  .ammo__slot {
    width: 44px;
  }

  .ammo__label,
  .ammo__hint {
    display: none;
  }
}
</style>
