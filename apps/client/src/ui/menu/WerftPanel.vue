<script setup lang="ts">
import type { PlayableModel, WerftShip } from '@subwarfare/shared';
import {
  ITEMS,
  PERK_SLOTS_BY_MODEL,
  PLAYABLE_MODELS,
  SHIP_PRICES,
  isPerkId,
  isPlayableModel,
  perkById,
  perkEffectLabel,
  repairCost,
} from '@subwarfare/shared';
import { computed, onMounted, ref } from 'vue';
import { account } from '../../state/auth';
import { ownedQuantity, refreshInventory } from '../../state/economy';
import {
  buyShip,
  refreshWerft,
  repairRemaining,
  repairShip,
  scrapShip,
  setShipPerks,
  werftBusy,
  werftError,
  werftLoaded,
  werftShips,
  werftSlots,
} from '../../state/werft';
import { perkIconUrl } from '../perkIcons';
import { SHIP_LABELS } from './shipLabels';

/**
 * Werft: die Schiffsbasis. Sechs Slots je Konto — jede Karte ist eine
 * INSTANZ mit eigener HP, eigenem Reparatur-Timer und eigenen Perks. Unten
 * die Kaufwerft: Modelle mit Preisen, solange Slots frei sind. Formeln und
 * Regeln kommen aus shared; die api prüft alles erneut.
 */
const SHIP_PREVIEWS = import.meta.glob('../../assets/ships/*.webp', {
  eager: true,
  import: 'default',
}) as Record<string, string>;

function shipPreviewUrl(model: string): string | null {
  return SHIP_PREVIEWS[`../../assets/ships/${model}.webp`] ?? null;
}

const rawCoins = computed(() => account.value?.coins ?? 0);

function label(model: string): string {
  return isPlayableModel(model) ? SHIP_LABELS[model] : model;
}

/* --- Zustand & Reparatur -------------------------------------------------- */

type ShipZustand = 'bereit' | 'beschaedigt' | 'wrack' | 'reparatur';

function zustand(ship: WerftShip): ShipZustand {
  if (ship.repairUntil !== null) return 'reparatur';
  if (ship.hp <= 0) return 'wrack';
  if (ship.hp < ship.maxHp) return 'beschaedigt';
  return 'bereit';
}

const ZUSTAND_LABEL: Record<ShipZustand, string> = {
  bereit: 'Bereit',
  beschaedigt: 'Beschädigt',
  wrack: 'Schwer beschädigt',
  reparatur: 'In Reparatur',
};

function hpProzent(ship: WerftShip): number {
  if (ship.maxHp <= 0) return 0;
  return Math.round((ship.hp / ship.maxHp) * 100);
}

function hpKlasse(ship: WerftShip): string {
  const prozent = hpProzent(ship);
  if (prozent <= 25) return 'werft__hp-balken--rot';
  if (prozent <= 60) return 'werft__hp-balken--gelb';
  return '';
}

function kosten(ship: WerftShip): number {
  return isPlayableModel(ship.model) ? repairCost(ship.model, ship.hp, ship.maxHp) : 0;
}

