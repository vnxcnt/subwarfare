<script setup lang="ts">
import type {
  FleetMineResponse,
  FleetSummary,
  InventoryItem,
  ItemId,
  ModAccountDetail,
  ModAccountSummary,
} from '@subwarfare/shared';
import {
  FLEET_RANK_LEADER,
  ITEMS,
  RANKS,
  ROLE_DEVELOPER,
  ROLE_GAMEMASTER,
  ROLE_MODERATOR,
  fleetRankName,
  isPlayableModel,
} from '@subwarfare/shared';
import { computed, ref } from 'vue';
import { API_URL, token } from '../../state/auth';
import { itemIconUrl } from '../itemIcons';
import { SHIP_LABELS } from './shipLabels';

/**
 * Moderation — Werkzeugkasten für Gamemaster und Entwickler: Konten prüfen,
 * Inventar setzen, Flottillen verwalten. Der Knopf ist rollen-gebunden, die
 * WAHRHEIT sitzt aber in der api: jede Route prüft die Rolle frisch am Konto.
 * Zustand lebt bewusst lokal — das Werkzeug braucht kein Menü-Gedächtnis.
 */
const reiter = ref<'konten' | 'flottillen'>('konten');
const fehler = ref<string | null>(null);
const beschaeftigt = ref(false);

