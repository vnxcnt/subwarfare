<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import menuMusicUrl from '../assets/audio/mainmenu.mp3';
import { confirmDiscordLink, restoreSession } from '../state/auth';
import { connectChat, disconnectChat } from '../state/chat';
import { refreshInventory } from '../state/economy';
import { lastEndReason, leaveQueue, menuNotice, queueState } from '../state/lobby';
import { refreshMapStatus } from '../state/maps';
import { volumes } from '../state/settings';
import { GAME_VERSION } from '@subwarfare/shared';
import AuslaufenPanel from '../ui/menu/AuslaufenPanel.vue';
import FlottillePanel from '../ui/menu/FlottillePanel.vue';
import MenuNav from '../ui/menu/MenuNav.vue';
import NeuigkeitenPanel from '../ui/menu/NeuigkeitenPanel.vue';
import PlayerBadge from '../ui/menu/PlayerBadge.vue';
import StatistikPanel from '../ui/menu/StatistikPanel.vue';
import WerftPanel from '../ui/menu/WerftPanel.vue';
import type { MenuSection } from '../ui/menu/sections';
import MenuChat from '../ui/MenuChat.vue';
import PlayerProfileCard from '../ui/PlayerProfileCard.vue';
import SettingsPanel from '../ui/SettingsPanel.vue';

/**
 * Hauptmenü-Shell im AoE2:DE-Stil: Vollbild-Hafenbild, links die Menüspalte,
 * oben rechts die Spieler-Plakette, unten rechts der Hafen-Funk. Die Shell
 * besitzt alles Langlebige — Musik, Chat-Socket, Status-Timer, Discord-Hash —
 * die Bereiche darunter kommen und gehen per Klick, ohne dass etwas abreißt.
 */
const settingsOpen = ref(false);

/** Aktiver Bereich. Null = Landing: nur Hafenbild und Menüspalte. */
const section = ref<MenuSection | null>(null);

/**
 * Wer den Auslaufen-Bereich verlässt, steht nicht weiter in der Schlange —
 * das Ticket-Callback würde sonst aus der Werft heraus auf /play schießen.
 * Dieselbe Philosophie wie beim Verlassen des Menüs (onBeforeUnmount).
 */
watch(section, (_, vorher) => {
  if (vorher !== 'auslaufen') return;
  if (queueState.value === 'waiting' || queueState.value === 'connecting') leaveQueue();
});

/** Einmalig anzeigen, warum die letzte Partie endete, dann vergessen. */
if (lastEndReason.value) {
  menuNotice.value = lastEndReason.value;
  lastEndReason.value = null;
}

let statusTimer: number | null = null;

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
        menuNotice.value = failure ?? 'Discord-Konto verknüpft.';
      });
    }
  }

  // Profil FRISCH laden: Einsatzkosten bucht die api bei der Ticketausgabe ab,
  // XP und Coins ändern sich im Spiel — wer aus der Partie zurückkommt, soll
  // den echten Kontostand sehen, nicht den von vor dem Auslaufen.
  void restoreSession();
  void refreshMapStatus();
  void refreshInventory();
  // Hafen-Funk: lebt genau so lange wie das Menü.
  connectChat();
  statusTimer = window.setInterval(() => void refreshMapStatus(), 10_000);
});

onBeforeUnmount(() => {
  // Wer das Menü verlässt, ohne zu spielen, steht nicht weiter in der Schlange.
  if (queueState.value === 'waiting' || queueState.value === 'connecting') leaveQueue();

  // Der Funk gehört zum Hafen — auf See und am Login schweigt er.
  disconnectChat();

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
    <MenuNav v-model="section" @settings="settingsOpen = true" />

    <div class="menu__content">
      <p v-if="menuNotice" class="menu__notice">{{ menuNotice }}</p>
      <AuslaufenPanel v-if="section === 'auslaufen'" />
      <WerftPanel v-else-if="section === 'werft'" />
      <FlottillePanel v-else-if="section === 'flottille'" />
      <StatistikPanel v-else-if="section === 'statistiken'" />
      <NeuigkeitenPanel v-else-if="section === 'neuigkeiten'" />
    </div>

    <PlayerBadge />

    <span class="menu__version hud__num">v{{ GAME_VERSION }}</span>

    <MenuChat />

    <!-- Profilkarte: zeigt sich selbst, sobald ein Name angeklickt wurde. -->
    <PlayerProfileCard />

    <SettingsPanel v-if="settingsOpen" @close="settingsOpen = false" />
  </div>
</template>

<style scoped>
.menu {
  position: relative;
  height: 100%;
  display: grid;
  grid-template-columns: clamp(280px, 24vw, 340px) 1fr;
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

.menu__content {
  position: relative;
  /* Grid-Kind darf schrumpfen — sonst scrollt hier nichts. */
  min-height: 0;
  overflow-y: auto;
  /* Oben Platz für die Spieler-Plakette (breite Bereiche wie Auslaufen
     reichen bis unter sie), unten für den Hafen-Funk. */
  padding: 7rem 2rem 13rem;
}

.menu__content > * {
  max-width: 34rem;
}

/* Patch-Stand unten mittig — dezent wie beim Vorbild, aber lesbar auf See. */
.menu__version {
  position: absolute;
  bottom: 0.55rem;
  left: 50%;
  transform: translateX(-50%);
  z-index: 4;
  color: #fff;
  font-size: 0.6875rem;
  letter-spacing: 0.12em;
  opacity: 0.8;
  text-shadow: 0 1px 3px rgb(0 0 0 / 75%);
  pointer-events: none;
}

@media (max-width: 980px) {
  .menu {
    grid-template-columns: 240px 1fr;
  }

  .menu__content {
    padding: 4.5rem 1rem 10rem;
  }
}
</style>
