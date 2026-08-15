<script setup lang="ts">
import { RANKS, ROLE_MODERATOR, fleetRankName } from '@subwarfare/shared';
import { computed } from 'vue';
import { account } from '../state/auth';
import {
  acceptFriend,
  cancelRequest,
  closeProfile,
  declineFriend,
  modChatMute,
  modChatPurge,
  openConversation,
  profil,
  removeFriend,
  requestFriend,
} from '../state/social';

/**
 * Profilkarte eines Spielers — öffnet sich über Klick auf einen Namen (Chat,
 * Freundesliste, Bestenlisten, Flottillen-Mitglieder). Zeigt, was jeder
 * Angemeldete wissen darf: Name, Bild, Fortschritt, PvP-Bilanz, Flottille
 * samt Rang — und trägt die Freundschafts-Knöpfe passend zum Stand.
 */
const rangName = computed(() => {
  const level = profil.value?.level ?? 1;
  return RANKS[level - 1] ?? RANKS[0]!;
});

const kd = computed(() => {
  const p = profil.value;
  if (!p) return '0.00';
  return (p.kills / Math.max(p.deaths, 1)).toFixed(2);
});

const seit = computed(() => {
  const roh = profil.value?.createdAt;
  if (!roh) return '—';
  const datum = new Date(roh);
  return Number.isNaN(datum.getTime()) ? '—' : datum.toLocaleDateString('de-DE');
});

/**
 * Moderations-Zeile: ab Moderator (Rolle 1), nie auf der eigenen Karte.
 * Der Knopf ist nur die Anzeige — die api prüft Rolle UND Hierarchie erneut.
 */
const zeigeModeration = computed(
  () =>
    (account.value?.role ?? 0) >= ROLE_MODERATOR &&
    profil.value !== null &&
    profil.value.friendship !== 'self',
);
</script>

<template>
  <div v-if="profil" class="profilkarte__schleier" @click.self="closeProfile">
    <section class="gold-panel profilkarte" aria-label="Spieler-Profil">
      <button type="button" class="profilkarte__zu" aria-label="Schließen" @click="closeProfile">
        ×
      </button>

      <header class="profilkarte__kopf">
        <img
          v-if="profil.avatarUrl"
          class="profilkarte__avatar"
          :src="profil.avatarUrl"
          alt=""
          referrerpolicy="no-referrer"
        />
        <div v-else class="profilkarte__avatar profilkarte__avatar--fallback">
          {{ profil.displayName.slice(0, 1).toUpperCase() }}
        </div>
        <div class="profilkarte__wer">
          <h2 class="profilkarte__name">{{ profil.displayName }}</h2>
          <p class="profilkarte__rang">{{ rangName }} · Level {{ profil.level }}</p>
          <p class="profilkarte__seit">An Bord seit {{ seit }}</p>
        </div>
      </header>

      <dl class="profilkarte__werte">
        <div class="profilkarte__wert">
          <dt>XP</dt>
          <dd class="hud__num">{{ profil.xp }}</dd>
        </div>
        <div class="profilkarte__wert">
          <dt>Kills</dt>
          <dd class="hud__num">{{ profil.kills }}</dd>
        </div>
        <div class="profilkarte__wert">
          <dt>Tode</dt>
          <dd class="hud__num">{{ profil.deaths }}</dd>
        </div>
        <div class="profilkarte__wert">
          <dt>K/D</dt>
          <dd class="hud__num">{{ kd }}</dd>
        </div>
      </dl>

      <p class="profilkarte__flottille">
        <span class="profilkarte__flottille-titel">Flottille</span>
        <template v-if="profil.fleet">
          <span class="profilkarte__flottille-name">{{ profil.fleet.name }}</span>
          <span class="profilkarte__flottille-rang">{{ fleetRankName(profil.fleet.rank) }}</span>
        </template>
        <span v-else class="profilkarte__flottille-keine">—</span>
      </p>

      <div class="profilkarte__aktionen">
        <template v-if="profil.friendship === 'none'">
          <button type="button" class="profilkarte__knopf" @click="requestFriend(profil.accountId)">
            Freund hinzufügen
          </button>
        </template>
        <template v-else-if="profil.friendship === 'outgoing'">
          <button
            type="button"
            class="profilkarte__knopf profilkarte__knopf--leise"
            @click="cancelRequest(profil.accountId)"
          >
            Anfrage zurückziehen
          </button>
        </template>
        <template v-else-if="profil.friendship === 'incoming'">
          <button type="button" class="profilkarte__knopf" @click="acceptFriend(profil.accountId)">
            Anfrage annehmen
          </button>
          <button
            type="button"
            class="profilkarte__knopf profilkarte__knopf--leise"
            @click="declineFriend(profil.accountId)"
          >
            Ablehnen
          </button>
        </template>
        <template v-else-if="profil.friendship === 'friends'">
          <button
            type="button"
            class="profilkarte__knopf"
            @click="openConversation(profil.accountId)"
          >
            Nachricht schreiben
          </button>
          <button
            type="button"
            class="profilkarte__knopf profilkarte__knopf--leise"
            @click="removeFriend(profil.accountId)"
          >
            Freund entfernen
          </button>
        </template>
      </div>

      <!-- Moderations-Zeile (ab Moderator): Chat leeren + Chatsperre. -->
      <div v-if="zeigeModeration" class="profilkarte__moderation">
        <span class="profilkarte__moderation-titel">Moderation</span>
        <button
          type="button"
          class="profilkarte__knopf profilkarte__knopf--mod"
          @click="modChatPurge(profil.accountId)"
        >
          Nachrichten löschen
        </button>
        <button
          type="button"
          class="profilkarte__knopf profilkarte__knopf--mod"
          @click="modChatMute(profil.accountId, !(profil.chatMuted ?? false))"
        >
          {{ profil.chatMuted ? 'Chatsperre aufheben' : 'Chatsperre' }}
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.profilkarte__schleier {
  position: fixed;
  inset: 0;
  z-index: 30;
  display: grid;
  place-items: center;
  background: rgb(4 20 31 / 55%);
}

