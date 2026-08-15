<script setup lang="ts">
import type { ItemCategory, ItemId } from '@subwarfare/shared';
import { BULK_CATEGORIES, ITEMS, SHOP_BUY_MAX } from '@subwarfare/shared';
import { computed, reactive, ref } from 'vue';
import { account } from '../../state/auth';
import { buyItem, economyBusy, economyError, ownedQuantity } from '../../state/economy';
import { itemIconUrl } from '../itemIcons';

/**
 * Depot: Inventar und Shop — der Handelsbereich des Hafens. Umzug aus der
 * alten Werft (die ist seit dem Werft-Umbau die Schiffsbasis); Logik
 * unverändert. Perk-Items erscheinen hier automatisch im Inventar (sie sind
 * Katalog-Items ohne Shop-Preis — nur erspielbar).
 */
const sideTab = ref<'inventar' | 'shop'>('inventar');

/** Kaufbare Items — der Katalog kennt auch unverkäufliche (nur erspielbar). */
const shopItems = ITEMS.filter((item) => item.shopPrice !== null);

/** Besitz in Katalog-Reihenfolge, nur was da ist. */
const ownedList = computed(() =>
  ITEMS.map((item) => ({ ...item, quantity: ownedQuantity(item.id) })).filter(
    (item) => item.quantity > 0,
  ),
);

const rawCoins = computed(() => account.value?.coins ?? 0);

/**
 * Mengenkauf für Verbrauchsgüter (Munition aller Art): gewählte Stückzahl je
 * Item, Start 1. Die ±-Knöpfe springen aufs 5er-Raster (1 → 5 → 10 → …),
 * die Eingabe nimmt jede Zahl bis SHOP_BUY_MAX — die api validiert dasselbe.
 */
const mengen = reactive<Partial<Record<ItemId, number>>>({});

function mengeVon(itemId: ItemId): number {
  return mengen[itemId] ?? 1;
}

function istMengenkauf(category: ItemCategory): boolean {
  return BULK_CATEGORIES.includes(category);
}

/** ±5 als Raster, nicht als Addition: von 1 geht es auf 5, von 7 runter auf 5. */
function stufe(itemId: ItemId, richtung: 1 | -1): void {
  const aktuell = mengeVon(itemId);
  mengen[itemId] =
    richtung > 0
      ? Math.min(SHOP_BUY_MAX, Math.floor(aktuell / 5) * 5 + 5)
      : Math.max(1, Math.ceil(aktuell / 5) * 5 - 5);
}

/** Freie Eingabe: ganzzahlig geklemmt; Unsinn fällt auf 1 zurück. */
function mengeEingabe(itemId: ItemId, event: Event): void {
  const feld = event.target as HTMLInputElement;
  const roh = Number.parseInt(feld.value, 10);
  const wert = Number.isFinite(roh) ? Math.min(SHOP_BUY_MAX, Math.max(1, roh)) : 1;
  mengen[itemId] = wert;
  // Zurückschreiben, damit „abc" oder „0" sichtbar zur echten Menge wird.
  feld.value = String(wert);
}

/** Gesamtpreis der gewählten Menge — das steht auch auf dem Preisschild. */
function gesamt(item: (typeof shopItems)[number]): number {
  return (item.shopPrice ?? 0) * mengeVon(item.id);
}

async function buy(itemId: ItemId): Promise<void> {
  await buyItem(itemId, mengeVon(itemId));
}
</script>

<template>
  <section class="gold-panel menu__panel depot" aria-label="Inventar und Shop">
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
          <span v-if="istMengenkauf(item.category)" class="menu__menge">
            <button
              type="button"
              class="menu__menge-knopf"
              aria-label="5 weniger"
              @click="stufe(item.id, -1)"
            >
              −
            </button>
            <input
              class="menu__menge-eingabe hud__num"
              type="text"
              inputmode="numeric"
              :value="mengeVon(item.id)"
              :aria-label="`Stückzahl ${item.name}`"
              @change="mengeEingabe(item.id, $event)"
            />
            <button
              type="button"
              class="menu__menge-knopf"
              aria-label="5 mehr"
              @click="stufe(item.id, 1)"
            >
              +
            </button>
          </span>
          <span class="menu__item-price hud__num">
            <img class="menu__coin menu__coin--small" src="../../assets/ui/coin.png" alt="" />
            {{ gesamt(item) }}
          </span>
          <button
            type="button"
            class="menu__buy"
            :disabled="economyBusy || rawCoins < gesamt(item)"
            @click="buy(item.id)"
          >
            Kaufen
          </button>
        </li>
      </ul>
      <p v-if="economyError" class="menu__error">{{ economyError }}</p>
    </template>
  </section>
</template>

<style scoped>
/*
 * Das Depot braucht Fläche: Item-Zeilen tragen Icon + Name + Stepper + Preis
 * + Knopf. Deutlich breiter als die 34-rem-Vorgabe der Shell, die Listen
 * laufen dann zweispaltig.
 */
.depot {
  max-width: none !important;
  width: min(62rem, 100%);
}

.menu__items {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  /* Nutzt die Breite: zwei Spalten, bei schmalem Fenster automatisch eine. */
  grid-template-columns: repeat(auto-fill, minmax(26rem, 1fr));
  gap: 0.35rem 0.6rem;
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
  /* Darf schrumpfen (und umbrechen), sonst drückt der Stepper die Zeile auf. */
  min-width: 0;
}

/* --- Mengen-Stepper (nur Verbrauchsgüter) -------------------------------- */

.menu__menge {
  display: inline-flex;
  align-items: center;
  gap: 0.2rem;
  flex: 0 0 auto;
}

.menu__menge-knopf {
  width: 1.5rem;
  height: 1.5rem;
  border: 1px solid var(--gold-border);
  background: rgb(0 0 0 / 25%);
  color: var(--gold);
  font: inherit;
  font-size: 0.8125rem;
  line-height: 1;
  cursor: pointer;
}

.menu__menge-knopf:hover {
  border-color: var(--gold);
  background: var(--gold-faint);
}

.menu__menge-eingabe {
  width: 2.6rem;
  padding: 0.22rem 0.15rem;
  border: 1px solid var(--gold-border);
  background: rgb(0 0 0 / 30%);
  color: inherit;
  font: inherit;
  font-size: 0.75rem;
  text-align: center;
}

.menu__menge-eingabe:focus {
  outline: none;
  border-color: var(--gold);
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
</style>
