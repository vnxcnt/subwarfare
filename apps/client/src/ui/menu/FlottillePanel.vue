<script setup lang="ts">
import {
  FLEET_MIN_LEVEL,
  FLEET_RANKS,
  canAssignRank,
  canKick,
  fleetRankName,
  type FleetMemberEntry,
} from '@subwarfare/shared';
import { computed, onMounted, ref } from 'vue';
import { account, progression } from '../../state/auth';
import {
  createFleet,
  donateToFleet,
  fleetBusy,
  fleetError,
  fleetLoaded,
  fleetSearchResults,
  joinFleet,
  kickMember,
  leaveFleet,
  myFleet,
  refreshMyFleet,
  searchFleets,
  setMemberRank,
} from '../../state/fleet';

/**
 * Flottille — das Clan-System des Hafens. V1 rein organisatorisch: gründen,
 * suchen/beitreten, Mitglieder mit fünf Rängen verwalten, Kasse, Statistik.
 * Die RECHTE der Knöpfe kommen aus denselben shared-Helfern, mit denen die
 * api Anfragen ablehnt — Anzeige und Durchsetzung können nicht auseinanderlaufen.
 *
 * Level-Schranke ab FLEET_MIN_LEVEL; Dev-Konten sind ausgenommen (ohne
 * XP-Vergabe wäre die Schranke sonst für alle zu).
 */
const freigeschaltet = computed(
  () => account.value?.isDev || progression.value.level >= FLEET_MIN_LEVEL,
);

/** Eigener Rang in der Flottille — Grundlage aller Verwaltungs-Knöpfe. */
const eigenerRang = computed(() => {
  const eigen = myFleet.value?.members.find((m) => m.accountId === account.value?.id);
  return eigen?.rank ?? 99;
});

const statGesamtlevel = computed(() =>
  (myFleet.value?.members ?? []).reduce((summe, m) => summe + m.level, 0),
);

/* --- Gründen ------------------------------------------------------------- */

const neuName = ref('');
const neuBeschreibung = ref('');

async function gruenden(): Promise<void> {
  await createFleet(neuName.value.trim(), neuBeschreibung.value.trim());
}

/* --- Suchen -------------------------------------------------------------- */

const suchbegriff = ref('');

function suchen(): void {
  void searchFleets(suchbegriff.value.trim());
}

/* --- Meine Flottille ----------------------------------------------------- */

const spende = ref(10);

async function einzahlen(): Promise<void> {
  const betrag = Math.trunc(spende.value);
  if (betrag < 1) return;
  await donateToFleet(betrag);
}

const verlassenBestaetigen = ref(false);

async function verlassen(): Promise<void> {
  const fehler = await leaveFleet();
  verlassenBestaetigen.value = false;
  if (!fehler) fleetSearchResults.value = [];
}

/** Ränge, die ICH diesem Mitglied geben darf — leer heißt: kein Regler. */
function vergebbareRaenge(mitglied: FleetMemberEntry): Array<{ id: number; name: string }> {
  if (mitglied.accountId === account.value?.id) return [];
  return FLEET_RANKS.filter((rang) =>
    canAssignRank(eigenerRang.value, mitglied.rank, rang.id),
  ).map((rang) => ({ id: rang.id, name: rang.name }));
}

function onRangWechsel(mitglied: FleetMemberEntry, event: Event): void {
  const wert = Number((event.target as HTMLSelectElement).value);
  if (wert === mitglied.rank) return;
  void setMemberRank(mitglied.accountId, wert);
}

function darfEntlassen(mitglied: FleetMemberEntry): boolean {
  return mitglied.accountId !== account.value?.id && canKick(eigenerRang.value, mitglied.rank);
}

function datum(roh: string): string {
  const teil = roh.slice(0, 10).split('-');
  return teil.length === 3 ? `${teil[2]}.${teil[1]}.${teil[0]}` : roh;
}

onMounted(() => {
  if (!freigeschaltet.value) return;
  void refreshMyFleet();
  void searchFleets('');
});
</script>

