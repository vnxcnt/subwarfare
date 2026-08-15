<script setup lang="ts">
import type { ItemCategory, ItemDefinition, ItemId, PlayableModel, WerftShip } from '@subwarfare/shared';
import {
  CATEGORY_LABELS,
  DEFAULT_SHIP_STATS,
  ITEMS,
  equipSlotsForArmament,
  isItemId,
  isPlayableModel,
  itemById,
} from '@subwarfare/shared';
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { mapLabel } from '../../config';
import {
  economyBusy,
  economyError,
  equip,
  equippedEntry,
  equippedItem,
  ownedQuantity,
} from '../../state/economy';
import {
  joinQueue,
  leaveQueue,
  menuNotice,
  queueError,
  queuePosition,
  queueState,
} from '../../state/lobby';
import { mapStatus } from '../../state/maps';
import { refreshWerft, werftLoaded, werftShips } from '../../state/werft';
import { itemIconUrl } from '../itemIcons';
import { SHIP_LABELS } from './shipLabels';

/**
 * Auslaufen: der Weg aufs Wasser — Einsatz/Warteschlange, Schiffswahl und
 * Ausrüstung in einem Bereich. Seit dem Werft-Umbau wählt man eine
 * INSTANZ aus der eigenen Flotte (mit Rest-HP), kein Modell: beschädigte
 * oder in Reparatur liegende Schiffe sind gesperrt — repariert wird in der
 * Werft. Ausrüstung (Munition/Panzerung) hängt weiter am MODELL der Instanz.
 */
const router = useRouter();

/**
 * Kartenliste des Einsatz-Panels. Spielbare Karten müssen zu KNOWN_MAPS des
 * Backends passen, sonst antwortet die Lobby „Unbekannte Karte" — die
 * `comingSoon`-Einträge sind reine Schaufenster (nicht wählbar) und zeigen
 * schon einmal, wohin die Reise geht.
 */
const MAPS = [
  {
    id: 'ocean01',
    label: mapLabel('ocean01'),
    detail: '25 × 25 km · offene See · endlos',
    comingSoon: false,
  },
  { id: 'ocean02', label: mapLabel('ocean02'), detail: 'PVP · PVE', comingSoon: true },
  {
    id: 'ocean03',
    label: mapLabel('ocean03'),
    detail: 'PVP · PVE · Gruppenevents',
    comingSoon: true,
  },
  { id: 'ocean04', label: mapLabel('ocean04'), detail: 'PVE', comingSoon: true },
  { id: 'ocean05', label: mapLabel('ocean05'), detail: 'Flottillen-PVP', comingSoon: true },
] as const;

const selectedMap = ref<string>(MAPS[0].id);

/**
 * Karten-Cover, Dateiname = Karten-ID — wie bei den Schiffs-Previews über
 * `import.meta.glob`: eine neue Karte braucht nur ihre Datei.
 */
const MAP_COVERS = import.meta.glob('../../assets/maps/*.webp', {
  eager: true,
  import: 'default',
}) as Record<string, string>;

function mapCoverStyle(id: string): Record<string, string> {
  const bild = MAP_COVERS[`../../assets/maps/${id}.webp`];
  return bild ? { '--cover': `url(${bild})` } : {};
}

const waiting = computed(() => queueState.value === 'waiting' || queueState.value === 'connecting');

/* --- Schiffswahl (Instanzen aus der Werft) -------------------------------- */

const SHIP_KEY = 'subwarfare:shipId';

/**
 * Schiffs-Previews, Dateiname = Modellkennung — wie bei den Item-Icons über
 * `import.meta.glob`: ein neues Bild braucht nur seine Datei. Modelle ohne
 * Datei behalten die reine Textkarte.
 */
const SHIP_PREVIEWS = import.meta.glob('../../assets/ships/*.webp', {
  eager: true,
  import: 'default',
}) as Record<string, string>;

function shipPreviewUrl(model: string): string | null {
  return SHIP_PREVIEWS[`../../assets/ships/${model}.webp`] ?? null;
}

function shipLabel(model: string): string {
  return isPlayableModel(model) ? SHIP_LABELS[model] : model;
}