/** Restzeit als h:mm:ss bzw. mm:ss — destroyer02 repariert 80 Minuten. */
function restzeit(ship: WerftShip): string {
  const rest = repairRemaining(ship) ?? 0;
  const h = Math.floor(rest / 3600);
  const m = Math.floor((rest % 3600) / 60);
  const s = rest % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

async function reparieren(ship: WerftShip): Promise<void> {
  await repairShip(ship.shipId);
}

/* --- Perks ---------------------------------------------------------------- */

/** Offener Perk-Slot (Auswahlliste sichtbar) — höchstens einer zugleich. */
const aktiverPerkSlot = ref<{ shipId: string; index: number } | null>(null);

function perkSlotOffen(ship: WerftShip, index: number): boolean {
  return (
    aktiverPerkSlot.value?.shipId === ship.shipId && aktiverPerkSlot.value.index === index
  );
}

function togglePerkSlot(ship: WerftShip, index: number): void {
  aktiverPerkSlot.value = perkSlotOffen(ship, index) ? null : { shipId: ship.shipId, index };
}

function perkSlots(ship: WerftShip): number {
  return isPlayableModel(ship.model) ? PERK_SLOTS_BY_MODEL[ship.model] : 0;
}

function perkImSlot(ship: WerftShip, index: number): string | null {
  return ship.perks[index] ?? null;
}

function perkName(perkId: string): string {
  return ITEMS.find((item) => item.id === perkId)?.name ?? perkId;
}

function perkTooltip(perkId: string): string {
  return isPerkId(perkId) ? `${perkName(perkId)} — ${perkEffectLabel(perkId)}` : perkId;
}

/**
 * Wählbare Perks für einen Slot: im Besitz, und der TYP ist auf diesem
 * Schiff noch nicht verbaut (außer im angeklickten Slot selbst) — dieselbe
 * Regel, die die api mit validatePerkSet durchsetzt.
 */
function perkOptionen(ship: WerftShip, index: number): string[] {
  const belegteTypen = new Set(
    ship.perks
      .filter((_, i) => i !== index)
      .filter(isPerkId)
      .map((id) => perkById(id).type),
  );
  return ITEMS.filter((item) => item.category === 'perk')
    .map((item) => item.id)
    .filter(
      (id) =>
        isPerkId(id) && ownedQuantity(id) > 0 && !belegteTypen.has(perkById(id).type),
    );
}

async function perkSetzen(ship: WerftShip, index: number, perkId: string | null): Promise<void> {
  const perks = [...ship.perks];
  if (perkId === null) {
    if (index < perks.length) perks.splice(index, 1);
  } else if (index < perks.length) {
    perks[index] = perkId;
  } else {
    perks.push(perkId);
  }
  aktiverPerkSlot.value = null;
  await setShipPerks(ship.shipId, perks);
}

/* --- Verschrotten --------------------------------------------------------- */

/** Schiff, dessen Verschrottungs-Dialog offen ist — null = kein Dialog. */
const abwrackKandidat = ref<WerftShip | null>(null);
/** Getippte Bestätigung — der Knopf schaltet erst bei exakt „LÖSCHEN" frei. */
const abwrackBestaetigung = ref('');

function abwrackDialogOeffnen(ship: WerftShip): void {
  abwrackKandidat.value = ship;
  abwrackBestaetigung.value = '';
}

function abwrackDialogSchliessen(): void {
  abwrackKandidat.value = null;
  abwrackBestaetigung.value = '';
}

const abwrackFreigegeben = computed(() => abwrackBestaetigung.value === 'LÖSCHEN');

async function abwracken(): Promise<void> {
  const ship = abwrackKandidat.value;
  if (!ship || !abwrackFreigegeben.value) return;
  const fehler = await scrapShip(ship.shipId);
  if (fehler === null) abwrackDialogSchliessen();
}

/* --- Kaufwerft ------------------------------------------------------------ */

const flotteVoll = computed(() => werftShips.value.length >= werftSlots.value);

function preis(model: PlayableModel): number {
  return SHIP_PRICES[model];
}

async function kaufen(model: PlayableModel): Promise<void> {
  await buyShip(model);
}

onMounted(() => {
  void refreshWerft();
  // Für die Perk-Auswahl: der Besitz kommt aus dem Inventar.
  void refreshInventory();
});
</script>

<template>
  <div class="werft">
    <section class="gold-panel menu__panel" aria-label="Meine Flotte">
      <h2 class="gold-panel__title">
        Meine Flotte
        <span class="werft__slots hud__num">{{ werftShips.length }} / {{ werftSlots }}</span>
      </h2>

      <p v-if="!werftLoaded" class="menu__soon">Lade Flotte …</p>
      <ul v-else class="werft__flotte">
        <li v-for="ship in werftShips" :key="ship.shipId" class="werft__karte">
          <div class="werft__bild">
            <img
              v-if="shipPreviewUrl(ship.model)"
              :src="shipPreviewUrl(ship.model)!"
              alt=""
              draggable="false"
            />
          </div>

          <div class="werft__kopf">
            <span class="werft__name">{{ label(ship.model) }}</span>
            <span class="werft__kopf-rechts">
              <span
                class="werft__status"
                :class="`werft__status--${zustand(ship)}`"
              >
                {{ ZUSTAND_LABEL[zustand(ship)] }}
                <template v-if="zustand(ship) === 'reparatur'">
                  — <span class="hud__num">{{ restzeit(ship) }}</span>
                </template>
              </span>
              <button
                type="button"
                class="werft__abwracken"
                title="Schiff aus der Flotte entfernen (keine Erstattung)"
                aria-label="Schiff entfernen"
                @click="abwrackDialogOeffnen(ship)"
              >
                ×
              </button>
            </span>
          </div>

          <div class="werft__hp" :title="`${ship.hp} / ${ship.maxHp} HP`">
            <div
              class="werft__hp-balken"
              :class="hpKlasse(ship)"
              :style="{ width: `${hpProzent(ship)}%` }"
            ></div>
          </div>
          <span class="werft__hp-text hud__num">{{ ship.hp }} / {{ ship.maxHp }} HP</span>

          <button
            v-if="zustand(ship) === 'beschaedigt' || zustand(ship) === 'wrack'"
            type="button"
            class="werft__knopf"
            :disabled="werftBusy || rawCoins < kosten(ship)"
            @click="reparieren(ship)"
          >
            <template v-if="kosten(ship) > 0">
              Reparieren ·
              <img class="menu__coin menu__coin--small" src="../../assets/ui/coin.png" alt="" />
              {{ kosten(ship) }}
            </template>
            <template v-else>Gratis reparieren</template>
          </button>

          <!-- Perk-Slots der Instanz: je Typ höchstens einer, Anzahl je Modell. -->
          <div class="werft__perks">
            <button
              v-for="index in perkSlots(ship)"
              :key="index"
              type="button"
              class="werft__perkslot"
              :class="{ 'werft__perkslot--offen': perkSlotOffen(ship, index - 1) }"
              :title="
                perkImSlot(ship, index - 1)
                  ? perkTooltip(perkImSlot(ship, index - 1)!)
                  : 'Perk verbauen'
              "
              @click="togglePerkSlot(ship, index - 1)"
            >
              <img
                v-if="perkImSlot(ship, index - 1) && perkIconUrl(perkImSlot(ship, index - 1)!)"
                :src="perkIconUrl(perkImSlot(ship, index - 1)!)!"
                alt=""
                draggable="false"
              />
              <span v-else>+</span>
            </button>
          </div>

          <!-- Auswahl fürs offene Perk-Fach: Besitz, Typ-Regel gespiegelt. -->
          <div
            v-if="aktiverPerkSlot?.shipId === ship.shipId"
            class="werft__perk-optionen"
          >
            <button
              v-if="perkImSlot(ship, aktiverPerkSlot.index)"
              type="button"
              class="werft__perk-option werft__perk-option--leeren"
              :disabled="werftBusy"
              @click="perkSetzen(ship, aktiverPerkSlot.index, null)"
            >
              — Perk ausbauen —
            </button>
            <button
              v-for="option in perkOptionen(ship, aktiverPerkSlot.index)"
              :key="option"
              type="button"
              class="werft__perk-option"
              :disabled="werftBusy"
              @click="perkSetzen(ship, aktiverPerkSlot.index, option)"
            >
              <img
                v-if="perkIconUrl(option)"
                class="werft__perk-option-icon"
                :src="perkIconUrl(option)!"
                alt=""
              />
              <span class="werft__perk-option-name">{{ perkName(option) }}</span>
              <span class="werft__perk-option-effekt">{{
                isPerkId(option) ? perkEffectLabel(option) : ''
              }}</span>
            </button>
            <p
              v-if="
                perkOptionen(ship, aktiverPerkSlot.index).length === 0 &&
                !perkImSlot(ship, aktiverPerkSlot.index)
              "
              class="menu__soon"
            >
              Keine passenden Perks im Depot — sie fallen als Beute auf See.
            </p>
          </div>
        </li>
      </ul>

      <p v-if="werftError" class="menu__error">{{ werftError }}</p>
    </section>

    <!-- Verschrottungs-Dialog: endgültig, keine Erstattung — die getippte
         Bestätigung „LÖSCHEN" schaltet den Knopf frei. -->
    <div v-if="abwrackKandidat" class="werft__dialog-schleier" @click.self="abwrackDialogSchliessen">
      <section class="gold-panel werft__dialog" aria-label="Schiff entfernen">
        <h2 class="gold-panel__title">Schiff entfernen</h2>
        <p class="werft__dialog-text">
          <strong>{{ label(abwrackKandidat.model) }}</strong> wird endgültig aus der Flotte
          entfernt. Du bekommst deine Coins <strong>nicht</strong> zurück — auch nicht anteilig.
        </p>
        <p class="werft__dialog-text">
          Tippe zur Bestätigung <strong>LÖSCHEN</strong>:
        </p>
        <input
          v-model="abwrackBestaetigung"
          class="werft__dialog-eingabe"
          type="text"
          placeholder="LÖSCHEN"
          autocomplete="off"
          spellcheck="false"
        />
        <div class="werft__dialog-aktionen">
          <button
            type="button"
            class="werft__knopf werft__knopf--gefahr"
            :disabled="!abwrackFreigegeben || werftBusy"
            @click="abwracken"
          >
            Endgültig entfernen
          </button>
          <button type="button" class="werft__knopf" @click="abwrackDialogSchliessen">
            Abbrechen
          </button>
        </div>
      </section>
    </div>

    <section class="gold-panel menu__panel" aria-label="Schiffskauf">
      <h2 class="gold-panel__title">Kaufwerft</h2>
      <p v-if="flotteVoll" class="menu__soon">
        Alle {{ werftSlots }} Slots sind belegt — für ein neues Schiff muss erst Platz sein.
      </p>
      <ul class="werft__angebote">
        <li v-for="model in PLAYABLE_MODELS" :key="model" class="werft__angebot">
          <div class="werft__bild werft__bild--klein">
            <img
              v-if="shipPreviewUrl(model)"
              :src="shipPreviewUrl(model)!"
              alt=""
              draggable="false"
            />
          </div>
          <span class="werft__angebot-name">{{ label(model) }}</span>
          <span class="werft__angebot-preis hud__num">
            <template v-if="preis(model) > 0">
              <img class="menu__coin menu__coin--small" src="../../assets/ui/coin.png" alt="" />
              {{ preis(model) }}
            </template>
            <template v-else>Kostenlos</template>
          </span>
          <button
            type="button"
            class="werft__knopf"
            :disabled="werftBusy || flotteVoll || rawCoins < preis(model)"
            @click="kaufen(model)"
          >
            Kaufen
          </button>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.werft {
  display: grid;
  gap: 1rem;
  max-width: none !important;
  width: min(72rem, 100%);
}

.werft__slots {
  float: right;
  opacity: 0.8;
}

/* --- Flotten-Karten ------------------------------------------------------- */

.werft__flotte {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(20rem, 1fr));
  gap: 0.7rem;
}