<template>
  <div class="fl">
    <!-- Gesperrt: unterhalb der Levelschranke gibt es nur den Hinweis. -->
    <section v-if="!freigeschaltet" class="gold-panel menu__panel" aria-label="Flottille">
      <h2 class="gold-panel__title">Flottille</h2>
      <p class="menu__soon">
        Flottillen stehen ab Level {{ FLEET_MIN_LEVEL }} offen — sammle Erfahrung auf See,
        dann kannst du dich hier mit anderen Kapitänen zusammenschließen.
      </p>
    </section>

    <!-- Meine Flottille -->
    <template v-else-if="myFleet">
      <section class="gold-panel menu__panel" :aria-label="myFleet.fleet.name">
        <h2 class="gold-panel__title">{{ myFleet.fleet.name }}</h2>
        <p v-if="myFleet.fleet.description" class="fl__beschreibung">
          {{ myFleet.fleet.description }}
        </p>

        <div class="fl__stats">
          <div class="fl__stat">
            <span class="fl__stat-wert hud__num">{{ myFleet.members.length }}</span>
            <span class="fl__stat-label">Mitglieder</span>
          </div>
          <div class="fl__stat">
            <span class="fl__stat-wert hud__num">{{ statGesamtlevel }}</span>
            <span class="fl__stat-label">Gesamtlevel</span>
          </div>
          <div class="fl__stat">
            <span class="fl__stat-wert hud__num">
              <img class="menu__coin menu__coin--small" src="../../assets/ui/coin.png" alt="" />
              {{ myFleet.fleet.treasury }}
            </span>
            <span class="fl__stat-label">Kasse</span>
          </div>
          <div class="fl__stat">
            <span class="fl__stat-wert hud__num">{{ datum(myFleet.fleet.createdAt) }}</span>
            <span class="fl__stat-label">Gegründet</span>
          </div>
        </div>

        <!-- Kasse: einzahlen kann jedes Mitglied — Ausgeben kommt später. -->
        <form class="fl__kasse" @submit.prevent="einzahlen">
          <span class="fl__label">Flottillenkasse</span>
          <input
            v-model.number="spende"
            class="fl__input fl__input--betrag hud__num"
            type="number"
            min="1"
            :max="account?.coins ?? 0"
            :disabled="fleetBusy"
          />
          <button class="fl__button" type="submit" :disabled="fleetBusy || (account?.coins ?? 0) < 1">
            Einzahlen
          </button>
        </form>
      </section>

      <section class="gold-panel menu__panel" aria-label="Mitglieder">
        <h2 class="gold-panel__title">Mitglieder</h2>
        <ul class="fl__mitglieder">
          <li v-for="mitglied in myFleet.members" :key="mitglied.accountId" class="fl__mitglied">
            <div class="fl__mitglied-wer">
              <span
                class="fl__mitglied-name"
                :class="{ 'fl__mitglied-name--selbst': mitglied.accountId === account?.id }"
              >
                {{ mitglied.displayName }}
              </span>
              <span class="fl__mitglied-level hud__num">Level {{ mitglied.level }}</span>
            </div>

            <!-- Rang: mit Befugnis ein Regler, sonst nur die Anzeige. -->
            <select
              v-if="vergebbareRaenge(mitglied).length > 0"
              class="fl__rang-select"
              :value="mitglied.rank"
              :disabled="fleetBusy"
              @change="onRangWechsel(mitglied, $event)"
            >
              <option :value="mitglied.rank">{{ fleetRankName(mitglied.rank) }}</option>
              <option v-for="rang in vergebbareRaenge(mitglied)" :key="rang.id" :value="rang.id">
                {{ rang.name }}
              </option>
            </select>
            <span v-else class="fl__rang">{{ fleetRankName(mitglied.rank) }}</span>

            <button
              v-if="darfEntlassen(mitglied)"
              type="button"
              class="fl__entlassen"
              :disabled="fleetBusy"
              @click="kickMember(mitglied.accountId)"
            >
              Entlassen
            </button>
          </li>
        </ul>

        <p v-if="fleetError" class="menu__error">{{ fleetError }}</p>

        <div class="fl__austritt">
          <button
            v-if="!verlassenBestaetigen"
            type="button"
            class="fl__verlassen"
            @click="verlassenBestaetigen = true"
          >
            Flottille verlassen
          </button>
          <template v-else>
            <button type="button" class="fl__verlassen fl__verlassen--sicher" :disabled="fleetBusy" @click="verlassen">
              Wirklich verlassen
            </button>
            <button type="button" class="fl__abbrechen" @click="verlassenBestaetigen = false">
              Abbrechen
            </button>
          </template>
        </div>
      </section>
    </template>

    <!-- Ohne Flottille: gründen oder suchen. -->
    <template v-else-if="fleetLoaded">
      <section class="gold-panel menu__panel" aria-label="Flottille gründen">
        <h2 class="gold-panel__title">Flottille gründen</h2>
        <form class="fl__form" @submit.prevent="gruenden">
          <label class="fl__label" for="fl-name">Name</label>
          <input
            id="fl-name"
            v-model="neuName"
            class="fl__input"
            type="text"
            minlength="3"
            maxlength="30"
            placeholder="Name der Flottille"
            autocomplete="off"
            required
          />
          <label class="fl__label" for="fl-beschreibung">Beschreibung (optional)</label>
          <input
            id="fl-beschreibung"
            v-model="neuBeschreibung"
            class="fl__input"
            type="text"
            maxlength="200"
            placeholder="Wofür steht eure Flottille?"
            autocomplete="off"
          />
          <button class="fl__button" type="submit" :disabled="fleetBusy">
            {{ fleetBusy ? 'Gründe …' : 'Gründen' }}
          </button>
        </form>
      </section>

      <section class="gold-panel menu__panel" aria-label="Flottille suchen">
        <h2 class="gold-panel__title">Flottille suchen</h2>
        <form class="fl__suche" @submit.prevent="suchen">
          <input
            v-model="suchbegriff"
            class="fl__input"
            type="text"
            maxlength="30"
            placeholder="Name …"
            autocomplete="off"
          />
          <button class="fl__button" type="submit" :disabled="fleetBusy">Suchen</button>
        </form>

        <ul v-if="fleetSearchResults.length > 0" class="fl__treffer">
          <li v-for="treffer in fleetSearchResults" :key="treffer.id" class="fl__treffer-zeile">
            <div class="fl__treffer-wer">
              <span class="fl__treffer-name">{{ treffer.name }}</span>
              <span v-if="treffer.description" class="fl__treffer-info">{{ treffer.description }}</span>
            </div>
            <span class="fl__treffer-anzahl hud__num">{{ treffer.members }} Mitglieder</span>
            <button
              type="button"
              class="fl__button fl__button--klein"
              :disabled="fleetBusy"
              @click="joinFleet(treffer.id)"
            >
              Beitreten
            </button>
          </li>
        </ul>
        <p v-else class="menu__soon">Keine Flottille gefunden — gründe die erste!</p>

        <p v-if="fleetError" class="menu__error">{{ fleetError }}</p>
      </section>
    </template>

    <!-- Erster Abruf läuft noch. -->
    <section v-else class="gold-panel menu__panel" aria-label="Flottille">
      <h2 class="gold-panel__title">Flottille</h2>
      <p class="menu__soon">Lade …</p>
    </section>
  </div>