/** Nur unversehrte bis angeschlagene Schiffe laufen aus — Wracks und
 *  Reparaturen nicht. Dieselbe Regel setzt die api am Ticket durch. */
function auslaufbar(ship: WerftShip): boolean {
  return ship.hp > 0 && ship.repairUntil === null;
}

function sperrGrund(ship: WerftShip): string | null {
  if (ship.repairUntil !== null) return 'In Reparatur';
  if (ship.hp <= 0) return 'Schwer beschädigt';
  return null;
}

const selectedShipId = ref<string | null>(null);

/**
 * Auswahl herstellen, sobald die Flotte da ist: die gespeicherte Instanz,
 * wenn sie noch existiert UND auslaufen darf — sonst die erste auslaufbare,
 * sonst nichts (Knopf bleibt gesperrt).
 */
watch(
  werftShips,
  (ships) => {
    const aktuelle = ships.find((ship) => ship.shipId === selectedShipId.value);
    if (aktuelle && auslaufbar(aktuelle)) return;
    let gespeichert: string | null = null;
    try {
      gespeichert = localStorage.getItem(SHIP_KEY);
    } catch {
      // Gesperrter Storage — dann eben ohne Gedächtnis.
    }
    const wunsch = ships.find((ship) => ship.shipId === gespeichert);
    const wahl = wunsch && auslaufbar(wunsch) ? wunsch : ships.find(auslaufbar);
    selectedShipId.value = wahl?.shipId ?? null;
  },
  { immediate: true },
);

const selectedShip = computed<WerftShip | null>(
  () => werftShips.value.find((ship) => ship.shipId === selectedShipId.value) ?? null,
);

function selectShip(ship: WerftShip): void {
  if (!auslaufbar(ship) || waiting.value) return;
  selectedShipId.value = ship.shipId;
  activeSlot.value = null;
  try {
    localStorage.setItem(SHIP_KEY, ship.shipId);
  } catch {
    // Speichern ist wünschenswert, nicht Bedingung.
  }
}

/**
 * Modell der gewählten Instanz — speist die Ausrüstungs-Slots (die weiter je
 * MODELL gelten). Ohne Auswahl der Fregatten-Standard, damit die Slot-Liste
 * nie leer rendert.
 */
const effectiveModel = computed<PlayableModel>(() => {
  const model = selectedShip.value?.model;
  return isPlayableModel(model) ? model : 'fregatte01';
});

/* --- Ausrüstungs-Slots --------------------------------------------------- */

/** Ausrüstungs-Slots des gewählten Schiffs, aus dessen Bewaffnung. */
const equipSlots = computed<ItemCategory[]>(() =>
  equipSlotsForArmament(DEFAULT_SHIP_STATS[effectiveModel.value].armament),
);

/** Aufgeklappter Slot (Item-Auswahl sichtbar) — höchstens einer. */
const activeSlot = ref<ItemCategory | null>(null);

function toggleSlot(slot: ItemCategory): void {
  activeSlot.value = activeSlot.value === slot ? null : slot;
}

function equippedName(slot: ItemCategory): string | null {
  const id = equippedItem(effectiveModel.value, slot);
  return id !== null && isItemId(id) ? itemById(id).name : null;
}

/** Icon des equippten Items — null bei leerem Slot oder fehlender Grafik. */
function slotIcon(slot: ItemCategory): string | null {
  const id = equippedItem(effectiveModel.value, slot);
  return id !== null ? itemIconUrl(id) : null;
}

/**
 * Stückzahl, die dieser Slot in den Einsatz mitnimmt: die gewählte
 * Wunschmenge, gedeckelt auf den Lagerbestand (`null` in der Belegung heißt
 * „alles"). `null` bei leerem Slot oder bei der Panzerung — die ist ein Stück
 * und wird nicht verbraucht.
 */
function aboardCount(slot: ItemCategory): number | null {
  if (slot === 'panzerung') return null;
  const entry = equippedEntry(effectiveModel.value, slot);
  if (!entry || !isItemId(entry.itemId)) return null;
  const vorrat = ownedQuantity(entry.itemId);
  return Math.min(entry.count ?? vorrat, vorrat);
}

