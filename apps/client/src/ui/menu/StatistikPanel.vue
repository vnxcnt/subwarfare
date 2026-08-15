<script setup lang="ts">
import type { PvpLeaderboardEntry } from '@subwarfare/shared';
import { RANKS } from '@subwarfare/shared';
import { onMounted, ref } from 'vue';
import { account } from '../../state/auth';
import { openProfile } from '../../state/social';
import { leaderboard, leaderboardLoaded, refreshLeaderboard } from '../../state/stats';

/**
 * Statistiken: die Bestenlisten des Hafens. PvP zählt nur Spieler gegen
 * Spieler (sortiert nach Kills, die Quote ist Beiwerk), Level listet die
 * meisten XP. Flottillen-Statistiken folgen, sobald Flottillen mehr sind
 * als ein Abzeichen — der Reiter steht als ehrlicher Platzhalter da.
 */
const reiter = ref<'pvp' | 'level' | 'flottille'>('pvp');

/** Tote teilen durch mindestens 1 — sonst wäre jede weiße Weste ∞. */
function kd(eintrag: PvpLeaderboardEntry): string {
  return (eintrag.kills / Math.max(eintrag.deaths, 1)).toFixed(2);
}

function rangName(level: number): string {
  return RANKS[level - 1] ?? RANKS[0]!;
}

onMounted(() => void refreshLeaderboard());
</script>

<template>
  <section class="gold-panel menu__panel stat" aria-label="Statistiken">
    <div class="menu__tabs" role="tablist">
      <button
        type="button"
        class="menu__tab"
        :class="{ 'menu__tab--active': reiter === 'pvp' }"
        role="tab"
        :aria-selected="reiter === 'pvp'"
        @click="reiter = 'pvp'"
      >
        Gefechte
      </button>
      <button
        type="button"
        class="menu__tab"
        :class="{ 'menu__tab--active': reiter === 'level' }"
        role="tab"
        :aria-selected="reiter === 'level'"
        @click="reiter = 'level'"
      >
        Level
      </button>
      <button
        type="button"
        class="menu__tab"
        :class="{ 'menu__tab--active': reiter === 'flottille' }"
        role="tab"
        :aria-selected="reiter === 'flottille'"
        @click="reiter = 'flottille'"
      >
        Flottillen
      </button>
    </div>

    <template v-if="reiter === 'pvp'">
      <p v-if="!leaderboardLoaded" class="menu__soon">Lade Bestenliste …</p>
      <p v-else-if="!leaderboard || leaderboard.pvp.length === 0" class="menu__soon">
        Noch keine Gefechte gemeldet — die erste Versenkung schreibt Geschichte.
      </p>
      <div v-else class="stat__tabelle stat__tabelle--pvp" role="table">
        <div class="stat__kopf" role="row">
          <span class="stat__zelle stat__zelle--platz">#</span>
          <span class="stat__zelle">Kommandant</span>
          <span class="stat__zelle stat__zelle--zahl">Level</span>
          <span class="stat__zelle stat__zelle--zahl">Kills</span>
          <span class="stat__zelle stat__zelle--zahl">Tode</span>
          <span class="stat__zelle stat__zelle--zahl">K/D</span>
        </div>
        <div
          v-for="(eintrag, index) in leaderboard.pvp"
          :key="eintrag.accountId"
          class="stat__zeile"
          :class="{ 'stat__zeile--selbst': eintrag.accountId === account?.id }"
          role="row"
        >
          <span class="stat__zelle stat__zelle--platz hud__num">{{ index + 1 }}</span>
          <span
            class="stat__zelle stat__zelle--name"
            role="button"
            tabindex="0"
            @click="openProfile(eintrag.accountId)"
            @keydown.enter="openProfile(eintrag.accountId)"
          >{{ eintrag.displayName }}</span>
          <span class="stat__zelle stat__zelle--zahl hud__num">{{ eintrag.level }}</span>
          <span class="stat__zelle stat__zelle--zahl hud__num">{{ eintrag.kills }}</span>
          <span class="stat__zelle stat__zelle--zahl hud__num">{{ eintrag.deaths }}</span>
          <span class="stat__zelle stat__zelle--zahl hud__num">{{ kd(eintrag) }}</span>
        </div>
      </div>
    </template>

    <template v-else-if="reiter === 'level'">
      <p v-if="!leaderboardLoaded" class="menu__soon">Lade Bestenliste …</p>
      <p v-else-if="!leaderboard || leaderboard.xp.length === 0" class="menu__soon">
        Noch keine Erfahrung verbucht — Versenkungen und Extraktionen bringen XP.
      </p>
      <div v-else class="stat__tabelle stat__tabelle--level" role="table">
        <div class="stat__kopf" role="row">
          <span class="stat__zelle stat__zelle--platz">#</span>
          <span class="stat__zelle">Kommandant</span>
          <span class="stat__zelle">Dienstgrad</span>
          <span class="stat__zelle stat__zelle--zahl">Level</span>
          <span class="stat__zelle stat__zelle--zahl">XP</span>
        </div>
        <div
          v-for="(eintrag, index) in leaderboard.xp"
          :key="eintrag.accountId"
          class="stat__zeile"
          :class="{ 'stat__zeile--selbst': eintrag.accountId === account?.id }"
          role="row"
        >
          <span class="stat__zelle stat__zelle--platz hud__num">{{ index + 1 }}</span>
          <span
            class="stat__zelle stat__zelle--name"
            role="button"
            tabindex="0"
            @click="openProfile(eintrag.accountId)"
            @keydown.enter="openProfile(eintrag.accountId)"
          >{{ eintrag.displayName }}</span>
          <span class="stat__zelle stat__zelle--rang">{{ rangName(eintrag.level) }}</span>
          <span class="stat__zelle stat__zelle--zahl hud__num">{{ eintrag.level }}</span>
          <span class="stat__zelle stat__zelle--zahl hud__num">{{ eintrag.xp }}</span>
        </div>
      </div>
    </template>

    <template v-else>
      <p class="menu__soon">
        Flottillen-Statistiken folgen — sobald Flottillen gemeinsam auf Feindfahrt gehen.
      </p>
    </template>
  </section>