</template>

<style scoped>
.fl {
  display: grid;
  gap: 1rem;
}

.fl__beschreibung {
  margin: 0 0 0.8rem;
  font-size: 0.8125rem;
  line-height: 1.45;
  opacity: 0.75;
}

/* --- Statistik ----------------------------------------------------------- */

.fl__stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 0.5rem;
  margin-bottom: 0.9rem;
}

.fl__stat {
  display: grid;
  gap: 0.15rem;
  padding: 0.5rem 0.6rem;
  border: 1px solid var(--gold-border);
  background: rgb(0 0 0 / 25%);
  text-align: center;
}

.fl__stat-wert {
  font-size: 0.9375rem;
  font-weight: 600;
  color: var(--gold-bright);
}

.fl__stat-label {
  font-size: 0.5625rem;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  opacity: 0.55;
}

/* --- Kasse --------------------------------------------------------------- */

.fl__kasse {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}

.fl__input--betrag {
  width: 6rem;
  text-align: right;
}

/* --- Mitglieder ---------------------------------------------------------- */

.fl__mitglieder {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 0.35rem;
}

.fl__mitglied {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.45rem 0.6rem;
  border: 1px solid var(--gold-border);
  background: rgb(0 0 0 / 20%);
  font-size: 0.8125rem;
}

