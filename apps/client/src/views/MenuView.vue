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
  progressionFromXp,
} from '@subwarfare/shared';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import menuMusicUrl from '../assets/audio/mainmenu.mp3';
import { mapLabel } from '../config';
import { API_URL, account, confirmDiscordLink, logout, restoreSession } from '../state/auth';
import {
  buyItem,
  economyBusy,
  economyError,
  equip,
  equippedItem,
  ownedQuantity,
  refreshInventory,
} from '../state/economy';
import {
  joinQueue,
  lastEndReason,
  leaveQueue,
  queueError,
  queuePosition,
  queueState,
} from '../state/lobby';
import { itemIconUrl } from '../ui/itemIcons';
import { rankIconUrl } from '../ui/rankIcons';
import SettingsPanel from '../ui/SettingsPanel.vue';
import { volumes } from '../state/settings';

const router = useRouter();

const settingsOpen = ref(false);

/**
 * Wählbare Karten. Solange es genau eine gibt, ist das eine Liste mit einem
 * Eintrag — die Auswahl-Mechanik steht damit trotzdem schon. Muss zu
 * KNOWN_MAPS des Backends passen, sonst antwortet die Lobby „Unbekannte Karte".
 */
const MAPS = [
  { id: 'ocean01', label: mapLabel('ocean01'), detail: '10 × 10 km · offene See' },
] as const;

const selectedMap = ref<string>(MAPS[0].id);

/**
 * Auslastung je Karte (Spieler an Bord) — vom Backend, alle 10 s
 * aufgefrischt. Null, solange noch keine Antwort da ist.
 */
const mapStatus = ref<Record<string, { players: number; capacity: number }>>({});
let statusTimer: number | null = null;

async function refreshMapStatus(): Promise<void> {
  try {
    const response = await fetch(`${API_URL}/api/maps/status`);
    if (!response.ok) return;
    const data = (await response.json()) as {
      maps?: Array<{ mapId: string; players: number; capacity: number }>;
    };
    const next: Record<string, { players: number; capacity: number }> = {};
    for (const map of data.maps ?? []) {
      next[map.mapId] = { players: map.players, capacity: map.capacity };
    }
    mapStatus.value = next;
  } catch {
    // Menü bleibt benutzbar — die Anzeige zeigt dann schlicht nichts.
  }
}

/** Einmalig anzeigen, warum die letzte Partie endete, dann vergessen. */
const endReason = ref(lastEndReason.value);
lastEndReason.value = null;

const coinsFormat = new Intl.NumberFormat('de-DE');

/** Level, Rang und Fortschritt — abgeleitet aus dem XP-Stand des Kontos. */
const progression = computed(() => progressionFromXp(account.value?.xp ?? 0));
const coins = computed(() => coinsFormat.format(account.value?.coins ?? 0));
const rawCoins = computed(() => account.value?.coins ?? 0);
const rankIcon = computed(() => rankIconUrl(progression.value.level));

const waiting = computed(() => queueState.value === 'waiting' || queueState.value === 'connecting');

/* --- Werft: Schiffswahl + Ausrüstung ------------------------------------ */

const SHIP_LABELS: Record<PlayableModel, string> = {
  fregatte01: 'Fregatte',
  fregatte02: 'Fregatte II',
  submarine01: 'U-Boot',
  submarine02: 'U-Boot II',
  destroyer01: 'Zerstörer',
  destroyer02: 'Zerstörer II',
};

const SHIP_KEY = 'subwarfare:ship';

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

/** Besitz einer Kategorie in Katalog-Reihenfolge (aufsteigend nach Stärke). */
function ownedInCategory(category: ItemCategory): Array<ItemDefinition & { quantity: number }> {
  return ITEMS.filter((item) => item.category === category)
    .map((item) => ({ ...item, quantity: ownedQuantity(item.id) }))
    .filter((item) => item.quantity > 0);
}

async function equipSlot(slot: ItemCategory, itemId: ItemId | null): Promise<void> {
  await equip(effectiveShip.value, slot, itemId);
  activeSlot.value = null;
}