.werft__karte {
  display: grid;
  gap: 0.4rem;
  padding: 0.6rem;
  border: 1px solid var(--gold-border);
  background: rgb(0 0 0 / 20%);
}

/* Wasser-Kachel wie bei der Schiffswahl im Auslaufen-Bereich. */
.werft__bild {
  display: grid;
  place-items: center;
  height: 88px;
  border: 1px solid var(--gold-border);
  background-image:
    linear-gradient(180deg, rgb(4 14 22 / 30%) 0%, rgb(4 14 22 / 62%) 100%),
    url('../../assets/fx/ocean_water.webp');
  background-size: auto, 280px;
  background-repeat: no-repeat, repeat;
}

.werft__bild img {
  height: 72px;
  object-fit: contain;
  -webkit-user-drag: none;
}

.werft__bild--klein {
  height: 60px;
}

.werft__bild--klein img {
  height: 48px;
}

.werft__kopf {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 0.5rem;
}

.werft__name {
  font-weight: 600;
  letter-spacing: 0.05em;
}

.werft__status {
  font-size: 0.6875rem;
  letter-spacing: 0.06em;
}

.werft__status--bereit {
  color: #6fd08c;
}

.werft__status--beschaedigt {
  color: #e2b45a;
}

.werft__status--wrack {
  color: #f26d6d;
}

