<script setup lang="ts">
import type { ItemCategory, ItemDefinition, ItemId, PlayableModel } from '@subwarfare/shared';
import {
  CATEGORY_LABELS,
  DEFAULT_SHIP_STATS,
  ITEMS,
  PERK_SLOTS,
  PLAYABLE_MODELS,
  SHIP_ACCESS,
  equipSlotsForArmament,
  isItemId,
  isPlayableModel,
  itemById,
} from '@subwarfare/shared';
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { mapLabel } from '../../config';
import { account, progression } from '../../state/auth';
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
import { itemIconUrl } from '../itemIcons';

/**
 * Auslaufen: der Weg aufs Wasser — Einsatz/Warteschlange, Schiffswahl und
 * Ausrüstung in einem Bereich. Umzug aus der alten Menü-Mitte; der
 * effectiveShip-Cluster (Wahl → Sperre → Kosten → Slots → play) ist bewusst
 * EIN Block geblieben.
 */
const router = useRouter();

/**
 * Wählbare Karten. Solange es genau eine gibt, ist das eine Liste mit einem
 * Eintrag — die Auswahl-Mechanik steht damit trotzdem schon. Muss zu
 * KNOWN_MAPS des Backends passen, sonst antwortet die Lobby „Unbekannte Karte".
 */
const MAPS = [
  { id: 'ocean01', label: mapLabel('ocean01'), detail: '25 × 25 km · offene See · endlos' },
] as const;

const selectedMap = ref<string>(MAPS[0].id);

const rawCoins = computed(() => account.value?.coins ?? 0);
const waiting = computed(() => queueState.value === 'waiting' || queueState.value === 'connecting');

/* --- Schiffswahl --------------------------------------------------------- */

const SHIP_LABELS: Record<PlayableModel, string> = {
  fregatte01: 'Fregatte',
  fregatte02: 'Fregatte II',
  submarine01: 'U-Boot',
  submarine02: 'U-Boot II',
  destroyer01: 'Zerstörer',
  destroyer02: 'Zerstörer II',
};

const SHIP_KEY = 'subwarfare:ship';

/**
 * Schiffs-Previews, Dateiname = Modellkennung — wie bei den Item-Icons über
 * `import.meta.glob`: ein neues Bild braucht nur seine Datei. Modelle ohne
 * Datei behalten die reine Textkarte.
 */
const SHIP_PREVIEWS = import.meta.glob('../../assets/ships/*.webp', {
  eager: true,
  import: 'default',
}) as Record<string, string>;

function shipPreviewUrl(model: PlayableModel): string | null {
  return SHIP_PREVIEWS[`../../assets/ships/${model}.webp`] ?? null;
}

function restoreShip(): PlayableModel {
  try {
    const stored = localStorage.getItem(SHIP_KEY);
    if (isPlayableModel(stored)) return stored;
  } catch {
    // Gesperrter Storage — dann eben der Standard.
  }
  return 'fregatte01';
}

const selectedShip = ref<PlayableModel>(restoreShip());

function shipLocked(model: PlayableModel): boolean {
  return progression.value.level < SHIP_ACCESS[model].minLevel;
}

function selectShip(model: PlayableModel): void {
  if (shipLocked(model) || waiting.value) return;
  selectedShip.value = model;
  activeSlot.value = null;
  try {
    localStorage.setItem(SHIP_KEY, model);
  } catch {
    // Speichern ist wünschenswert, nicht Bedingung.
  }
}

/** Die gespeicherte Wahl kann über dem Level liegen (anderes Konto am selben
 *  Browser) — dann zurück auf den kostenlosen Standard. */
const effectiveShip = computed<PlayableModel>(() =>
  shipLocked(selectedShip.value) ? 'fregatte01' : selectedShip.value,
);

const sortieCost = computed(() => SHIP_ACCESS[effectiveShip.value].sortieCost);
const canAffordSortie = computed(() => rawCoins.value >= sortieCost.value);

/* --- Ausrüstungs-Slots --------------------------------------------------- */