/* --- Inventar + Shop (rechte Spalte) ------------------------------------ */

const sideTab = ref<'inventar' | 'shop'>('inventar');

/** Kaufbare Items — der Katalog kennt auch unverkäufliche (nur erspielbar). */
const shopItems = ITEMS.filter((item) => item.shopPrice !== null);

/** Besitz in Katalog-Reihenfolge, nur was da ist. */
const ownedList = computed(() =>
  ITEMS.map((item) => ({ ...item, quantity: ownedQuantity(item.id) })).filter(
    (item) => item.quantity > 0,
  ),
);

async function buy(itemId: ItemId): Promise<void> {
  await buyItem(itemId);
}

function play(): void {
  endReason.value = null;
  if (!canAffordSortie.value) return;
  joinQueue(selectedMap.value, effectiveShip.value, () => {
    void router.push({ name: 'play' });
  });
}

function cancel(): void {
  leaveQueue();
}

function signOut(): void {
  leaveQueue();
  logout();
  void router.replace({ name: 'login' });
}

/* --- Hintergrundmusik --------------------------------------------------- */

/**
 * Dezent untergemischt: 0,15 ist Kulisse, kein Vordergrund. Eingeblendet wird
 * über eine Sekunde — ein harter Einsatz bei voller Ziellautstärke wirkt wie
 * ein Fehler, nicht wie Musik. Der Ambient-Regler aus den Einstellungen
 * skaliert das Ziel; `watch` unten zieht ihn live nach.
 */
const MUSIC_VOLUME = 0.15;
const FADE_SECONDS = 1;

function musicTarget(): number {
  return MUSIC_VOLUME * volumes.value.ambient;
}

let music: HTMLAudioElement | null = null;
let fadeTimer: number | null = null;
let startOnGesture: (() => void) | null = null;

function fadeIn(audio: HTMLAudioElement): void {
  const stepMs = 50;
  const step = MUSIC_VOLUME / ((FADE_SECONDS * 1000) / stepMs);
  audio.volume = 0;
  fadeTimer = window.setInterval(() => {
    audio.volume = Math.min(audio.volume + step, musicTarget());
    if (audio.volume >= musicTarget() && fadeTimer !== null) {
      clearInterval(fadeTimer);
      fadeTimer = null;
    }
  }, stepMs);
}

// Regler-Änderung wirkt sofort auf die laufende Musik (sofern nicht gerade
// eingeblendet wird — die Blende endet ohnehin am neuen Ziel).
watch(
  () => volumes.value.ambient,
  () => {
    if (music && fadeTimer === null) music.volume = musicTarget();
  },
);

function startMusic(): void {
  if (!music) return;
  music
    .play()
    .then(() => fadeIn(music!))
    .catch(() => {
      // Autoplay ohne vorherige Nutzergeste blockt der Browser (direkter
      // Seitenaufruf von /menu). Dann eben ab der ersten Interaktion — die
      // Listener räumen sich selbst weg.
      startOnGesture = () => {
        startOnGesture = null;
        music?.play().then(() => fadeIn(music!)).catch(() => {});
      };
      window.addEventListener('pointerdown', handleGesture, { once: true });
      window.addEventListener('keydown', handleGesture, { once: true });
    });
}

function handleGesture(): void {
  startOnGesture?.();
}

