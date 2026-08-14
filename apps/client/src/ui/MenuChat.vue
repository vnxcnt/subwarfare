<script setup lang="ts">
import {
  CHAT_MAX_LENGTH,
  RANKS,
  ROLE_DEVELOPER,
  ROLE_GAMEMASTER,
  ROLE_MODERATOR,
} from '@subwarfare/shared';
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { account } from '../state/auth';
import {
  chatConnected,
  loadHistory,
  privatKey,
  sendChat,
  threadLines,
  type ThreadKey,
} from '../state/chat';
import { fleetLoaded, myFleet, refreshMyFleet } from '../state/fleet';
import {
  dmPartner,
  friends,
  friendsLoaded,
  acceptFriend,
  cancelRequest,
  declineFriend,
  openConversation,
  openProfile,
  refreshFriends,
  removeFriend,
  socialTab,
} from '../state/social';
import { rankIconUrl } from './rankIcons';

/**
 * Funkraum unten rechts — der Treffpunkt für ALLE Kommunikation des Hafens:
 * der flüchtige Hafen-Kanal, der gespeicherte Flottillen-Kanal, private
 * Gespräche unter Freunden und die Freundesliste samt Anfragen. Jeder Name
 * ist klickbar und öffnet die Profilkarte.
 *
 * Die Socket-Verbindung verwaltet die Menü-Ansicht (connectChat/disconnect);
 * diese Komponente zeigt an, schickt ab und lädt Geschichte nach.
 */
const entwurf = ref('');
const liste = ref<HTMLElement | null>(null);

/** Der gerade sichtbare Gesprächsfaden — null auf Listen-Ansichten. */
const aktiverFaden = computed<ThreadKey | null>(() => {
  if (socialTab.value === 'hafen') return 'hafen';
  if (socialTab.value === 'flottille') return myFleet.value ? 'flottille' : null;
  if (socialTab.value === 'privat' && dmPartner.value) return privatKey(dmPartner.value);
  return null;
});

const zeilen = computed(() => (aktiverFaden.value ? threadLines(aktiverFaden.value) : []));

const partnerName = computed(() => {
  if (!dmPartner.value) return '';
  return (
    friends.value.friends.find((f) => f.accountId === dmPartner.value)?.displayName ?? 'Spieler'
  );
});

const platzhalter = computed(() => {
  if (socialTab.value === 'hafen') return 'Nachricht an den Hafen …';
  if (socialTab.value === 'flottille') return 'Nachricht an die Flottille …';
  return `Nachricht an ${partnerName.value} …`;
});

function abschicken(): void {
  if (socialTab.value === 'privat' && dmPartner.value) {
    sendChat(entwurf.value, 'privat', dmPartner.value);
  } else if (socialTab.value === 'flottille') {
    sendChat(entwurf.value, 'flottille');
  } else {
    sendChat(entwurf.value, 'hafen');
  }
  entwurf.value = '';
}

function rangName(level: number): string {
  return RANKS[level - 1] ?? 'Decksmann';
}

/** Namensfarbe nach Kontorolle — Dev lila, Gamemaster rot, Moderator grün. */
function rollenKlasse(role: number): string | null {
  if (role === ROLE_DEVELOPER) return 'chat__name--dev';
  if (role === ROLE_GAMEMASTER) return 'chat__name--gm';
  if (role === ROLE_MODERATOR) return 'chat__name--mod';
  return null;
}

function profilVon(senderId: string | null): void {
  if (senderId) void openProfile(senderId);
}

function gespraechOeffnen(accountId: string): void {
  openConversation(accountId);
}

function zurueckZurListe(): void {
  dmPartner.value = null;
}

// Geschichte nachladen, sobald ein gespeicherter Faden sichtbar wird —
// bei jedem Wechsel frisch (billig, und Zeilen anderer Reiter altern nicht).
watch(
  aktiverFaden,
  (faden) => {
    if (faden && faden !== 'hafen') void loadHistory(faden);
  },
  { immediate: true },
);

