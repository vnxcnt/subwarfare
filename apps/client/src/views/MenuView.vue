<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';
import { useRouter } from 'vue-router';
import { account, logout } from '../state/auth';
import {
  joinQueue,
  lastEndReason,
  leaveQueue,
  queueError,
  queuePosition,
  queueState,
} from '../state/lobby';

const router = useRouter();

/** Einmalig anzeigen, warum die letzte Partie endete, dann vergessen. */
const endReason = ref(lastEndReason.value);
lastEndReason.value = null;

function play(): void {
  endReason.value = null;
  joinQueue('ocean01', () => {
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

onBeforeUnmount(() => {
  // Wer das Menü verlässt, ohne zu spielen, steht nicht weiter in der Schlange.
  if (queueState.value === 'waiting' || queueState.value === 'connecting') leaveQueue();
});
</script>

<template>
  <div class="menu">
    <section class="hud__panel menu__panel">
      <header class="menu__head">
        <img
          v-if="account?.avatarUrl"
          class="menu__avatar"
          :src="account.avatarUrl"
          alt=""
          referrerpolicy="no-referrer"
        />
        <div>
          <h1 class="menu__name">{{ account?.displayName ?? '—' }}</h1>
          <p class="menu__meta">
            {{ account?.isDev ? 'Entwickler-Konto' : 'Kapitän' }}
          </p>
        </div>
      </header>

      <p v-if="endReason" class="menu__notice">{{ endReason }}</p>

      <div class="menu__actions">
        <button
          class="menu__play"
          type="button"
          :disabled="queueState === 'connecting' || queueState === 'waiting'"
          @click="play"
        >
          <template v-if="queueState === 'waiting' && queuePosition">
            In Warteschlange — Platz {{ queuePosition.position }} von {{ queuePosition.size }}
          </template>
          <template v-else-if="queueState === 'connecting'">Verbinde …</template>
          <template v-else>Spielen</template>
        </button>
        <button
          v-if="queueState === 'waiting' || queueState === 'connecting'"
          class="menu__secondary"
          type="button"
          @click="cancel"
        >
          Abbrechen
        </button>
      </div>

      <p v-if="queueError" class="menu__error">{{ queueError }}</p>

      <ul class="menu__list">
        <li class="menu__list-item menu__list-item--soon">Aufträge — folgt</li>
        <li class="menu__list-item menu__list-item--soon">Flotte — folgt</li>
      </ul>

      <button class="menu__logout" type="button" @click="signOut">Abmelden</button>
    </section>
  </div>
</template>

<style scoped>
.menu {
  display: grid;
  place-items: center;
  height: 100%;
}

.menu__panel {
  width: min(24rem, calc(100vw - 2rem));
  padding: 1.5rem 1.75rem 1.25rem;
}

.menu__head {
  display: flex;
  align-items: center;
  gap: 0.9rem;
  margin-bottom: 1.2rem;
}

.menu__avatar {
  width: 44px;
  height: 44px;
  border-radius: 2px;
  border: 1px solid var(--ui-border);
}

.menu__name {
  margin: 0;
  font-size: 1.15rem;
  letter-spacing: 0.06em;
}

.menu__meta {
  margin: 0.15rem 0 0;
  font-size: 0.6875rem;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  opacity: 0.55;
}

.menu__notice {
  margin: 0 0 1rem;
  padding: 0.5rem 0.65rem;
  border: 1px solid rgb(226 180 90 / 35%);
  border-radius: 2px;
  color: #e2b45a;
}

.menu__actions {
  display: grid;
  gap: 0.6rem;
}

.menu__play {
  padding: 0.7rem 0.65rem;
  border: 1px solid var(--ui-accent);
  border-radius: 2px;
  background: rgb(111 208 189 / 12%);
  color: var(--ui-accent);
  font: inherit;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  cursor: pointer;
}

.menu__play:hover:not(:disabled) {
  background: rgb(111 208 189 / 22%);
}

.menu__play:disabled {
  opacity: 0.75;
  cursor: default;
}

.menu__secondary {
  padding: 0.45rem 0.65rem;
  border: 1px solid var(--ui-border);
  border-radius: 2px;
  background: none;
  color: var(--ui-text);
  font: inherit;
  cursor: pointer;
}

.menu__error {
  margin: 0.8rem 0 0;
  color: #f4b3b5;
}

.menu__list {
  margin: 1.2rem 0 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 0.4rem;
}

.menu__list-item {
  padding: 0.5rem 0.65rem;
  border: 1px solid var(--ui-border);
  border-radius: 2px;
}

.menu__list-item--soon {
  opacity: 0.35;
}

.menu__logout {
  margin-top: 1.4rem;
  padding: 0;
  border: none;
  background: none;
  color: var(--ui-text);
  font: inherit;
  font-size: 0.75rem;
  opacity: 0.45;
  cursor: pointer;
  text-decoration: underline;
}

.menu__logout:hover {
  opacity: 0.8;
}
</style>