onMounted(() => {
  music = new Audio(menuMusicUrl);
  music.loop = true;
  music.preload = 'auto';
  if (import.meta.env.DEV) {
    // Prüfbarkeit im Dev-Build: `new Audio` hängt nicht im DOM, von außen wäre
    // der Abspielzustand sonst unsichtbar. Gleiches Muster wie `__game`.
    (window as unknown as { __menuMusic?: HTMLAudioElement }).__menuMusic = music;
  }
  startMusic();

  // Rücklauf der Discord-Verknüpfung (Einstellungen → Discord → hierher):
  // Im Fragment steht nur ein BELEG über die geprüfte Identität; verknüpft
  // wird erst hier, mit dem Sitzungs-Token — ein Beleg für ein fremdes Konto
  // wird vom Server abgelehnt. Das Fragment verschwindet sofort aus der
  // Adresszeile, es hat in Verlauf und Lesezeichen nichts verloren.
  if (location.hash) {
    const fragment = new URLSearchParams(location.hash.slice(1));
    const ticket = fragment.get('linkticket');
    if (ticket) {
      history.replaceState(null, '', location.pathname + location.search);
      void confirmDiscordLink(ticket).then((failure) => {
        endReason.value = failure ?? 'Discord-Konto verknüpft.';
      });
    }
  }

  // Profil FRISCH laden: Einsatzkosten bucht die api bei der Ticketausgabe ab,
  // XP und Coins ändern sich im Spiel — wer aus der Partie zurückkommt, soll
  // den echten Kontostand sehen, nicht den von vor dem Auslaufen.
  void restoreSession();
  void refreshMapStatus();
  void refreshInventory();
  statusTimer = window.setInterval(() => void refreshMapStatus(), 10_000);
});

onBeforeUnmount(() => {
  // Wer das Menü verlässt, ohne zu spielen, steht nicht weiter in der Schlange.
  if (queueState.value === 'waiting' || queueState.value === 'connecting') leaveQueue();

  if (statusTimer !== null) clearInterval(statusTimer);
  statusTimer = null;

  // Musik gehört zum Menü — auf der Karte zählt das Sonar, nicht der Score.
  if (fadeTimer !== null) clearInterval(fadeTimer);
  fadeTimer = null;
  startOnGesture = null;
  window.removeEventListener('pointerdown', handleGesture);
  window.removeEventListener('keydown', handleGesture);
  music?.pause();
  music = null;
});
</script>

