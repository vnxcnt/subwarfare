<script setup lang="ts">
import { progressionFromXp } from '@subwarfare/shared';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import menuMusicUrl from '../assets/audio/mainmenu.mp3';
import { account, logout } from '../state/auth';
import {
  joinQueue,
  lastEndReason,
  leaveQueue,
  queueError,
  queuePosition,
  queueState,
} from '../state/lobby';
import { rankIconUrl } from '../ui/rankIcons';

const router = useRouter();

/**
 * Wählbare Karten. Solange es genau eine gibt, ist das eine Liste mit einem
 * Eintrag — die Auswahl-Mechanik steht damit trotzdem schon. Muss zu
 * KNOWN_MAPS des Backends passen, sonst antwortet die Lobby „Unbekannte Karte".
 */
const MAPS = [
  { id: 'ocean01', label: 'Ocean 01', detail: '10 × 10 km · offene See' },
] as const;

const selectedMap = ref<string>(MAPS[0].id);

/** Einmalig anzeigen, warum die letzte Partie endete, dann vergessen. */
const endReason = ref(lastEndReason.value);
lastEndReason.value = null;

const coinsFormat = new Intl.NumberFormat('de-DE');

/** Level, Rang und Fortschritt — abgeleitet aus dem XP-Stand des Kontos. */
const progression = computed(() => progressionFromXp(account.value?.xp ?? 0));
const coins = computed(() => coinsFormat.format(account.value?.coins ?? 0));
const rankIcon = computed(() => rankIconUrl(progression.value.level));

const waiting = computed(() => queueState.value === 'waiting' || queueState.value === 'connecting');

function play(): void {
  endReason.value = null;
  joinQueue(selectedMap.value, () => {
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
 * ein Fehler, nicht wie Musik.
 */
const MUSIC_VOLUME = 0.15;
const FADE_SECONDS = 1;

let music: HTMLAudioElement | null = null;
let fadeTimer: number | null = null;
let startOnGesture: (() => void) | null = null;

function fadeIn(audio: HTMLAudioElement): void {
  const stepMs = 50;
  const step = MUSIC_VOLUME / ((FADE_SECONDS * 1000) / stepMs);
  audio.volume = 0;
  fadeTimer = window.setInterval(() => {
    audio.volume = Math.min(audio.volume + step, MUSIC_VOLUME);
    if (audio.volume >= MUSIC_VOLUME && fadeTimer !== null) {
      clearInterval(fadeTimer);
      fadeTimer = null;
    }
  }, stepMs);
}

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
});

onBeforeUnmount(() => {
  // Wer das Menü verlässt, ohne zu spielen, steht nicht weiter in der Schlange.
  if (queueState.value === 'waiting' || queueState.value === 'connecting') leaveQueue();

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
    <!-- Links: Wer bin ich, was habe ich. -->
    <section class="gold-panel menu__panel menu__identity" aria-label="Konto">
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

    <!-- Mitte: der Weg aufs Wasser. -->
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
          </button>
        </li>
      </ul>

      <button class="menu__go" type="button" :disabled="waiting" @click="play">
        <template v-if="queueState === 'connecting'">Verbinde …</template>
        <template v-else-if="queueState === 'waiting' && queuePosition">
          Warteschlange — Platz {{ queuePosition.position }} von {{ queuePosition.size }}
        </template>
        <template v-else>In See stechen</template>
      </button>
      <button v-if="waiting" class="menu__cancel" type="button" @click="cancel">Abbrechen</button>

      <p v-if="queueError" class="menu__error">{{ queueError }}</p>
    </section>

    <!-- Rechts: kommt beides noch — die Struktur steht schon. -->
    <div class="menu__side">
      <section class="gold-panel menu__panel" aria-label="Aufträge">
        <h2 class="gold-panel__title">Aufträge</h2>
        <p class="menu__soon">Noch keine Aufträge verfügbar.</p>
      </section>

      <section class="gold-panel menu__panel" aria-label="Schiffe">
        <h2 class="gold-panel__title">Schiffe</h2>
        <p class="menu__soon">Werft folgt — du fährst den Standard-Zerstörer.</p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.menu {
  height: 100%;
  display: grid;
  grid-template-columns: minmax(260px, 320px) minmax(320px, 1fr) minmax(240px, 300px);
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

.menu__panel {
  position: relative;
  padding: 0.9rem 1.1rem 1rem;
}

/* Die Mitte trägt den Hauptweg — sie darf breiter atmen und rückt optisch
   ins Zentrum der Seehöhe. */
.menu__queue {
  max-width: 30rem;
  justify-self: center;
  width: 100%;
  margin-top: 8vh;
}

.menu__side {
  display: grid;
  gap: 1rem;
}

/* --- Identität ---------------------------------------------------------- */

.menu__head {
  display: flex;
  align-items: center;
  gap: 0.8rem;
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

/* --- Schmale Fenster: untereinander ------------------------------------ */

@media (max-width: 980px) {
  .menu {
    grid-template-columns: 1fr;
  }

  .menu__queue {
    margin-top: 0;
    justify-self: stretch;
    max-width: none;
  }
}
</style>
