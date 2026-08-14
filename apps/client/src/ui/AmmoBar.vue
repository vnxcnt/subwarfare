<script setup lang="ts">
import type { WeaponId } from '@subwarfare/shared';
import { DECOY, DEPTH_CHARGE, GUN, TUBE_LABELS } from '@subwarfare/shared';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import feuerUrl from '../assets/ui/button_fire.webp';
import bereitUrl from '../assets/ui/button_ready.webp';
import nachladenUrl from '../assets/ui/button_reload.webp';
import { WEAPON_SLOTS } from '../config';
import { hud, orderFire, orderTube } from '../state/hud';
import { keys, settingsModalOpen } from '../state/settings';
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
      /*
       * An Bord? Der Server schickt seit Protokoll 13 nur die Waffen, für die
       * in der Werft etwas eingelegt wurde. Der Rumpf FÜHRT die Waffe zwar
       * (das sagt `armament`), aber ohne Munition ist sie diesen Einsatz nicht
       * dabei — und dann soll sie auch nicht als leerer Slot herumstehen.
       */
      dabei: hud.value.ammo[id] !== undefined,
    }))
    .filter((eintrag) => eintrag.def !== undefined && eintrag.dabei),
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

/**
 * Restliche Kampfkraft an Bord? Ohne jeden Vorrat UND ohne geladenes oder
 * ladendes Rohr gibt es nichts zu feuern, nachzuladen oder zu wählen — dann
 * verschwindet die ganze Leiste statt leer herumzustehen. Ein geladenes Rohr
 * zählt auch bei Vorrat 0: genau das schießt noch.
 */
const einsatzbereit = computed(
  () =>
    slots.value.some((slot) => slot.count > 0) ||
    tubes.value.some((rohr) => rohr.status !== 'leer'),
);

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

/*
 * Nachlade-Anzeige. Der Server kennt die Feuerpausen und setzt sie durch —
 * der Client SIEHT einen Schuss aber nur als sinkenden Bestand im own-Payload.
 * Genau daran hängt die Anzeige: fällt der Vorrat einer Waffe, läuft ab da
 * ihre Feuerpause aus dem shared-Katalog. Reine Darstellung, selbstheilend —
 * verwirft der Server einen Schuss, sinkt nichts und nichts blockiert.
 * Der Torpedo fehlt bewusst: bei ihm erzählen die ROHRE das Nachladen.
 */
const FEUERPAUSE_SEKUNDEN: Partial<Record<string, number>> = {
  geschuetz: GUN.cooldownSeconds,
  wasserbombe: DEPTH_CHARGE.cooldownSeconds,
  taeuschkoerper: DECOY.cooldownSeconds,
};

const reloadUntil = ref<Partial<Record<string, number>>>({});
let prevAmmo: Record<string, number> = {};

watch(
  // Über den Inhalt statt die Identität: der HUD-Snapshot wird getriggert,
  // nicht ersetzt — Objektgleichheit sagt hier nichts über Änderungen.
  () => JSON.stringify(hud.value.ammo),
  () => {
    const ammo = hud.value.ammo;
    const aktuell: Record<string, number> = {};
    for (const [id, count] of Object.entries(ammo)) {
      if (count === undefined) continue;
      aktuell[id] = count;
      const vorher = prevAmmo[id];
      const pause = FEUERPAUSE_SEKUNDEN[id];
      if (pause !== undefined && vorher !== undefined && count < vorher) {
        reloadUntil.value = { ...reloadUntil.value, [id]: performance.now() + pause * 1000 };
      }
    }
    prevAmmo = aktuell;
  },
);

/**
 * Eigene kleine Uhr fürs Ablaufen der Pause: das HUD weckt Vue nur bei
 * Änderungen, und am ENDE der Feuerpause ändert sich sonst nichts — der Knopf
 * bliebe auf „Nachladen" stehen, bis irgendetwas anderes passiert.
 */