<template>
  <div class="menu game-cursor">
    <!-- Links: Wer bin ich, was habe ich — darunter die Perks. -->
    <div class="menu__col">
      <section class="gold-panel menu__panel menu__identity" aria-label="Konto">
        <button
          class="menu__settings"
          type="button"
          title="Einstellungen"
          aria-label="Einstellungen"
          @click="settingsOpen = true"
        >
          <span class="material-symbols-outlined">settings</span>
        </button>
        <header class="menu__head">
          <img
            v-if="account?.avatarUrl"
            class="menu__avatar"
            :src="account.avatarUrl"
            alt=""
            referrerpolicy="no-referrer"
          />
          <div v-else class="menu__avatar menu__avatar--fallback">
            {{ (account?.displayName ?? '?').slice(0, 1).toUpperCase() }}
          </div>
          <div class="menu__who">
            <h1 class="menu__name">{{ account?.displayName ?? '—' }}</h1>
            <p class="menu__meta">{{ account?.isDev ? 'Entwickler-Konto' : 'Kapitän' }}</p>
          </div>
        </header>

        <div class="menu__rank">
          <img v-if="rankIcon" class="menu__rank-icon" :src="rankIcon" alt="" />
          <div class="menu__rank-text">
            <span class="menu__rank-name">{{ progression.rank }}</span>
            <span class="menu__rank-level">Level {{ progression.level }}</span>
          </div>
        </div>

        <div class="menu__xp">
          <div class="menu__xp-bar">
            <div :style="{ width: `${Math.round(progression.progress * 100)}%` }"></div>
          </div>
          <p class="menu__xp-text hud__num">
            <template v-if="progression.xpForNext > 0">
              {{ coinsFormat.format(progression.xpIntoLevel) }} /
              {{ coinsFormat.format(progression.xpForNext) }} XP
            </template>
            <template v-else>Höchstrang erreicht</template>
          </p>
        </div>

        <div class="menu__coins">
          <img class="menu__coin" src="../assets/ui/coin.png" alt="" />
          <span class="menu__coins-amount hud__num">{{ coins }}</span>
          <span class="menu__coins-label">Coins</span>
        </div>

        <button class="menu__logout" type="button" @click="signOut">Abmelden</button>
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

    <!-- Mitte: der Weg aufs Wasser — darunter die Ausrüstung. -->
    <div class="menu__col menu__mid">
      <section class="gold-panel menu__panel menu__queue" aria-label="Einsatz">
        <h2 class="gold-panel__title">Einsatz</h2>

        <p v-if="endReason" class="menu__notice">{{ endReason }}</p>

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
              <span class="menu__ship-name">{{ SHIP_LABELS[model] }}</span>
              <span v-if="shipLocked(model)" class="menu__ship-status">
                Ab Level {{ SHIP_ACCESS[model].minLevel }}
              </span>
              <span v-else-if="SHIP_ACCESS[model].sortieCost > 0" class="menu__ship-status">
                <img class="menu__coin menu__coin--small" src="../assets/ui/coin.png" alt="" />
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
                {{ equippedName(slot) ?? '— leer —' }}
              </span>
            </button>
            <div v-if="activeSlot === slot" class="menu__slot-options">
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
                <span>{{ item.name }}</span>
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

    <!-- Rechts: Aufträge, Schiffe — und darunter Inventar + Shop. -->
    <div class="menu__side">
      <section class="gold-panel menu__panel" aria-label="Aufträge">
        <h2 class="gold-panel__title">Aufträge</h2>
        <p class="menu__soon">Noch keine Aufträge verfügbar.</p>
      </section>

      <section class="gold-panel menu__panel" aria-label="Schiffe">
        <h2 class="gold-panel__title">Schiffe</h2>
        <ul class="menu__fleet">
          <li v-for="model in PLAYABLE_MODELS" :key="model" class="menu__fleet-row">
            <span>{{ SHIP_LABELS[model] }}</span>
            <span v-if="shipLocked(model)" class="menu__fleet-lock">
              Level {{ SHIP_ACCESS[model].minLevel }}
            </span>
            <span v-else class="menu__fleet-free">Freigeschaltet</span>
          </li>
        </ul>
      </section>

      <section class="gold-panel menu__panel" aria-label="Inventar und Shop">
        <div class="menu__tabs" role="tablist">
          <button
            type="button"
            class="menu__tab"
            :class="{ 'menu__tab--active': sideTab === 'inventar' }"
            role="tab"
            :aria-selected="sideTab === 'inventar'"
            @click="sideTab = 'inventar'"
          >
            Inventar
          </button>
          <button
            type="button"
            class="menu__tab"
            :class="{ 'menu__tab--active': sideTab === 'shop' }"
            role="tab"
            :aria-selected="sideTab === 'shop'"
            @click="sideTab = 'shop'"
          >
            Shop
          </button>
        </div>

        <template v-if="sideTab === 'inventar'">
          <ul v-if="ownedList.length > 0" class="menu__items">
            <li v-for="item in ownedList" :key="item.id" class="menu__item">
              <img
                v-if="itemIconUrl(item.id)"
                class="menu__item-icon"
                :src="itemIconUrl(item.id)!"
                alt=""
              />
              <span class="menu__item-name">{{ item.name }}</span>
              <span class="menu__item-qty hud__num">×{{ item.quantity }}</span>
            </li>
          </ul>
          <p v-else class="menu__soon">Noch keine Items — schau im Shop vorbei.</p>
        </template>

        <template v-else>
          <ul class="menu__items">
            <li v-for="item in shopItems" :key="item.id" class="menu__item menu__item--shop">
              <img
                v-if="itemIconUrl(item.id)"
                class="menu__item-icon"
                :src="itemIconUrl(item.id)!"
                alt=""
              />
              <span class="menu__item-name">{{ item.name }}</span>
              <span class="menu__item-price hud__num">
                <img class="menu__coin menu__coin--small" src="../assets/ui/coin.png" alt="" />
                {{ item.shopPrice }}
              </span>
              <button
                type="button"
                class="menu__buy"
                :disabled="economyBusy || rawCoins < (item.shopPrice ?? 0)"
                @click="buy(item.id)"
              >
                Kaufen
              </button>
            </li>
          </ul>
          <p v-if="economyError" class="menu__error">{{ economyError }}</p>
        </template>
      </section>
    </div>

    <SettingsPanel v-if="settingsOpen" @close="settingsOpen = false" />
  </div>
