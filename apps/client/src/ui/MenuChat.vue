<script setup lang="ts">
import { CHAT_MAX_LENGTH } from '@subwarfare/shared';
import { nextTick, ref, watch } from 'vue';
import { account } from '../state/auth';
import { chatConnected, chatLines, sendChat } from '../state/chat';

/**
 * Hafen-Funk unten links im Hauptmenü.
 *
 * Flüchtig per Bauart: die Zeilen kommen live über den Lobby-Socket und
 * werden nirgends gespeichert — wer das Menü betritt, liest ab jetzt mit.
 * Die Verbindung verwaltet die Menü-Ansicht (connectChat/disconnectChat),
 * diese Komponente zeigt nur an und schickt ab.
 */
const entwurf = ref('');
const liste = ref<HTMLElement | null>(null);

function abschicken(): void {
  sendChat(entwurf.value);
  entwurf.value = '';
}

// Ans Ende rollen, sobald Zeilen dazukommen — wie jedes Chatfenster. Wer
// hochgescrollt hat, um Älteres zu lesen, wird NICHT weggezogen.
watch(
  () => chatLines.value.length,
  async () => {
    const el = liste.value;
    if (!el) return;
    const unten = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    await nextTick();
    if (unten) el.scrollTop = el.scrollHeight;
  },
);
</script>

<template>
  <section class="gold-panel chat" aria-label="Hafen-Funk">
    <h2 class="gold-panel__title chat__title">
      Hafen-Funk
      <span v-if="!chatConnected" class="chat__offline">getrennt</span>
    </h2>

    <div ref="liste" class="chat__zeilen" aria-live="polite">
      <p v-if="chatLines.length === 0" class="chat__leer">
        Niemand funkt — schreib die erste Nachricht.
      </p>
      <p v-for="zeile in chatLines" :key="zeile.id" class="chat__zeile">
        <span
          class="chat__name"
          :class="{ 'chat__name--ich': zeile.name === account?.displayName }"
        >{{ zeile.name }}:</span>
        {{ zeile.text }}
      </p>
    </div>

    <form class="chat__eingabe" @submit.prevent="abschicken">
      <input
        v-model="entwurf"
        type="text"
        :maxlength="CHAT_MAX_LENGTH"
        placeholder="Nachricht an den Hafen …"
        :disabled="!chatConnected"
        autocomplete="off"
      />
      <button type="submit" :disabled="!chatConnected || entwurf.trim().length === 0">
        Senden
      </button>
    </form>
  </section>
</template>

<style scoped>
/*
 * Fest unten links, über dem Menü-Raster: der Funk gehört zur Kulisse des
 * Hafens, nicht in den Spaltenfluss — bei schmalen Fenstern rutschte er
 * sonst ans Seitenende unter den Shop.
 */
.chat {
  position: fixed;
  bottom: 1rem;
  left: 1.25rem;
  z-index: 5;
  display: flex;
  flex-direction: column;
  width: min(21rem, calc(100vw - 2.5rem));
  padding: 0.7rem 0.9rem 0.8rem;
}

.chat__title {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 0.5rem;
}

.chat__offline {
  font-size: 0.625rem;
  letter-spacing: 0.1em;
  color: #f4b3b5;
  opacity: 0.85;
}

.chat__zeilen {
  height: 9.5rem;
  overflow-y: auto;
  padding-right: 0.3rem;
  font-size: 0.8125rem;
  line-height: 1.45;
  overscroll-behavior: contain;
}

.chat__leer {
  margin: 0;
  opacity: 0.45;
}

.chat__zeile {
  margin: 0 0 0.2rem;
  overflow-wrap: anywhere;
}

.chat__name {
  color: var(--gold);
  font-weight: 600;
}

.chat__name--ich {
  color: var(--gold-bright);
}

.chat__eingabe {
  display: flex;
  gap: 0.4rem;
  margin-top: 0.55rem;
}

.chat__eingabe input {
  flex: 1;
  min-width: 0;
  padding: 0.4rem 0.55rem;
  border: 1px solid var(--gold-border);
  background: rgb(0 0 0 / 35%);
  color: #e9e2cd;
  font: inherit;
  font-size: 0.8125rem;
}

.chat__eingabe input::placeholder {
  color: #e9e2cd;
  opacity: 0.35;
}

.chat__eingabe button {
  padding: 0.4rem 0.7rem;
  border: 1px solid var(--gold);
  background: var(--gold-faint);
  color: var(--gold);
  font: inherit;
  font-size: 0.6875rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  cursor: pointer;
}

.chat__eingabe button:hover:not(:disabled) {
  background: rgb(230 207 120 / 22%);
}

.chat__eingabe button:disabled {
  opacity: 0.4;
  cursor: default;
}

/* Auf sehr flachen Fenstern lieber weniger Funk als verdeckte Panels. */
@media (max-height: 700px) {
  .chat__zeilen {
    height: 6rem;
  }
}
</style>