.werft__status--reparatur {
  color: var(--gold);
}

.werft__kopf-rechts {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
}

.werft__abwracken {
  padding: 0 0.3rem;
  border: none;
  background: none;
  color: #f26d6d;
  font: inherit;
  font-size: 0.9rem;
  line-height: 1;
  cursor: pointer;
  opacity: 0.55;
}

.werft__abwracken:hover {
  opacity: 1;
}

/* --- Verschrottungs-Dialog ------------------------------------------------ */

.werft__dialog-schleier {
  position: fixed;
  inset: 0;
  z-index: 30;
  display: grid;
  place-items: center;
  background: rgb(4 20 31 / 55%);
}

.werft__dialog {
  width: min(24rem, calc(100vw - 2rem));
  padding: 1rem 1.1rem 1.1rem;
}

.werft__dialog-text {
  margin: 0 0 0.7rem;
  font-size: 0.8125rem;
  line-height: 1.5;
}

.werft__dialog-text strong {
  color: #f26d6d;
}

.werft__dialog-eingabe {
  width: 100%;
  margin-bottom: 0.8rem;
  padding: 0.45rem 0.55rem;
  border: 1px solid var(--gold-border);
  background: rgb(0 0 0 / 35%);
  color: #e9e2cd;
  font: inherit;
  font-size: 0.8125rem;
  letter-spacing: 0.08em;
}