</template>

<style scoped>
.menu {
  height: 100%;
  display: grid;
  /* Rechte Spalte bewusst breiter (+30 %): Inventar- und Shop-Zeilen tragen
     Icon + Name + Preis + Knopf — in 320 px wurde das gequetscht. */
  grid-template-columns: minmax(260px, 320px) minmax(320px, 1fr) minmax(340px, 420px);
  gap: 1rem;
  align-items: start;
  padding: 1.25rem;
  overflow-y: auto;
  background: url('../assets/ui/menu-bg.webp') center / cover no-repeat #04141f;
}

/*
 * Deutlich zartere Vignette als am Login: das Hafen-Aquarell ist hell und
 * flächig — der dunkle Navy-Schleier des Login-Screens würde es zukleistern.
 * Die Panels sind ohnehin deckend, Lesbarkeit hängt nicht am Hintergrund.
 */
.menu::before {
  content: '';
  position: fixed;
  inset: 0;
  background: radial-gradient(ellipse at center, rgb(4 20 31 / 12%) 0%, rgb(4 20 31 / 8%) 60%, rgb(4 20 31 / 30%) 100%);
  pointer-events: none;
}

.menu__col {
  display: grid;
  gap: 1rem;
}

.menu__panel {
  position: relative;
  padding: 0.9rem 1.1rem 1rem;
}

/* Die Mitte trägt den Hauptweg — sie darf breiter atmen und rückt optisch
   ins Zentrum der Seehöhe. */
.menu__mid {
  max-width: 30rem;
  justify-self: center;
  width: 100%;
  margin-top: 4vh;
}

.menu__side {
  display: grid;
  gap: 1rem;
}

/* --- Identität ---------------------------------------------------------- */

.menu__settings {
  position: absolute;
  top: 0.65rem;
  right: 0.75rem;
  display: inline-flex;
  padding: 0.15rem;
  border: none;
  background: none;
  color: var(--gold);
  opacity: 0.65;
  cursor: pointer;
}

.menu__settings:hover {
  opacity: 1;
}

.menu__settings .material-symbols-outlined {
  font-size: 20px;
}

.menu__head {
  display: flex;
  align-items: center;
  gap: 0.8rem;
  /* Platz fürs absolut sitzende Zahnrad — lange Namen liefen sonst darunter. */
  padding-right: 2rem;
}

.menu__who {
  min-width: 0;
}

.menu__avatar {
  width: 48px;
  height: 48px;
  border: 1px solid var(--gold-border);
  object-fit: cover;
}

.menu__avatar--fallback {
  display: grid;
  place-items: center;
  background: var(--gold-faint);
  color: var(--gold);
  font-size: 1.3rem;
  font-weight: 600;
}

.menu__name {
  margin: 0;
  font-size: 1.05rem;
  letter-spacing: 0.06em;
  /* Discord-Handles ohne Leerzeichen brechen sonst gar nicht um. */
  overflow-wrap: anywhere;
}

.menu__meta {
  margin: 0.15rem 0 0;
  font-size: 0.6875rem;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  opacity: 0.55;
}

.menu__rank {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  margin-top: 0.9rem;
  padding-top: 0.8rem;
  border-top: 1px solid var(--gold-border);
}

.menu__rank-icon {
  width: 40px;
  height: 40px;
  image-rendering: -webkit-optimize-contrast;
}

.menu__rank-text {
  display: grid;
}

.menu__rank-name {
  font-weight: 600;
  letter-spacing: 0.04em;
}

.menu__rank-level {
  font-size: 0.6875rem;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: var(--gold);
  opacity: 0.85;
}

.menu__xp {
  margin-top: 0.6rem;
}

.menu__xp-bar {
  height: 4px;
  background: var(--gold-faint);
}

.menu__xp-bar > div {
  height: 100%;
  background: linear-gradient(90deg, var(--gold), var(--gold-bright));
}