.profilkarte {
  position: relative;
  width: min(22rem, calc(100vw - 2rem));
  padding: 1rem 1.1rem 1.1rem;
}

.profilkarte__zu {
  position: absolute;
  top: 0.4rem;
  right: 0.55rem;
  border: none;
  background: none;
  color: var(--gold);
  font-size: 1.1rem;
  line-height: 1;
  cursor: pointer;
  opacity: 0.7;
}

.profilkarte__zu:hover {
  opacity: 1;
}

.profilkarte__kopf {
  display: flex;
  align-items: center;
  gap: 0.8rem;
  margin-bottom: 0.8rem;
}

.profilkarte__avatar {
  width: 52px;
  height: 52px;
  border: 1px solid var(--gold-border);
  object-fit: cover;
}

.profilkarte__avatar--fallback {
  display: grid;
  place-items: center;
  background: var(--gold-faint);
  color: var(--gold);
  font-size: 1.4rem;
  font-weight: 600;
}

.profilkarte__wer {
  min-width: 0;
}

.profilkarte__name {
  margin: 0;
  font-size: 1rem;
  letter-spacing: 0.05em;
  color: var(--gold-bright);
  overflow-wrap: anywhere;
}

.profilkarte__rang {
  margin: 0.15rem 0 0;
  font-size: 0.75rem;
  color: var(--gold);
}

.profilkarte__seit {
  margin: 0.1rem 0 0;
  font-size: 0.625rem;
  letter-spacing: 0.08em;
  opacity: 0.55;
}

.profilkarte__werte {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 0.35rem;
  margin: 0 0 0.7rem;
}

.profilkarte__wert {
  padding: 0.35rem 0.3rem;
  border: 1px solid var(--gold-border);
  background: rgb(0 0 0 / 20%);
  text-align: center;
}

.profilkarte__wert dt {
  margin: 0 0 0.15rem;
  font-size: 0.5625rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  opacity: 0.6;
}

.profilkarte__wert dd {
  margin: 0;
  font-size: 0.8125rem;
  font-weight: 600;
}

.profilkarte__flottille {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  margin: 0 0 0.9rem;
  padding: 0.4rem 0.55rem;
  border: 1px solid var(--gold-border);
  background: rgb(0 0 0 / 20%);
  font-size: 0.75rem;
}

.profilkarte__flottille-titel {
  font-size: 0.5625rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  opacity: 0.6;
}

.profilkarte__flottille-name {
  font-weight: 600;
  color: var(--gold-bright);
}

.profilkarte__flottille-rang {
  font-size: 0.6875rem;
  color: var(--gold);
  opacity: 0.85;
}

.profilkarte__flottille-keine {
  opacity: 0.5;
}

.profilkarte__aktionen {
  display: flex;
  gap: 0.4rem;
}

.profilkarte__aktionen:empty {
  display: none;
}

.profilkarte__knopf {
  flex: 1;
  padding: 0.45rem 0.5rem;
  border: 1px solid var(--gold);
  background: var(--gold-faint);
  color: var(--gold);
  font: inherit;
  font-size: 0.6875rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  cursor: pointer;
}

.profilkarte__knopf:hover {
  background: rgb(230 207 120 / 22%);
}

.profilkarte__knopf--leise {
  border-color: var(--gold-border);
  background: rgb(0 0 0 / 25%);
  color: inherit;
  opacity: 0.85;
}

/* --- Moderations-Zeile ---------------------------------------------------- */

.profilkarte__moderation {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin-top: 0.7rem;
  padding-top: 0.6rem;
  border-top: 1px solid var(--gold-border);
}

.profilkarte__moderation-titel {
  font-size: 0.5625rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: #f26d6d;
  opacity: 0.85;
}

.profilkarte__knopf--mod {
  flex: 1;
  border-color: rgb(242 109 109 / 45%);
  background: rgb(242 109 109 / 10%);
  color: #f4b3b5;
}

.profilkarte__knopf--mod:hover {
  background: rgb(242 109 109 / 20%);
}
</style>