.fl__mitglied-wer {
  flex: 1;
  min-width: 0;
  display: grid;
}

.fl__mitglied-name {
  font-weight: 600;
  overflow-wrap: anywhere;
}

.fl__mitglied-name--selbst {
  color: var(--gold-bright);
}

.fl__mitglied-level {
  font-size: 0.625rem;
  opacity: 0.55;
}

.fl__rang {
  font-size: 0.6875rem;
  color: var(--gold);
  opacity: 0.85;
  white-space: nowrap;
}

.fl__rang-select {
  max-width: 12rem;
  padding: 0.25rem 0.35rem;
  border: 1px solid var(--gold-border);
  background: #0c0b09;
  color: var(--gold);
  font: inherit;
  font-size: 0.6875rem;
}

.fl__entlassen {
  padding: 0.25rem 0.55rem;
  border: 1px solid rgb(226 85 90 / 55%);
  background: rgb(226 85 90 / 10%);
  color: #f4b3b5;
  font: inherit;
  font-size: 0.6875rem;
  letter-spacing: 0.06em;
  cursor: pointer;
}

.fl__entlassen:hover:not(:disabled) {
  background: rgb(226 85 90 / 22%);
}

/* --- Austritt ------------------------------------------------------------ */

.fl__austritt {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.9rem;
}

.fl__verlassen {
  padding: 0.4rem 0.7rem;
  border: 1px solid rgb(226 85 90 / 55%);
  background: none;
  color: #f4b3b5;
  font: inherit;
  font-size: 0.75rem;
  cursor: pointer;
}

.fl__verlassen--sicher {
  border-color: #e2555a;
  background: rgb(226 85 90 / 22%);
}

.fl__abbrechen {
  padding: 0.4rem 0.7rem;
  border: 1px solid var(--gold-border);
  background: none;
  color: inherit;
  font: inherit;
  font-size: 0.75rem;
  cursor: pointer;
}

/* --- Formulare (Gründen/Suchen) ------------------------------------------ */

.fl__form {
  display: grid;
  gap: 0.6rem;
}

.fl__label {
  font-size: 0.6875rem;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  opacity: 0.55;
}

.fl__input {
  padding: 0.55rem 0.65rem;
  border: 1px solid var(--gold-border);
  border-radius: 0;
  background: #0c0b09;
  color: #e9e2cd;
  font: inherit;
}

.fl__input:focus {
  outline: 1px solid var(--gold);
  outline-offset: -1px;
}

.fl__button {
  padding: 0.55rem 0.65rem;
  border: 1px solid var(--gold);
  border-radius: 0;
  background: var(--gold-faint);
  color: var(--gold);
  font: inherit;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  cursor: pointer;
}

.fl__button:hover:not(:disabled) {
  background: rgb(230 207 120 / 22%);
}

.fl__button:disabled {
  opacity: 0.5;
  cursor: default;
}

.fl__button--klein {
  padding: 0.3rem 0.55rem;
  font-size: 0.6875rem;
}

/* --- Suche --------------------------------------------------------------- */

.fl__suche {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 0.8rem;
}

.fl__suche .fl__input {
  flex: 1;
}

.fl__treffer {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 0.35rem;
}

.fl__treffer-zeile {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.45rem 0.6rem;
  border: 1px solid var(--gold-border);
  background: rgb(0 0 0 / 20%);
  font-size: 0.8125rem;
}

.fl__treffer-wer {
  flex: 1;
  min-width: 0;
  display: grid;
}

.fl__treffer-name {
  font-weight: 600;
}

.fl__treffer-info {
  font-size: 0.6875rem;
  opacity: 0.55;
  overflow-wrap: anywhere;
}

.fl__treffer-anzahl {
  font-size: 0.6875rem;
  opacity: 0.7;
  white-space: nowrap;
}
</style>