.menu__xp-text {
  margin: 0.3rem 0 0;
  font-size: 0.6875rem;
  opacity: 0.6;
}

.menu__coins {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-top: 0.9rem;
  padding: 0.55rem 0.65rem;
  border: 1px solid var(--gold-border);
  background: rgb(0 0 0 / 30%);
}

.menu__coin {
  width: 18px;
  height: 18px;
  color: var(--gold-bright);
}

.menu__coin--small {
  width: 13px;
  height: 13px;
  vertical-align: -2px;
}

.menu__coins-amount {
  font-size: 1rem;
  font-weight: 600;
  color: var(--gold-bright);
}

.menu__coins-label {
  font-size: 0.6875rem;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  opacity: 0.55;
}

.menu__logout {
  margin-top: 1rem;
  padding: 0;
  border: none;
  background: none;
  color: #e9e2cd;
  font: inherit;
  font-size: 0.75rem;
  opacity: 0.45;
  cursor: pointer;
  text-decoration: underline;
}

.menu__logout:hover {
  opacity: 0.8;
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

/* --- Einsatz / Warteschlange ------------------------------------------- */

.menu__notice {
  margin: 0 0 0.8rem;
  padding: 0.5rem 0.65rem;
  border: 1px solid rgb(226 180 90 / 40%);
  color: #e2b45a;
}

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

.menu__error {
  margin: 0.8rem 0 0;
  color: #f4b3b5;
}

.menu__soon {
  margin: 0;
  opacity: 0.5;
  line-height: 1.45;
}

/* --- Ausrüstung: Schiffswahl -------------------------------------------- */

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

/* --- Flotte (rechte Spalte) --------------------------------------------- */

.menu__fleet {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 0.35rem;
}

.menu__fleet-row {
  display: flex;
  justify-content: space-between;
  gap: 0.6rem;
  font-size: 0.8125rem;
}

.menu__fleet-lock {
  font-size: 0.6875rem;
  opacity: 0.5;
}

.menu__fleet-free {
  font-size: 0.6875rem;
  color: var(--gold);
  opacity: 0.85;
}

/* --- Inventar + Shop ---------------------------------------------------- */

.menu__tabs {
  display: flex;
  gap: 0.4rem;
  margin-bottom: 0.8rem;
}

.menu__tab {
  flex: 1;
  padding: 0.45rem 0.6rem;
  border: 1px solid var(--gold-border);
  background: rgb(0 0 0 / 25%);
  color: inherit;
  font: inherit;
  font-size: 0.75rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  cursor: pointer;
}

.menu__tab--active {
  border-color: var(--gold);
  background: var(--gold-faint);
  color: var(--gold);
}

.menu__items {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 0.35rem;
}

.menu__item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.35rem 0.5rem;
  border: 1px solid var(--gold-border);
  background: rgb(0 0 0 / 20%);
  font-size: 0.8125rem;
}

.menu__item-icon {
  width: 34px;
  height: 34px;
  flex: 0 0 auto;
  object-fit: contain;
  image-rendering: -webkit-optimize-contrast;
}

.menu__item-name {
  flex: 1;
}

.menu__item-qty {
  opacity: 0.7;
}

.menu__item-price {
  color: var(--gold-bright);
  white-space: nowrap;
}

.menu__buy {
  padding: 0.25rem 0.6rem;
  border: 1px solid var(--gold);
  background: var(--gold-faint);
  color: var(--gold);
  font: inherit;
  font-size: 0.6875rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  cursor: pointer;
}

.menu__buy:hover:not(:disabled) {
  background: rgb(230 207 120 / 22%);
}

.menu__buy:disabled {
  opacity: 0.4;
  cursor: default;
}

/* --- Schmale Fenster: untereinander ------------------------------------ */

@media (max-width: 980px) {
  .menu {
    grid-template-columns: 1fr;
  }

  .menu__mid {
    margin-top: 0;
    justify-self: stretch;
    max-width: none;
  }
}
</style>