/** Lagerbestand des equippten Items — Obergrenze des Mengen-Steppers. */
function aboardMax(slot: ItemCategory): number {
  const id = equippedItem(effectiveModel.value, slot);
  return id !== null && isItemId(id) ? ownedQuantity(id) : 0;
}

/**
 * Setzt die Wunschmenge des Slots — geklemmt auf 1..Bestand. Läuft über
 * denselben /loadout-Weg wie das Equippen selbst; die Server-Antwort ist die
 * Wahrheit, nicht der lokale Wunsch.
 */
async function orderCount(slot: ItemCategory, roh: number): Promise<void> {
  const entry = equippedEntry(effectiveModel.value, slot);
  if (!entry || !isItemId(entry.itemId)) return;
  const max = Math.max(ownedQuantity(entry.itemId), 1);
  const wert = Math.min(Math.max(Math.round(roh) || 1, 1), max);
  await equip(effectiveModel.value, slot, entry.itemId, wert);
}

function onCountInput(slot: ItemCategory, event: Event): void {
  void orderCount(slot, Number((event.target as HTMLInputElement).value));
}

/** Besitz einer Kategorie in Katalog-Reihenfolge (aufsteigend nach Stärke). */
function ownedInCategory(category: ItemCategory): Array<ItemDefinition & { quantity: number }> {
  return ITEMS.filter((item) => item.category === category)
    .map((item) => ({ ...item, quantity: ownedQuantity(item.id) }))
    .filter((item) => item.quantity > 0);
}

async function equipSlot(slot: ItemCategory, itemId: ItemId | null): Promise<void> {
  await equip(effectiveModel.value, slot, itemId);
  // Beim Belegen offen lassen: direkt daneben sitzt jetzt der Mengen-Stepper,
  // und wer ein Item wählt, will meist auch die Stückzahl setzen. Nur das
  // Leeren schließt — dann gibt es nichts mehr einzustellen.
  if (itemId === null) activeSlot.value = null;
}

/* --- Auslaufen ----------------------------------------------------------- */

function play(): void {
  menuNotice.value = null;
  const shipId = selectedShipId.value;
  if (!shipId) return;
  joinQueue(selectedMap.value, shipId, () => {
    void router.push({ name: 'play' });
  });
}

function cancel(): void {
  leaveQueue();
}

onMounted(() => {
  // Die Flotte ist die Schiffswahl — ohne sie gibt es nichts auszuwählen.
  if (!werftLoaded.value) void refreshWerft();
});
</script>