// Freundesliste beim Öffnen der Listen-Reiter auffrischen.
watch(socialTab, (tab) => {
  if (tab === 'freunde' || tab === 'privat') void refreshFriends();
  if (tab === 'flottille' && !fleetLoaded.value) void refreshMyFleet();
});

// Ans Ende rollen, sobald Zeilen dazukommen — wie jedes Chatfenster. Wer
// hochgescrollt hat, um Älteres zu lesen, wird NICHT weggezogen.
watch(
  () => zeilen.value.length,
  async () => {
    const el = liste.value;
    if (!el) return;
    const unten = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    await nextTick();
    if (unten) el.scrollTop = el.scrollHeight;
  },
);

onMounted(() => {
  // Einmal laden: die Anfragen-Zahl am Reiter soll ohne Klick stimmen.
  if (!friendsLoaded.value) void refreshFriends();
  if (!fleetLoaded.value) void refreshMyFleet();
});
</script>

<template>
  <section class="gold-panel chat" aria-label="Funkraum">
    <h2 class="gold-panel__title chat__title">
      Funkraum
      <span v-if="!chatConnected" class="chat__offline">getrennt</span>
    </h2>

    <div class="chat__tabs" role="tablist">
      <button
        v-for="tab in ['hafen', 'flottille', 'privat', 'freunde'] as const"
        :key="tab"
        type="button"
        class="chat__tab"
        :class="{ 'chat__tab--active': socialTab === tab }"
        role="tab"
        :aria-selected="socialTab === tab"
        @click="socialTab = tab"
      >
        {{ { hafen: 'Hafen', flottille: 'Flottille', privat: 'Privat', freunde: 'Freunde' }[tab] }}
        <span v-if="tab === 'freunde' && friends.incoming.length > 0" class="chat__badge hud__num">
          {{ friends.incoming.length }}
        </span>
      </button>
    </div>

    <!-- Gesprächsansicht (Hafen, Flottille, offenes Privat-Gespräch) -->
    <template v-if="socialTab !== 'freunde' && (socialTab !== 'privat' || dmPartner)">
      <div v-if="socialTab === 'privat'" class="chat__gespraech-kopf">
        <button type="button" class="chat__zurueck" aria-label="Zurück" @click="zurueckZurListe">
          ‹
        </button>
        <span class="chat__partner">{{ partnerName }}</span>
      </div>

      <p v-if="socialTab === 'flottille' && !myFleet" class="chat__leer chat__hinweis">
        Du gehörst keiner Flottille an — der Kanal öffnet mit dem Beitritt.
      </p>
      <template v-else>
        <div ref="liste" class="chat__zeilen" aria-live="polite">
          <p v-if="zeilen.length === 0" class="chat__leer">
            {{ socialTab === 'hafen' ? 'Niemand funkt — schreib die erste Nachricht.' : 'Noch keine Nachrichten.' }}
          </p>
          <p v-for="zeile in zeilen" :key="zeile.id" class="chat__zeile">
            <img
              v-if="rankIconUrl(zeile.level)"
              class="chat__rang"
              :src="rankIconUrl(zeile.level)!"
              :title="rangName(zeile.level)"
              alt=""
              draggable="false"
            />
            <span
              class="chat__name"
              :class="[rollenKlasse(zeile.role), { 'chat__name--ich': zeile.name === account?.displayName }]"
              role="button"
              tabindex="0"
              @click="profilVon(zeile.senderId)"
              @keydown.enter="profilVon(zeile.senderId)"
            >{{ zeile.name }}:</span>
            {{ zeile.text }}
          </p>
        </div>

        <form class="chat__eingabe" @submit.prevent="abschicken">
          <input
            v-model="entwurf"
            type="text"
            :maxlength="CHAT_MAX_LENGTH"
            :placeholder="platzhalter"
            :disabled="!chatConnected"
            autocomplete="off"
          />
          <button type="submit" :disabled="!chatConnected || entwurf.trim().length === 0">
            Senden
          </button>
        </form>
      </template>
    </template>

    <!-- Privat: Partnerwahl (Freunde als Gesprächsliste) -->
    <div v-else-if="socialTab === 'privat'" class="chat__zeilen social__liste">
      <p v-if="friends.friends.length === 0" class="chat__leer">
        Noch keine Freunde — private Gespräche gibt es unter Freunden.
        Klick auf einen Namen und schick eine Anfrage.
      </p>
      <div
        v-for="freund in friends.friends"
        :key="freund.accountId"
        class="social__eintrag social__eintrag--klickbar"
        role="button"
        tabindex="0"
        @click="gespraechOeffnen(freund.accountId)"
        @keydown.enter="gespraechOeffnen(freund.accountId)"
      >
        <span class="social__punkt" :class="{ 'social__punkt--online': freund.online }"></span>
        <span class="social__name" @click.stop="openProfile(freund.accountId)">
          {{ freund.displayName }}
        </span>
        <span class="social__meta hud__num">Lvl {{ freund.level }}</span>
      </div>
    </div>

    <!-- Freunde: Anfragen + Liste -->
    <div v-else class="chat__zeilen social__liste">
      <template v-if="friends.incoming.length > 0">
        <p class="social__abschnitt">Anfragen</p>
        <div v-for="anfrage in friends.incoming" :key="anfrage.accountId" class="social__eintrag">
          <span
            class="social__name"
            role="button"
            tabindex="0"
            @click="openProfile(anfrage.accountId)"
            @keydown.enter="openProfile(anfrage.accountId)"
          >{{ anfrage.displayName }}</span>
          <span class="social__aktionen">
            <button type="button" class="social__knopf" @click="acceptFriend(anfrage.accountId)">
              Annehmen
            </button>
            <button
              type="button"
              class="social__knopf social__knopf--leise"
              @click="declineFriend(anfrage.accountId)"
            >
              Ablehnen
            </button>
          </span>
        </div>
      </template>

      <template v-if="friends.outgoing.length > 0">
        <p class="social__abschnitt">Gesendet</p>
        <div v-for="anfrage in friends.outgoing" :key="anfrage.accountId" class="social__eintrag">
          <span
            class="social__name"
            role="button"
            tabindex="0"
            @click="openProfile(anfrage.accountId)"
            @keydown.enter="openProfile(anfrage.accountId)"
          >{{ anfrage.displayName }}</span>
          <span class="social__aktionen">
            <button
              type="button"
              class="social__knopf social__knopf--leise"
              @click="cancelRequest(anfrage.accountId)"
            >
              Zurückziehen
            </button>
          </span>
        </div>
      </template>

      <p class="social__abschnitt">Freunde</p>
      <p v-if="friends.friends.length === 0" class="chat__leer">
        Noch keine Freunde — klick auf einen Namen im Chat oder in den
        Bestenlisten und schick eine Anfrage.
      </p>
      <div v-for="freund in friends.friends" :key="freund.accountId" class="social__eintrag">
        <span class="social__punkt" :class="{ 'social__punkt--online': freund.online }"></span>
        <span
          class="social__name"
          role="button"
          tabindex="0"
          @click="openProfile(freund.accountId)"
          @keydown.enter="openProfile(freund.accountId)"
        >{{ freund.displayName }}</span>
        <span class="social__aktionen">
          <button type="button" class="social__knopf" @click="gespraechOeffnen(freund.accountId)">
            Nachricht
          </button>
          <button
            type="button"
            class="social__knopf social__knopf--leise"
            @click="removeFriend(freund.accountId)"
          >
            Entfernen
          </button>
        </span>
      </div>
    </div>
  </section>