.werft__dialog-eingabe:focus {
  outline: none;
  border-color: #f26d6d;
}

.werft__dialog-aktionen {
  display: flex;
  gap: 0.4rem;
}

.werft__dialog-aktionen .werft__knopf {
  flex: 1;
}

.werft__knopf--gefahr {
  border-color: #f26d6d;
  background: rgb(242 109 109 / 12%);
  color: #f26d6d;
}

.werft__knopf--gefahr:hover:not(:disabled) {
  background: rgb(242 109 109 / 22%);
}

/* --- HP-Balken ------------------------------------------------------------ */

.werft__hp {
  height: 6px;
  border: 1px solid var(--gold-border);
  background: rgb(0 0 0 / 40%);
}

.werft__hp-balken {
  height: 100%;
  background: #6fd08c;
}

.werft__hp-balken--gelb {
  background: #e2b45a;
}

.werft__hp-balken--rot {
  background: #f26d6d;
}

.werft__hp-text {
  font-size: 0.625rem;
  opacity: 0.65;
}

/* --- Knöpfe --------------------------------------------------------------- */

.werft__knopf {
  padding: 0.35rem 0.6rem;
  border: 1px solid var(--gold);
  background: var(--gold-faint);
  color: var(--gold);
  font: inherit;
  font-size: 0.6875rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  cursor: pointer;
}

.werft__knopf:hover:not(:disabled) {
  background: rgb(230 207 120 / 22%);
}

.werft__knopf:disabled {
  opacity: 0.4;
  cursor: default;
}

/* --- Perks ---------------------------------------------------------------- */

.werft__perks {
  display: flex;
  gap: 0.4rem;
}

.werft__perkslot {
  width: 44px;
  height: 44px;
  display: grid;
  place-items: center;
  padding: 2px;
  border: 1px dashed var(--gold-border);
  background: rgb(0 0 0 / 25%);
  color: var(--gold);
  font-size: 1.1rem;
  cursor: pointer;
}

.werft__perkslot img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.werft__perkslot:hover,
.werft__perkslot--offen {
  border-color: var(--gold);
  border-style: solid;
}

.werft__perk-optionen {
  display: grid;
  gap: 0.25rem;
  padding: 0.4rem;
  border: 1px solid var(--gold-border);
  background: rgb(0 0 0 / 30%);
}

.werft__perk-option {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0.3rem 0.4rem;
  border: 1px solid transparent;
  background: none;
  color: inherit;
  font: inherit;
  font-size: 0.75rem;
  text-align: left;
  cursor: pointer;
}

.werft__perk-option:hover:not(:disabled) {
  border-color: var(--gold-border);
  background: var(--gold-faint);
}

.werft__perk-option--leeren {
  opacity: 0.75;
}

.werft__perk-option-icon {
  width: 26px;
  height: 26px;
  object-fit: cover;
}

.werft__perk-option-name {
  flex: 1;
  min-width: 0;
  font-weight: 600;
}

.werft__perk-option-effekt {
  font-size: 0.625rem;
  color: var(--gold);
  opacity: 0.85;
  white-space: nowrap;
}

/* --- Kaufwerft ------------------------------------------------------------ */

.werft__angebote {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(20rem, 1fr));
  gap: 0.5rem;
}

.werft__angebot {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.45rem 0.55rem;
  border: 1px solid var(--gold-border);
  background: rgb(0 0 0 / 20%);
}

.werft__bild--klein {
  flex: 0 0 84px;
  width: 84px;
}

.werft__angebot-name {
  flex: 1;
  min-width: 0;
  font-weight: 600;
  font-size: 0.8125rem;
}

.werft__angebot-preis {
  font-size: 0.8125rem;
  color: var(--gold-bright);
  white-space: nowrap;
}
</style>