/** Ausrüstungs-Slots des gewählten Schiffs, aus dessen Bewaffnung. */
const equipSlots = computed<ItemCategory[]>(() =>
  equipSlotsForArmament(DEFAULT_SHIP_STATS[effectiveShip.value].armament),
);

/** Aufgeklappter Slot (Item-Auswahl sichtbar) — höchstens einer. */
const activeSlot = ref<ItemCategory | null>(null);

function toggleSlot(slot: ItemCategory): void {
  activeSlot.value = activeSlot.value === slot ? null : slot;
}

function equippedName(slot: ItemCategory): string | null {
  const id = equippedItem(effectiveShip.value, slot);
  return id !== null && isItemId(id) ? itemById(id).name : null;
}

/** Icon des equippten Items — null bei leerem Slot oder fehlender Grafik. */
function slotIcon(slot: ItemCategory): string | null {
  const id = equippedItem(effectiveShip.value, slot);
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
  const entry = equippedEntry(effectiveShip.value, slot);
  if (!entry || !isItemId(entry.itemId)) return null;
  const vorrat = ownedQuantity(entry.itemId);
  return Math.min(entry.count ?? vorrat, vorrat);
}

/** Lagerbestand des equippten Items — Obergrenze des Mengen-Steppers. */
function aboardMax(slot: ItemCategory): number {
  const id = equippedItem(effectiveShip.value, slot);
  return id !== null && isItemId(id) ? ownedQuantity(id) : 0;
}

/**
 * Setzt die Wunschmenge des Slots — geklemmt auf 1..Bestand. Läuft über
 * denselben /loadout-Weg wie das Equippen selbst; die Server-Antwort ist die
 * Wahrheit, nicht der lokale Wunsch.
 */
async function orderCount(slot: ItemCategory, roh: number): Promise<void> {
  const entry = equippedEntry(effectiveShip.value, slot);
  if (!entry || !isItemId(entry.itemId)) return;
  const max = Math.max(ownedQuantity(entry.itemId), 1);
  const wert = Math.min(Math.max(Math.round(roh) || 1, 1), max);
  await equip(effectiveShip.value, slot, entry.itemId, wert);
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
  await equip(effectiveShip.value, slot, itemId);
  // Beim Belegen offen lassen: direkt daneben sitzt jetzt der Mengen-Stepper,
  // und wer ein Item wählt, will meist auch die Stückzahl setzen. Nur das
  // Leeren schließt — dann gibt es nichts mehr einzustellen.
  if (itemId === null) activeSlot.value = null;
}

/* --- Auslaufen ----------------------------------------------------------- */

function play(): void {
  menuNotice.value = null;
  if (!canAffordSortie.value) return;
  joinQueue(selectedMap.value, effectiveShip.value, () => {
    void router.push({ name: 'play' });
  });
}

function cancel(): void {
  leaveQueue();
}
</script>