async function api(path: string, body?: unknown): Promise<Response> {
  const headers = new Headers();
  if (token.value) headers.set('authorization', `Bearer ${token.value}`);
  if (body !== undefined) headers.set('content-type', 'application/json');
  return fetch(`${API_URL}/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function lade<T>(path: string, body?: unknown): Promise<T | null> {
  fehler.value = null;
  beschaeftigt.value = true;
  try {
    const response = await api(path, body);
    const data = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
    if (!response.ok) {
      fehler.value = data?.error ?? `Fehlgeschlagen (HTTP ${response.status}).`;
      return null;
    }
    return data;
  } catch {
    fehler.value = 'Server ist nicht erreichbar.';
    return null;
  } finally {
    beschaeftigt.value = false;
  }
}

const ROLLEN_LABEL: Record<number, string> = {
  0: 'Spieler',
  [ROLE_MODERATOR]: 'Moderator',
  [ROLE_GAMEMASTER]: 'Gamemaster',
  [ROLE_DEVELOPER]: 'Entwickler',
};

function datum(iso: string): string {
  const wert = new Date(iso);
  return Number.isNaN(wert.getTime()) ? '—' : wert.toLocaleString('de-DE');
}

/* --- Konten --------------------------------------------------------------- */

const kontoSuche = ref('');
const kontoTreffer = ref<ModAccountSummary[]>([]);
const kontoGesucht = ref(false);
const konto = ref<ModAccountDetail | null>(null);

async function kontenSuchen(): Promise<void> {
  konto.value = null;
  const data = await lade<{ accounts: ModAccountSummary[] }>(
    `/mod/accounts?q=${encodeURIComponent(kontoSuche.value.trim())}`,
  );
  if (data) {
    kontoTreffer.value = data.accounts;
    kontoGesucht.value = true;
  }
}

async function kontoOeffnen(id: string): Promise<void> {
  const data = await lade<ModAccountDetail>(`/mod/accounts/${encodeURIComponent(id)}`);
  if (data) konto.value = data;
}

function schiffLabel(model: string): string {
  return isPlayableModel(model) ? SHIP_LABELS[model] : model;
}

/* --- Inventar setzen ------------------------------------------------------ */

/** Eingaben je Item-Zeile (bestehende Posten UND die Hinzufügen-Zeile). */
const mengenEingabe = ref<Partial<Record<string, string>>>({});
const neuesItem = ref<ItemId>(ITEMS[0].id);

function eingabeFuer(item: InventoryItem): string {
  return mengenEingabe.value[item.itemId] ?? String(item.quantity);
}

async function bestandSetzen(itemId: string, roh: string): Promise<void> {
  if (!konto.value) return;
  const wert = Number.parseInt(roh, 10);
  if (!Number.isFinite(wert) || wert < 0) {
    fehler.value = 'Stückzahl: ganze Zahl ab 0.';
    return;
  }
  const data = await lade<{ items: InventoryItem[] }>('/mod/items', {
    accountId: konto.value.id,
    itemId,
    quantity: wert,
  });
  if (data && konto.value) {
    konto.value = { ...konto.value, items: data.items };
    mengenEingabe.value = {};
  }
}

function itemName(itemId: string): string {
  return ITEMS.find((eintrag) => eintrag.id === itemId)?.name ?? itemId;
}

/* --- Flottillen ----------------------------------------------------------- */

const flottenSuche = ref('');
const flottenTreffer = ref<FleetSummary[]>([]);
const flottenGesucht = ref(false);
const flottille = ref<FleetMineResponse | null>(null);
/** Zweistufige Auflösung: erster Klick scharf, zweiter löst aus. */
const aufloesenScharf = ref(false);

async function flottenSuchen(): Promise<void> {
  flottille.value = null;
  aufloesenScharf.value = false;
  const data = await lade<{ fleets: FleetSummary[] }>(
    `/mod/fleets?q=${encodeURIComponent(flottenSuche.value.trim())}`,
  );
  if (data) {
    flottenTreffer.value = data.fleets;
    flottenGesucht.value = true;
  }
}

async function flottilleOeffnen(id: string): Promise<void> {
  aufloesenScharf.value = false;
  const data = await lade<FleetMineResponse>(`/mod/fleets/${encodeURIComponent(id)}`);
  if (data) flottille.value = data;
}

async function mitgliedEntlassen(accountId: string): Promise<void> {
  if (!flottille.value) return;
  const data = await lade<{ fleet: FleetMineResponse | null }>('/mod/fleets/kick', {
    fleetId: flottille.value.fleet.id,
    accountId,
  });
  if (data) flottille.value = data.fleet ?? null;
}

async function aufloesen(): Promise<void> {
  if (!flottille.value) return;
  if (!aufloesenScharf.value) {
    aufloesenScharf.value = true;
    return;
  }
  const data = await lade<{ ok: boolean }>('/mod/fleets/disband', {
    fleetId: flottille.value.fleet.id,
  });
  if (data?.ok) {
    flottille.value = null;
    aufloesenScharf.value = false;
    await flottenSuchen();
  }
}

const istKommandant = computed(
  () => (mitglied: { rank: number }) => mitglied.rank === FLEET_RANK_LEADER,
);
void istKommandant;
</script>

<template>
  <section class="gold-panel menu__panel mod" aria-label="Moderation">
    <div class="menu__tabs" role="tablist">
      <button
        type="button"
        class="menu__tab"
        :class="{ 'menu__tab--active': reiter === 'konten' }"
        role="tab"
        :aria-selected="reiter === 'konten'"
        @click="reiter = 'konten'"
      >
        Konten
      </button>
      <button
        type="button"
        class="menu__tab"
        :class="{ 'menu__tab--active': reiter === 'flottillen' }"
        role="tab"
        :aria-selected="reiter === 'flottillen'"
        @click="reiter = 'flottillen'"
      >
        Flottillen
      </button>
    </div>

    <!-- ===================== Konten ===================== -->
    <template v-if="reiter === 'konten'">
      <form class="mod__suche" @submit.prevent="kontenSuchen">
        <input
          v-model="kontoSuche"
          type="text"
          maxlength="24"
          placeholder="Spielername suchen …"
          autocomplete="off"
        />
        <button type="submit" :disabled="beschaeftigt || kontoSuche.trim().length < 2">
          Suchen
        </button>
      </form>

      <ul v-if="!konto && kontoGesucht" class="mod__liste">
        <li v-if="kontoTreffer.length === 0" class="menu__soon">Kein Konto gefunden.</li>
        <li v-for="treffer in kontoTreffer" :key="treffer.id">
          <button type="button" class="mod__zeile" @click="kontoOeffnen(treffer.id)">
            <span class="mod__zeile-name">{{ treffer.displayName }}</span>
            <span class="mod__zeile-rolle" :class="`mod__rolle--${treffer.role}`">
              {{ ROLLEN_LABEL[treffer.role] ?? treffer.role }}
            </span>
            <span class="mod__zeile-meta hud__num">Lvl {{ treffer.level }}</span>
            <span class="mod__zeile-meta hud__num">
              <img class="menu__coin menu__coin--small" src="../../assets/ui/coin.png" alt="" />
              {{ treffer.coins }}
            </span>
          </button>
        </li>
      </ul>

      <div v-if="konto" class="mod__detail">
        <button type="button" class="mod__zurueck" @click="konto = null">‹ Zurück zur Suche</button>

        <h3 class="mod__titel">
          {{ konto.displayName }}
          <span class="mod__zeile-rolle" :class="`mod__rolle--${konto.role}`">
            {{ ROLLEN_LABEL[konto.role] ?? konto.role }}
          </span>
        </h3>

        <dl class="mod__daten">
          <div><dt>Konto-ID</dt><dd class="hud__num">{{ konto.id }}</dd></div>
          <div><dt>Coins</dt><dd class="hud__num">{{ konto.coins }}</dd></div>
          <div><dt>XP / Level</dt><dd class="hud__num">{{ konto.xp }} · Lvl {{ konto.level }} ({{ RANKS[konto.level - 1] }})</dd></div>
          <div><dt>PvP</dt><dd class="hud__num">{{ konto.kills }} Kills / {{ konto.deaths }} Tode</dd></div>
          <div><dt>Erstellt</dt><dd>{{ datum(konto.createdAt) }}</dd></div>
          <div><dt>Letzter Login</dt><dd>{{ datum(konto.lastLoginAt) }}</dd></div>
          <div><dt>Verknüpft</dt><dd>{{ [konto.hasGoogle ? 'Google' : null, konto.hasDiscord ? 'Discord' : null].filter(Boolean).join(' · ') || '—' }}</dd></div>
          <div>
            <dt>Flottille</dt>
            <dd>
              <template v-if="konto.fleet">
                {{ konto.fleet.name }} ({{ fleetRankName(konto.fleet.rank) }})
              </template>
              <template v-else>—</template>
            </dd>
          </div>
        </dl>

        <h4 class="mod__abschnitt">Flotte</h4>
        <ul class="mod__schiffe">
          <li v-for="ship in konto.ships" :key="ship.shipId" class="mod__schiff hud__num">
            {{ schiffLabel(ship.model) }} — {{ ship.hp }}/{{ ship.maxHp }} HP
            <template v-if="ship.repairUntil"> · in Reparatur</template>
            <template v-if="ship.perks.length"> · Perks: {{ ship.perks.join(', ') }}</template>
          </li>
        </ul>

        <h4 class="mod__abschnitt">Inventar</h4>
        <ul class="mod__liste">
          <li v-for="item in konto.items" :key="item.itemId" class="mod__item">
            <img
              v-if="itemIconUrl(item.itemId)"
              class="mod__item-icon"
              :src="itemIconUrl(item.itemId)!"
              alt=""
            />
            <span class="mod__item-name">{{ itemName(item.itemId) }}</span>
            <input
              class="mod__item-menge hud__num"
              type="text"
              inputmode="numeric"
              :value="eingabeFuer(item)"
              :aria-label="`Bestand ${itemName(item.itemId)}`"
              @input="mengenEingabe[item.itemId] = ($event.target as HTMLInputElement).value"
            />
            <button
              type="button"
              class="mod__knopf"
              :disabled="beschaeftigt"
              @click="bestandSetzen(item.itemId, eingabeFuer(item))"
            >
              Setzen
            </button>
            <button
              type="button"
              class="mod__knopf mod__knopf--leise"
              :disabled="beschaeftigt"
              @click="bestandSetzen(item.itemId, '0')"
            >
              Entfernen
            </button>
          </li>
          <li v-if="konto.items.length === 0" class="menu__soon">Inventar ist leer.</li>
        </ul>

        <div class="mod__hinzufuegen">
          <select v-model="neuesItem" class="mod__select">
            <option v-for="item in ITEMS" :key="item.id" :value="item.id">{{ item.name }}</option>
          </select>
          <input
            class="mod__item-menge hud__num"
            type="text"
            inputmode="numeric"
            :value="mengenEingabe[`neu:${neuesItem}`] ?? '1'"
            aria-label="Stückzahl des neuen Items"
            @input="mengenEingabe[`neu:${neuesItem}`] = ($event.target as HTMLInputElement).value"
          />
          <button
            type="button"
            class="mod__knopf"
            :disabled="beschaeftigt"
            @click="bestandSetzen(neuesItem, mengenEingabe[`neu:${neuesItem}`] ?? '1')"
          >
            Ins Inventar setzen
          </button>
        </div>
      </div>
    </template>

    <!-- ===================== Flottillen ===================== -->
    <template v-else>
      <form class="mod__suche" @submit.prevent="flottenSuchen">
        <input
          v-model="flottenSuche"
          type="text"
          maxlength="30"
          placeholder="Flottille suchen (leer = neueste) …"
          autocomplete="off"
        />
        <button type="submit" :disabled="beschaeftigt">Suchen</button>
      </form>

      <ul v-if="!flottille && flottenGesucht" class="mod__liste">
        <li v-if="flottenTreffer.length === 0" class="menu__soon">Keine Flottille gefunden.</li>
        <li v-for="treffer in flottenTreffer" :key="treffer.id">
          <button type="button" class="mod__zeile" @click="flottilleOeffnen(treffer.id)">
            <span class="mod__zeile-name">{{ treffer.name }}</span>
            <span class="mod__zeile-meta hud__num">{{ treffer.members }} Mitglieder</span>
          </button>
        </li>
      </ul>

      <div v-if="flottille" class="mod__detail">
        <button type="button" class="mod__zurueck" @click="flottille = null; aufloesenScharf = false">
          ‹ Zurück zur Suche
        </button>

        <h3 class="mod__titel">{{ flottille.fleet.name }}</h3>
        <dl class="mod__daten">
          <div><dt>Kasse</dt><dd class="hud__num">{{ flottille.fleet.treasury }} Coins</dd></div>
          <div><dt>Gegründet</dt><dd>{{ datum(flottille.fleet.createdAt) }}</dd></div>
          <div v-if="flottille.fleet.description"><dt>Beschreibung</dt><dd>{{ flottille.fleet.description }}</dd></div>
        </dl>

        <h4 class="mod__abschnitt">Mitglieder</h4>
        <ul class="mod__liste">
          <li v-for="mitglied in flottille.members" :key="mitglied.accountId" class="mod__item">
            <span class="mod__item-name">{{ mitglied.displayName }}</span>
            <span class="mod__zeile-meta">{{ fleetRankName(mitglied.rank) }}</span>
            <button
              v-if="mitglied.rank !== FLEET_RANK_LEADER"
              type="button"
              class="mod__knopf mod__knopf--leise"
              :disabled="beschaeftigt"
              @click="mitgliedEntlassen(mitglied.accountId)"
            >
              Entlassen
            </button>
          </li>
        </ul>

        <button
          type="button"
          class="mod__knopf mod__knopf--gefahr"
          :disabled="beschaeftigt"
          @click="aufloesen"
        >
          {{ aufloesenScharf ? 'Wirklich auflösen? Erneut klicken!' : 'Flottille auflösen' }}
        </button>
      </div>
    </template>

    <p v-if="fehler" class="menu__error">{{ fehler }}</p>
  </section>
</template>

<style scoped>
.mod {
  max-width: none !important;
  width: min(58rem, 100%);
}

.mod__suche {
  display: flex;
  gap: 0.4rem;
  margin-bottom: 0.8rem;
}

.mod__suche input {
  flex: 1;
  min-width: 0;
  padding: 0.45rem 0.55rem;
  border: 1px solid var(--gold-border);
  background: rgb(0 0 0 / 35%);
  color: #e9e2cd;
  font: inherit;
  font-size: 0.8125rem;
}

.mod__suche button {
  padding: 0.45rem 0.8rem;
  border: 1px solid var(--gold);
  background: var(--gold-faint);
  color: var(--gold);
  font: inherit;
  font-size: 0.6875rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  cursor: pointer;
}

.mod__suche button:disabled {
  opacity: 0.4;
  cursor: default;
}

.mod__liste {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 0.3rem;
}

.mod__zeile {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.45rem 0.6rem;
  border: 1px solid var(--gold-border);
  background: rgb(0 0 0 / 20%);
  color: inherit;
  font: inherit;
  font-size: 0.8125rem;
  text-align: left;
  cursor: pointer;
}

.mod__zeile:hover {
  border-color: var(--gold);
}

.mod__zeile-name {
  flex: 1;
  min-width: 0;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.mod__zeile-rolle {
  font-size: 0.625rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.mod__rolle--0 {
  opacity: 0.6;
}

.mod__rolle--1 {
  color: #6fd08c;
}

.mod__rolle--2 {
  color: #f26d6d;
}

.mod__rolle--3 {
  color: #c58cf2;
}

.mod__zeile-meta {
  font-size: 0.6875rem;
  opacity: 0.75;
  white-space: nowrap;
}

.mod__detail {
  display: grid;
  gap: 0.6rem;
}

.mod__zurueck {
  justify-self: start;
  padding: 0.25rem 0.5rem;
  border: 1px solid var(--gold-border);
  background: rgb(0 0 0 / 25%);
  color: var(--gold);
  font: inherit;
  font-size: 0.6875rem;
  cursor: pointer;
}

.mod__titel {
  margin: 0;
  display: flex;
  align-items: baseline;
  gap: 0.6rem;
  font-size: 1rem;
  color: var(--gold-bright);
}

.mod__daten {
  margin: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(16rem, 1fr));
  gap: 0.35rem 1rem;
}

.mod__daten div {
  display: flex;
  gap: 0.5rem;
  align-items: baseline;
  font-size: 0.8125rem;
}

.mod__daten dt {
  flex: 0 0 auto;
  font-size: 0.625rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  opacity: 0.6;
}

.mod__daten dd {
  margin: 0;
  min-width: 0;
  overflow-wrap: anywhere;
}

.mod__abschnitt {
  margin: 0.4rem 0 0;
  font-size: 0.6875rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--gold);
  opacity: 0.85;
}

.mod__schiffe {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 0.2rem;
}

.mod__schiff {
  font-size: 0.75rem;
  opacity: 0.85;
}

.mod__item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.35rem 0.5rem;
  border: 1px solid var(--gold-border);
  background: rgb(0 0 0 / 20%);
  font-size: 0.8125rem;
}

.mod__item-icon {
  width: 28px;
  height: 28px;
  flex: 0 0 auto;
  object-fit: contain;
}

.mod__item-name {
  flex: 1;
  min-width: 0;
}

.mod__item-menge {
  width: 4rem;
  padding: 0.25rem 0.3rem;
  border: 1px solid var(--gold-border);
  background: rgb(0 0 0 / 30%);
  color: inherit;
  font: inherit;
  font-size: 0.75rem;
  text-align: center;
}

.mod__knopf {
  padding: 0.3rem 0.55rem;
  border: 1px solid var(--gold);
  background: var(--gold-faint);
  color: var(--gold);
  font: inherit;
  font-size: 0.625rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  cursor: pointer;
}

.mod__knopf:hover:not(:disabled) {
  background: rgb(230 207 120 / 22%);
}

.mod__knopf:disabled {
  opacity: 0.4;
  cursor: default;
}

.mod__knopf--leise {
  border-color: var(--gold-border);
  background: rgb(0 0 0 / 25%);
  color: inherit;
  opacity: 0.85;
}

.mod__knopf--gefahr {
  justify-self: start;
  border-color: #f26d6d;
  background: rgb(242 109 109 / 12%);
  color: #f26d6d;
}

.mod__knopf--gefahr:hover:not(:disabled) {
  background: rgb(242 109 109 / 22%);
}

.mod__hinzufuegen {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.mod__select {
  flex: 1;
  min-width: 0;
  padding: 0.35rem 0.4rem;
  border: 1px solid var(--gold-border);
  background: rgb(0 0 0 / 35%);
  color: #e9e2cd;
  font: inherit;
  font-size: 0.8125rem;
}
</style>
