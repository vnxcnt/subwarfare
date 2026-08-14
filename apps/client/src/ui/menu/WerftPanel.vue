<script setup lang="ts">
import type { ItemId } from '@subwarfare/shared';
import { ITEMS } from '@subwarfare/shared';
import { computed, ref } from 'vue';
import { account } from '../../state/auth';
import { buyItem, economyBusy, economyError, ownedQuantity } from '../../state/economy';
import { itemIconUrl } from '../itemIcons';

/**
 * Werft: Inventar und Shop — der Handelsbereich des Hafens. Umzug aus der
 * rechten Spalte des alten Menüs; Logik unverändert, nur eigenständig.
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

async function buy(itemId: ItemId): Promise<void> {
  await buyItem(itemId);
}
</script>

<template>
  <section class="gold-panel menu__panel werft" aria-label="Inventar und Shop">
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
            <img class="menu__coin menu__coin--small" src="../../assets/ui/coin.png" alt="" />
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
</template>

<style scoped>
/*
 * Die Werft braucht Fläche: Item-Zeilen tragen Icon + Name + Preis + Knopf.
 * Deutlich breiter als die 34-rem-Vorgabe der Shell, die Listen laufen dann
 * zweispaltig — eine gestreckte Einzelspalte sähe nur leer aus.
 */
.werft {
  max-width: none !important;
  width: min(58rem, 100%);
}

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
  /* Nutzt die Breite: zwei Spalten, bei schmalem Fenster automatisch eine. */
  grid-template-columns: repeat(auto-fill, minmax(21rem, 1fr));
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