</template>

<style scoped>
/*
 * Die Listen tragen sechs Spalten — breiter als die 34-rem-Vorgabe der
 * Shell, sonst quetschen sich Namen und Zahlen ineinander.
 */
.stat {
  max-width: none !important;
  width: min(48rem, 100%);
}

/* Die Reiter-Optik (.menu__tabs/.menu__tab) kommt aus menu-shared.css. */

/* --- Tabellen ------------------------------------------------------------ */

.stat__tabelle {
  display: grid;
  gap: 0.35rem;
  font-size: 0.8125rem;
}

.stat__kopf,
.stat__zeile {
  display: grid;
  align-items: center;
  gap: 0.6rem;
  padding: 0.45rem 0.6rem;
}

.stat__tabelle--pvp .stat__kopf,
.stat__tabelle--pvp .stat__zeile {
  grid-template-columns: 2rem minmax(0, 1fr) 3.5rem 3.5rem 3.5rem 3.5rem;
}

.stat__tabelle--level .stat__kopf,
.stat__tabelle--level .stat__zeile {
  grid-template-columns: 2rem minmax(0, 1fr) minmax(0, 10rem) 3.5rem 4.5rem;
}

.stat__kopf {
  padding-top: 0;
  padding-bottom: 0.2rem;
  font-size: 0.6875rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  opacity: 0.6;
}

.stat__zeile {
  border: 1px solid var(--gold-border);
  background: rgb(0 0 0 / 20%);
}

/* Die eigene Zeile leuchtet gold — gleiche Sprache wie die Mitgliederliste. */
.stat__zeile--selbst {
  border-color: var(--gold);
  background: var(--gold-faint);
}

.stat__zeile--selbst .stat__zelle--name {
  color: var(--gold-bright);
}

.stat__zelle {
  min-width: 0;
}

.stat__zelle--platz {
  opacity: 0.7;
}

.stat__zelle--name {
  font-weight: 600;
  overflow-wrap: anywhere;
  /* Klickbar: öffnet die Profilkarte des Spielers. */
  cursor: pointer;
}

.stat__zelle--name:hover {
  text-decoration: underline;
}

.stat__zelle--rang {
  font-size: 0.6875rem;
  color: var(--gold);
  opacity: 0.85;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.stat__zelle--zahl {
  text-align: right;
}
</style>