<template>
  <div class="auslaufen">
    <div class="auslaufen__links">
    <section class="gold-panel menu__panel" aria-label="Einsatz">
      <h2 class="gold-panel__title">Einsatz</h2>

      <ul class="menu__maps">
        <li v-for="map in MAPS" :key="map.id">
          <button
            type="button"
            class="menu__map"
            :class="{
              'menu__map--selected': selectedMap === map.id,
              'menu__map--soon': map.comingSoon,
            }"
            :style="mapCoverStyle(map.id)"
            :disabled="waiting || map.comingSoon"
            @click="selectedMap = map.id"
          >
            <span class="menu__map-name">{{ map.label }}</span>
            <span class="menu__map-detail">{{ map.detail }}</span>
            <span v-if="map.comingSoon" class="menu__map-players">Bald verfügbar</span>
            <span v-else-if="mapStatus[map.id]" class="menu__map-players">
              {{ mapStatus[map.id]!.players }} / {{ mapStatus[map.id]!.capacity }} Spieler an Bord
            </span>
          </button>
        </li>
      </ul>

      <button
        class="menu__go"
        type="button"
        :disabled="waiting || !selectedShip"
        @click="play"
      >
        <template v-if="queueState === 'connecting'">Verbinde …</template>
        <template v-else-if="queueState === 'waiting' && queuePosition">
          Warteschlange — Platz {{ queuePosition.position }} von {{ queuePosition.size }}
        </template>
        <template v-else-if="selectedShip">
          In See stechen · {{ shipLabel(selectedShip.model) }}
        </template>
        <template v-else>Kein einsatzbereites Schiff</template>
      </button>
      <button v-if="waiting" class="menu__cancel" type="button" @click="cancel">Abbrechen</button>

      <p v-if="werftLoaded && !selectedShip" class="menu__error">
        Kein Schiff einsatzbereit — repariere deine Flotte in der Werft.
      </p>
      <p v-if="queueError" class="menu__error">{{ queueError }}</p>
    </section>
    </div>

    <section class="gold-panel menu__panel" aria-label="Ausrüstung">
      <h2 class="gold-panel__title">Ausrüstung</h2>

      <p v-if="werftLoaded && werftShips.length === 0" class="menu__soon">
        Keine Schiffe in der Werft — dort wartet deine Flotte.
      </p>
      <ul class="menu__ships">
        <li v-for="ship in werftShips" :key="ship.shipId">
          <button
            type="button"
            class="menu__ship"
            :class="{
              'menu__ship--selected': selectedShipId === ship.shipId,
              'menu__ship--locked': !auslaufbar(ship),
            }"
            :disabled="!auslaufbar(ship) || waiting"
            @click="selectShip(ship)"
          >
            <img
              v-if="shipPreviewUrl(ship.model)"
              class="menu__ship-img"
              :src="shipPreviewUrl(ship.model)!"
              alt=""
              draggable="false"
            />
            <span class="menu__ship-name">{{ shipLabel(ship.model) }}</span>
            <span v-if="sperrGrund(ship)" class="menu__ship-status menu__ship-status--gesperrt">
              {{ sperrGrund(ship) }}
            </span>
            <span v-else class="menu__ship-status hud__num">
              {{ ship.hp }} / {{ ship.maxHp }} HP
            </span>
          </button>
        </li>
      </ul>

      <div class="menu__slots">
        <div v-for="slot in equipSlots" :key="slot" class="menu__slot">
          <button type="button" class="menu__slot-head" @click="toggleSlot(slot)">
            <span class="menu__slot-cat">{{ CATEGORY_LABELS[slot] }}</span>
            <span
              class="menu__slot-item"
              :class="{ 'menu__slot-item--empty': !equippedName(slot) }"
            >
              <img
                v-if="slotIcon(slot)"
                class="menu__slot-icon"
                :src="slotIcon(slot)!"
                alt=""
              />
              {{ equippedName(slot) ?? '— leer —' }}
              <!-- Was wirklich mitfährt. Ohne Bestand nützt der belegte Slot
                   nichts — dann fährt die Waffe nicht mit. -->
              <span
                v-if="aboardCount(slot) !== null"
                class="menu__slot-aboard hud__num"
                :class="{ 'menu__slot-aboard--none': aboardCount(slot) === 0 }"
              >
                {{ aboardCount(slot) === 0 ? 'kein Vorrat' : `${aboardCount(slot)} an Bord` }}
              </span>
            </span>
          </button>
          <div v-if="activeSlot === slot" class="menu__slot-options">
            <!-- Mengenwahl: wie viel vom Bestand in den Einsatz geht. Nur für
                 Verbrauchsgüter mit Vorrat — Panzerung ist ein Stück. -->
            <div
              v-if="equippedName(slot) && aboardCount(slot) !== null && aboardMax(slot) > 0"
              class="menu__slot-menge"
            >
              <span class="menu__slot-menge-label">Menge für den Einsatz</span>
              <span class="menu__slot-stepper">
                <button
                  type="button"
                  :disabled="economyBusy || (aboardCount(slot) ?? 0) <= 1"
                  @click="orderCount(slot, (aboardCount(slot) ?? 1) - 1)"
                >
                  −
                </button>
                <input
                  class="hud__num"
                  type="number"
                  min="1"
                  :max="aboardMax(slot)"
                  :value="aboardCount(slot)"
                  :disabled="economyBusy"
                  @change="onCountInput(slot, $event)"
                />
                <button
                  type="button"
                  :disabled="economyBusy || (aboardCount(slot) ?? 0) >= aboardMax(slot)"
                  @click="orderCount(slot, (aboardCount(slot) ?? 0) + 1)"
                >
                  +
                </button>
              </span>
              <span class="menu__slot-vorrat hud__num">von {{ aboardMax(slot) }} im Lager</span>
            </div>
            <button
              v-if="equippedName(slot)"
              type="button"
              class="menu__slot-option menu__slot-option--clear"
              :disabled="economyBusy"
              @click="equipSlot(slot, null)"
            >
              Slot leeren
            </button>
            <button
              v-for="item in ownedInCategory(slot)"
              :key="item.id"
              type="button"
              class="menu__slot-option"
              :disabled="economyBusy"
              @click="equipSlot(slot, item.id)"
            >
              <span class="menu__slot-option-name">
                <img
                  v-if="itemIconUrl(item.id)"
                  class="menu__slot-icon"
                  :src="itemIconUrl(item.id)!"
                  alt=""
                />
                {{ item.name }}
              </span>
              <span class="menu__slot-qty hud__num">×{{ item.quantity }}</span>
            </button>
            <p v-if="ownedInCategory(slot).length === 0" class="menu__soon">
              Nichts Passendes im Inventar — schau im Shop vorbei.
            </p>
          </div>
        </div>
      </div>

      <!-- Fehler beim Ausrüsten gehören hierher — der Shop-Reiter ist
           womöglich gar nicht sichtbar. -->
      <p v-if="economyError" class="menu__error">{{ economyError }}</p>
    </section>
  </div>