</template>

<style scoped>
/*
 * Fest unten RECHTS, über dem Menü: der Funk gehört zur Kulisse des Hafens,
 * nicht in den Spaltenfluss. Links steht seit dem AoE2-Umbau die Menüspalte —
 * dort würde er die Knöpfe verdecken.
 */
.chat {
  position: fixed;
  bottom: 1rem;
  right: 1.25rem;
  z-index: 5;
  display: flex;
  flex-direction: column;
  width: min(23rem, calc(100vw - 2.5rem));
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

/* --- Reiter -------------------------------------------------------------- */

.chat__tabs {
  display: flex;
  gap: 0.25rem;
  margin-bottom: 0.5rem;
}

.chat__tab {
  flex: 1;
  position: relative;
  padding: 0.3rem 0.2rem;
  border: 1px solid var(--gold-border);
  background: rgb(0 0 0 / 25%);
  color: inherit;
  font: inherit;
  font-size: 0.625rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  cursor: pointer;
}

.chat__tab--active {
  border-color: var(--gold);
  background: var(--gold-faint);
  color: var(--gold);
}

.chat__badge {
  display: inline-block;
  min-width: 1.1em;
  margin-left: 0.2rem;
  padding: 0 0.25em;
  border-radius: 2px;
  background: #a33;
  color: #fff;
  font-size: 0.5625rem;
}

/* --- Gesprächsansicht ---------------------------------------------------- */

.chat__gespraech-kopf {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin-bottom: 0.3rem;
}

.chat__zurueck {
  padding: 0 0.45rem;
  border: 1px solid var(--gold-border);
  background: rgb(0 0 0 / 25%);
  color: var(--gold);
  font: inherit;
  font-size: 0.9rem;
  line-height: 1.3;
  cursor: pointer;
}

.chat__partner {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--gold-bright);
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

.chat__hinweis {
  min-height: 9.5rem;
}

.chat__zeile {
  margin: 0 0 0.2rem;
  overflow-wrap: anywhere;
}

/* Rang-Abzeichen des Absenders — klein vor dem Namen, mittig zur Zeile. */
.chat__rang {
  width: 14px;
  height: 14px;
  vertical-align: -2px;
  margin-right: 0.25rem;
  image-rendering: -webkit-optimize-contrast;
  -webkit-user-drag: none;
}

.chat__name {
  color: var(--gold);
  font-weight: 600;
  cursor: pointer;
}

.chat__name:hover {
  text-decoration: underline;
}

.chat__name--ich {
  color: var(--gold-bright);
}

/* Rollenfarben NACH --ich definiert: die Rolle sticht die Eigen-Markierung —
   ein Dev bleibt auch in den eigenen Zeilen lila. */
.chat__name--mod {
  color: #6fd08c;
}

.chat__name--gm {
  color: #f26d6d;
}

.chat__name--dev {
  color: #c58cf2;
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

/* --- Freundes-/Gesprächslisten ------------------------------------------- */

.social__liste {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.social__abschnitt {
  margin: 0.3rem 0 0.1rem;
  font-size: 0.625rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  opacity: 0.6;
}

.social__eintrag {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.3rem 0.4rem;
  border: 1px solid var(--gold-border);
  background: rgb(0 0 0 / 20%);
}

.social__eintrag--klickbar {
  cursor: pointer;
}

.social__eintrag--klickbar:hover {
  border-color: var(--gold);
}

.social__punkt {
  flex: 0 0 auto;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: rgb(233 226 205 / 25%);
}

.social__punkt--online {
  background: #6fd08c;
  box-shadow: 0 0 4px rgb(111 208 140 / 60%);
}

.social__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--gold);
  font-weight: 600;
  cursor: pointer;
}

.social__name:hover {
  text-decoration: underline;
}

.social__meta {
  font-size: 0.625rem;
  opacity: 0.6;
}

.social__aktionen {
  display: flex;
  gap: 0.25rem;
}

.social__knopf {
  padding: 0.2rem 0.4rem;
  border: 1px solid var(--gold);
  background: var(--gold-faint);
  color: var(--gold);
  font: inherit;
  font-size: 0.5625rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  cursor: pointer;
}

.social__knopf:hover {
  background: rgb(230 207 120 / 22%);
}

.social__knopf--leise {
  border-color: var(--gold-border);
  background: rgb(0 0 0 / 25%);
  color: inherit;
  opacity: 0.8;
}

/* Auf sehr flachen Fenstern lieber weniger Funk als verdeckte Panels. */
@media (max-height: 700px) {
  .chat__zeilen {
    height: 6rem;
  }

  .chat__hinweis {
    min-height: 6rem;
  }
}
</style>