<template>
  <div class="auslaufen">
    <section class="gold-panel menu__panel" aria-label="Einsatz">
      <h2 class="gold-panel__title">Einsatz</h2>

      <ul class="menu__maps">
        <li v-for="map in MAPS" :key="map.id">
          <button
            type="button"
            class="menu__map"
            :class="{ 'menu__map--selected': selectedMap === map.id }"
            :disabled="waiting"
            @click="selectedMap = map.id"
          >
            <span class="menu__map-name">{{ map.label }}</span>
            <span class="menu__map-detail">{{ map.detail }}</span>
            <span v-if="mapStatus[map.id]" class="menu__map-players">
              {{ mapStatus[map.id]!.players }} / {{ mapStatus[map.id]!.capacity }} Spieler an Bord
            </span>
          </button>
        </li>
      </ul>

      <button
        class="menu__go"
        type="button"
        :disabled="waiting || !canAffordSortie"
        @click="play"
      >
        <template v-if="queueState === 'connecting'">Verbinde …</template>
        <template v-else-if="queueState === 'waiting' && queuePosition">
          Warteschlange — Platz {{ queuePosition.position }} von {{ queuePosition.size }}
        </template>
        <template v-else-if="sortieCost > 0">
          In See stechen · {{ SHIP_LABELS[effectiveShip] }} · {{ sortieCost }} Coins
        </template>
        <template v-else>In See stechen · {{ SHIP_LABELS[effectiveShip] }}</template>
      </button>
      <button v-if="waiting" class="menu__cancel" type="button" @click="cancel">Abbrechen</button>

      <p v-if="!waiting && !canAffordSortie" class="menu__error">
        Nicht genug Coins für diesen Einsatz.
      </p>
      <p v-if="queueError" class="menu__error">{{ queueError }}</p>
    </section>

    <section class="gold-panel menu__panel" aria-label="Ausrüstung">
      <h2 class="gold-panel__title">Ausrüstung</h2>

      <ul class="menu__ships">
        <li v-for="model in PLAYABLE_MODELS" :key="model">
          <button
            type="button"
            class="menu__ship"
            :class="{
              'menu__ship--selected': effectiveShip === model,
              'menu__ship--locked': shipLocked(model),
            }"
            :disabled="shipLocked(model) || waiting"
            @click="selectShip(model)"
          >
            <img
              v-if="shipPreviewUrl(model)"
              class="menu__ship-img"
              :src="shipPreviewUrl(model)!"
              alt=""
              draggable="false"
            />
            <span class="menu__ship-name">{{ SHIP_LABELS[model] }}</span>
            <span v-if="shipLocked(model)" class="menu__ship-status">
              Ab Level {{ SHIP_ACCESS[model].minLevel }}
            </span>
            <span v-else-if="SHIP_ACCESS[model].sortieCost > 0" class="menu__ship-status">
              <img class="menu__coin menu__coin--small" src="../../assets/ui/coin.png" alt="" />
              {{ SHIP_ACCESS[model].sortieCost }} je Einsatz
            </span>
            <span v-else class="menu__ship-status">Kostenlos</span>
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

    <section class="gold-panel menu__panel" aria-label="Perks">
      <h2 class="gold-panel__title">Perks</h2>
      <div class="menu__perkslots">
        <div v-for="slot in PERK_SLOTS" :key="slot" class="menu__perkslot" aria-hidden="true">
          <span>+</span>
        </div>
      </div>
      <p class="menu__soon">Perks folgen — später ziehst du sie aus dem Inventar hierher.</p>
    </section>
  </div>
</template>

<style scoped>
.auslaufen {
  display: grid;
  gap: 1rem;
}

/* --- Einsatz / Warteschlange ------------------------------------------- */

.menu__maps {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 0.5rem;
}

.menu__map {
  width: 100%;
  display: grid;
  gap: 0.15rem;
  padding: 0.7rem 0.8rem;
  border: 1px solid var(--gold-border);
  background: rgb(0 0 0 / 25%);
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.menu__map:hover:not(:disabled) {
  background: var(--gold-faint);
}

.menu__map--selected {
  border-color: var(--gold);
  background: var(--gold-faint);
  box-shadow: inset 0 0 0 1px var(--gold);
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

.menu__go {
  width: 100%;
  margin-top: 0.9rem;
  padding: 0.7rem 0.65rem;
  border: 1px solid var(--gold);
  background: var(--gold-faint);
  color: var(--gold);
  font: inherit;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  cursor: pointer;
}

.menu__go:hover:not(:disabled) {
  background: rgb(230 207 120 / 22%);
}

.menu__go:disabled {
  opacity: 0.75;
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

.menu__ship {
  width: 100%;
  display: grid;
  gap: 0.2rem;
  padding: 0.55rem 0.7rem;
  border: 1px solid var(--gold-border);
  background: rgb(0 0 0 / 25%);
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.menu__ship:hover:not(:disabled) {
  background: var(--gold-faint);
}

.menu__ship--selected {
  border-color: var(--gold);
  background: var(--gold-faint);
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

.menu__perkslots {
  display: flex;
  gap: 0.6rem;
  margin-bottom: 0.7rem;
}

.menu__perkslot {
  width: 52px;
  height: 52px;
  display: grid;
  place-items: center;
  border: 1px dashed var(--gold-border);
  background: rgb(0 0 0 / 25%);
  color: var(--gold);
  font-size: 1.2rem;
  opacity: 0.6;
}
</style>