</template>

<style scoped>
/*
 * Zwei Spalten: links der Weg aufs Wasser (Einsatz + Perks), rechts die
 * Ausrüstung — beides gleichzeitig im Blick statt untereinander gestapelt.
 * Die 34-rem-Vorgabe der Shell wird hier bewusst übersteuert.
 */
.auslaufen {
  max-width: none !important;
  width: min(72rem, 100%);
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1rem;
  align-items: start;
}

.auslaufen__links {
  display: grid;
  gap: 1rem;
}

@media (max-width: 1250px) {
  .auslaufen {
    grid-template-columns: 1fr;
    width: min(34rem, 100%);
  }
}

/* --- Einsatz / Warteschlange ------------------------------------------- */

.menu__maps {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 0.5rem;
}

/*
 * Karten-Kachel mit Cover-Artwork: Bild unterm seitlichen Dunkel-Verlauf,
 * Text links satt lesbar, rechts bleibt die Szene sichtbar — dasselbe
 * Rezept wie bei den Menüpunkten der Nav-Spalte.
 */
.menu__map {
  width: 100%;
  display: grid;
  gap: 0.15rem;
  align-content: center;
  box-sizing: border-box;
  min-height: 76px;
  padding: 0.7rem 0.8rem;
  border: 1px solid var(--gold-border);
  background-color: rgb(0 0 0 / 25%);
  background-image:
    linear-gradient(90deg, rgb(10 9 7 / 74%) 0%, rgb(10 9 7 / 36%) 55%, rgb(10 9 7 / 10%) 100%),
    var(--cover);
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
  background-origin: border-box;
  background-clip: border-box;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.menu__map-name,
.menu__map-detail,
.menu__map-players {
  text-shadow: 0 1px 3px rgb(0 0 0 / 85%);
}

.menu__map:hover:not(:disabled) {
  filter: brightness(1.12);
}

.menu__map--selected {
  border-color: var(--gold);
  box-shadow: inset 0 0 0 1px var(--gold);
}

/* Schaufenster-Karten: sichtbar, aber erkennbar noch nicht befahrbar. */
.menu__map--soon {
  opacity: 0.75;
  filter: grayscale(0.45);
  cursor: default;
}

.menu__map-name {
  font-weight: 600;
  letter-spacing: 0.05em;
}

.menu__map-detail {
  font-size: 0.6875rem;
  opacity: 0.55;
}

.menu__map-players {
  font-size: 0.6875rem;
  color: var(--gold);
  opacity: 0.85;
}

/* Auslauf-Knopf mit eigenem Artwork (480×43, exakt die Zielgröße) — der
   Text liegt zentriert auf einem leichten Dunkel-Schleier darüber. */
.menu__go {
  width: 100%;
  box-sizing: border-box;
  min-height: 45px;
  margin-top: 0.9rem;
  padding: 0.7rem 0.65rem;
  border: 1px solid var(--gold);
  background-color: var(--gold-faint);
  background-image:
    linear-gradient(rgb(10 9 7 / 38%), rgb(10 9 7 / 38%)),
    url('../../assets/ui/menu/button_auslaufen.webp');
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
  background-origin: border-box;
  background-clip: border-box;
  color: var(--gold-bright);
  font: inherit;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  text-shadow: 0 1px 3px rgb(0 0 0 / 85%);
  cursor: pointer;
}

.menu__go:hover:not(:disabled) {
  filter: brightness(1.15);
}

.menu__go:disabled {
  opacity: 0.75;
  filter: grayscale(0.35);
  cursor: default;
}

.menu__cancel {
  width: 100%;
  margin-top: 0.5rem;
  padding: 0.45rem 0.65rem;
  border: 1px solid var(--gold-border);
  background: none;
  color: #e9e2cd;
  font: inherit;
  cursor: pointer;
}

/* --- Schiffswahl --------------------------------------------------------- */

.menu__ships {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 0.5rem;
}

/*
 * Die Schiffe liegen auf dem echten Wasser des Spiels: dieselbe nahtlose
 * Kachel wie im Ozean-Shader, gekachelt und unter einem leichten
 * Dunkel-Verlauf, damit Name und Status unten lesbar bleiben.
 */
.menu__ship {
  width: 100%;
  display: grid;
  gap: 0.2rem;
  padding: 0.55rem 0.7rem;
  border: 1px solid var(--gold-border);
  background-color: rgb(0 0 0 / 25%);
  background-image:
    linear-gradient(180deg, rgb(4 14 22 / 30%) 0%, rgb(4 14 22 / 62%) 100%),
    url('../../assets/fx/ocean_water.webp');
  background-size: auto, 280px;
  background-repeat: no-repeat, repeat;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.menu__ship-name,
.menu__ship-status {
  text-shadow: 0 1px 3px rgb(0 0 0 / 85%);
}

.menu__ship:hover:not(:disabled) {
  filter: brightness(1.1);
}

.menu__ship--selected {
  border-color: var(--gold);
  box-shadow: inset 0 0 0 1px var(--gold);
}

.menu__ship--locked {
  opacity: 0.45;
  cursor: default;
}

/* Preview über dem Namen: feste Höhe, damit die Karten trotz verschiedener
   Seitenverhältnisse (Fregatte quadratisch, U-Boot breit) gleich hoch bleiben. */
.menu__ship-img {
  width: 100%;
  height: 72px;
  object-fit: contain;
  justify-self: center;
  filter: drop-shadow(0 3px 5px rgb(0 0 0 / 45%));
  -webkit-user-drag: none;
  /* Drehpunkt unter der Wasserlinie — so wiegt es statt zu kippeln. */
  transform-origin: 50% 85%;
}

/*
 * Beim Überfahren wiegt sich das Schiff minimal in der Dünung: kleine
 * Rollbewegung mit leichtem Heben, hin und zurück. Bewusst dezent —
 * Kulisse, kein Karussell.
 */
@keyframes schaukeln {
  0% {
    transform: rotate(-1.4deg) translateY(0.6px);
  }
  100% {
    transform: rotate(1.4deg) translateY(-0.6px);
  }
}

.menu__ship:hover:not(:disabled) .menu__ship-img {
  animation: schaukeln 1.7s ease-in-out infinite alternate;
}

.menu__ship-name {
  font-weight: 600;
  letter-spacing: 0.05em;
}

.menu__ship-status {
  font-size: 0.6875rem;
  color: var(--gold);
  opacity: 0.85;
}

/* Gesperrte Instanzen (Wrack, Reparatur) — der Grund steht in Rot da. */
.menu__ship-status--gesperrt {
  color: #f26d6d;
}

/* --- Ausrüstung: Slots -------------------------------------------------- */

.menu__slots {
  margin-top: 0.8rem;
  padding-top: 0.8rem;
  border-top: 1px solid var(--gold-border);
  display: grid;
  gap: 0.45rem;
}

.menu__slot-head {
  width: 100%;
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 0.6rem;
  padding: 0.5rem 0.7rem;
  border: 1px solid var(--gold-border);
  background: rgb(0 0 0 / 25%);
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.menu__slot-head:hover {
  background: var(--gold-faint);
}

.menu__slot-cat {
  font-size: 0.6875rem;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  opacity: 0.6;
}

.menu__slot-item {
  font-weight: 600;
  color: var(--gold);
}

.menu__slot-item--empty {
  font-weight: 400;
  color: inherit;
  opacity: 0.45;
}

/* Die Stückzahl steht kleiner hinter dem Namen: der Name sagt WAS, diese Zahl
   sagt WIE VIEL davon in den Einsatz geht. */
.menu__slot-aboard {
  margin-left: 0.5rem;
  font-weight: 400;
  font-size: 0.8em;
  opacity: 0.65;
}

/* Belegt, aber nichts da: das muss auffallen — der Slot sieht sonst voll aus,
   und man läuft ohne die Waffe aus. */
.menu__slot-aboard--none {
  color: #f4b3b5;
  opacity: 0.9;
}

.menu__slot-options {
  display: grid;
  gap: 0.3rem;
  padding: 0.5rem 0.6rem;
  border: 1px solid var(--gold-border);
  border-top: none;
  background: rgb(0 0 0 / 40%);
}

.menu__slot-option {
  display: flex;
  justify-content: space-between;
  gap: 0.6rem;
  padding: 0.4rem 0.55rem;
  border: 1px solid transparent;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.menu__slot-option:hover:not(:disabled) {
  border-color: var(--gold-border);
  background: var(--gold-faint);
}

.menu__slot-option--clear {
  color: #e2b45a;
}

.menu__slot-qty {
  opacity: 0.6;
}

/* Item-Icon im Slot-Kopf und in den Auswahlzeilen — klein und mittig zur
   Schrift, das Bild bestimmt nicht die Zeilenhöhe. */
.menu__slot-icon {
  width: 20px;
  height: 20px;
  object-fit: contain;
  vertical-align: -5px;
  margin-right: 0.25rem;
  image-rendering: -webkit-optimize-contrast;
}

.menu__slot-option-name {
  display: flex;
  align-items: center;
  gap: 0.2rem;
}

/* --- Mengenwahl im offenen Slot ----------------------------------------- */

.menu__slot-menge {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.4rem 0.55rem;
  border: 1px solid var(--gold-border);
  background: rgb(0 0 0 / 25%);
}

.menu__slot-menge-label {
  flex: 1;
  font-size: 0.6875rem;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  opacity: 0.6;
}

.menu__slot-stepper {
  display: inline-flex;
  align-items: stretch;
}

.menu__slot-stepper button {
  width: 26px;
  border: 1px solid var(--gold-border);
  background: rgb(0 0 0 / 30%);
  color: var(--gold);
  font: inherit;
  cursor: pointer;
}

.menu__slot-stepper button:hover:not(:disabled) {
  background: var(--gold-faint);
}

.menu__slot-stepper button:disabled {
  opacity: 0.35;
  cursor: default;
}

.menu__slot-stepper input {
  width: 3.2rem;
  padding: 0.25rem 0.3rem;
  border: 1px solid var(--gold-border);
  border-left: none;
  border-right: none;
  background: rgb(0 0 0 / 30%);
  color: var(--gold-bright);
  font: inherit;
  text-align: center;
  appearance: textfield;
  -moz-appearance: textfield;
}

.menu__slot-stepper input::-webkit-outer-spin-button,
.menu__slot-stepper input::-webkit-inner-spin-button {
  appearance: none;
  margin: 0;
}

.menu__slot-vorrat {
  font-size: 0.6875rem;
  opacity: 0.55;
  white-space: nowrap;
}

/* --- Perks -------------------------------------------------------------- */

</style>