const jetzt = ref(performance.now());
let pausenUhr: number | null = null;

const nachladen = computed(() => {
  const waffe = active.value;
  if (!waffe || waffe.id === 'torpedo') return false;
  const bis = reloadUntil.value[waffe.id];
  return bis !== undefined && jetzt.value < bis;
});

/**
 * Der Feuerknopf als Zustands-Plakette:
 * - Torpedo bereit (Rohr scharf + geladen) → BEREIT, sonst → NACHLADEN.
 * - Andere Waffen: Feuerpause läuft → NACHLADEN, sonst mit Vorrat → FEUER.
 * - Ohne Vorrat bleibt NACHLADEN stehen, aber stumm (gesperrt) — der Slot
 *   daneben zeigt die Null.
 */
const knopf = computed(() => {
  const waffe = active.value;
  if (!waffe) return { bild: nachladenUrl, aktiv: false, label: 'Keine Waffe' };
  if (waffe.id === 'torpedo') {
    return ready.value
      ? { bild: bereitUrl, aktiv: true, label: 'Salve feuern' }
      : { bild: nachladenUrl, aktiv: false, label: 'Kein Rohr scharf und geladen' };
  }
  if (nachladen.value) return { bild: nachladenUrl, aktiv: false, label: 'Nachladen' };
  return ready.value
    ? { bild: feuerUrl, aktiv: true, label: `${waffe.def?.label ?? 'Waffe'} feuern` }
    : { bild: nachladenUrl, aktiv: false, label: 'Kein Vorrat' };
});

function choose(id: string): void {
  chosen.value = id;
}

function fire(): void {
  const waffe = active.value;
  if (waffe && knopf.value.aktiv) orderFire(waffe.id as WeaponId);
}

function onKey(event: KeyboardEvent): void {
  // Offene Einstellungen: die Leertaste aktiviert dort Dialog-Knöpfe — sie
  // darf dabei nicht nebenbei einen echten Torpedo abfeuern.
  if (isTextEntry(event.target) || settingsModalOpen.value) return;
  // Leiste ausgeblendet (nichts mehr an Bord): auch die Tasten schweigen.
  if (!einsatzbereit.value) return;

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

onMounted(() => {
  window.addEventListener('keydown', onKey);
  pausenUhr = window.setInterval(() => {
    // Nur ticken, wenn überhaupt eine Pause laufen kann — sonst schläft Vue.
    if (Object.keys(reloadUntil.value).length > 0) jetzt.value = performance.now();
  }, 120);
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey);
  if (pausenUhr !== null) window.clearInterval(pausenUhr);
});
</script>

<template>
  <section v-if="einsatzbereit" class="ammo" aria-label="Bewaffnung">
    <!-- Rumpf und Panzerung sitzen oben rechts (VitalsPanel), nicht mehr hier:
         der Gefechtsblock trägt jetzt Waffenwahl, Rohre und Feuerknopf. -->
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
        :disabled="!knopf.aktiv"
        :aria-label="knopf.label"
        :title="knopf.label"
        @click="fire"
      >
        <img :src="knopf.bild" alt="" draggable="false" />
      </button>
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

/* Die Plakette (FEUER/BEREIT/NACHLADEN) bringt Rahmen und Farbe selbst mit —
   der Knopf ist nur noch die Klickfläche. NACHLADEN bleibt bewusst voll
   sichtbar: es ist eine Statusanzeige, kein ausgegrauter Knopf. */
.ammo__fire {
  width: 100%;
  max-width: 212px;
  padding: 0;
  border: 0;
  background: none;
  cursor: pointer;
}

.ammo__fire img {
  display: block;
  width: 100%;
  height: auto;
  -webkit-user-drag: none;
}

.ammo__fire:hover:not(:disabled) img {
  filter: brightness(1.12);
}

.ammo__fire:disabled {
  cursor: default;
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
