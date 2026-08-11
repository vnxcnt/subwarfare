<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { deleteAccount } from '../state/auth';
import { leaveQueue } from '../state/lobby';
import {
  KEY_ACTIONS,
  keyLabel,
  keys,
  resetKeys,
  setKey,
  setVolume,
  settingsModalOpen,
  volumes,
  type KeyBindings,
} from '../state/settings';

/**
 * Einstellungen — ein Overlay, das im Hauptmenü UND im Spiel liegt.
 *
 * Bewusst neutral-dunkel gestaltet statt Gold oder HUD-Teal: es schwebt über
 * beiden Welten. Geschlossen wird über ×, Klick auf den Hintergrund oder das
 * Ende der Konto-Löschung.
 */
const emit = defineEmits<{ close: [] }>();

const router = useRouter();

/* --- Tastenbelegung ------------------------------------------------------ */

/** Aktion, die gerade auf einen Tastendruck wartet. */
const listening = ref<keyof KeyBindings | null>(null);
const keyError = ref<string | null>(null);

function beginCapture(action: keyof KeyBindings): void {
  keyError.value = null;
  listening.value = action;
  window.addEventListener('keydown', capture, { capture: true });
}

function endCapture(): void {
  listening.value = null;
  window.removeEventListener('keydown', capture, { capture: true });
}

function capture(event: KeyboardEvent): void {
  // Im Capture UND mit Stopp: der Druck darf währenddessen weder steuern noch
  // feuern — er ist eine Eingabe an dieses Panel, nicht ans Spiel.
  event.preventDefault();
  event.stopPropagation();

  // Auto-Repeat einer BEREITS gehaltenen Taste ist kein bewusster Druck —
  // sonst bindet eine beim Klick aufs Feld gehaltene Taste sich sofort selbst.
  if (event.repeat) return;

  const action = listening.value;
  if (!action) {
    endCapture();
    return;
  }
  if (event.code === 'Escape') {
    endCapture();
    return;
  }
  if (!setKey(action, event.code)) {
    keyError.value = `${keyLabel(event.code)} ist bereits belegt.`;
    endCapture();
    return;
  }
  endCapture();
}

// Solange das Panel offen ist, schweigen die Spiel-Handler (Ruder, Telegraf,
// Feuern) — sie prüfen dieses Flag.
onMounted(() => (settingsModalOpen.value = true));
onBeforeUnmount(() => {
  settingsModalOpen.value = false;
  endCapture();
});

/* --- Lautstärke ---------------------------------------------------------- */

function onVolume(kind: 'effects' | 'ambient', event: Event): void {
  const value = Number((event.target as HTMLInputElement).value);
  setVolume(kind, value / 100);
}

/* --- Konto löschen ------------------------------------------------------- */

const confirmingDelete = ref(false);
const deleting = ref(false);
const deleteError = ref<string | null>(null);

async function confirmDelete(): Promise<void> {
  if (deleting.value) return;
  deleting.value = true;
  deleteError.value = null;
  const error = await deleteAccount();
  deleting.value = false;
  if (error) {
    deleteError.value = error;
    return;
  }
  // Konto ist weg, Sitzung lokal beendet — raus aus allem, zurück zum Login.
  leaveQueue();
  emit('close');
  void router.replace({ name: 'login' });
}
</script>

<template>
  <!-- pointerdown statt click: ein Drag, der auf dem Panel BEGINNT (Text
       markieren, Slider ziehen) und auf dem Hintergrund endet, würde als
       click auf dem gemeinsamen Vorfahren landen und das Modal schließen. -->
  <div
    class="settings"
    role="dialog"
    aria-modal="true"
    aria-label="Einstellungen"
    @pointerdown.self="emit('close')"
  >
    <section class="settings__panel">
      <header class="settings__head">
        <h2 class="settings__title">Einstellungen</h2>
        <button class="settings__close" type="button" aria-label="Schließen" @click="emit('close')">
          ×
        </button>
      </header>

      <div class="settings__body">
        <h3 class="settings__group">Lautstärke</h3>
        <label class="settings__row settings__row--slider">
          <span>Effekte</span>
          <input
            type="range"
            min="0"
            max="100"
            :value="Math.round(volumes.effects * 100)"
            @input="onVolume('effects', $event)"
          />
          <span class="settings__value hud__num">{{ Math.round(volumes.effects * 100) }} %</span>
        </label>
        <label class="settings__row settings__row--slider">
          <span>Ambient</span>
          <input
            type="range"
            min="0"
            max="100"
            :value="Math.round(volumes.ambient * 100)"
            @input="onVolume('ambient', $event)"
          />
          <span class="settings__value hud__num">{{ Math.round(volumes.ambient * 100) }} %</span>
        </label>

        <h3 class="settings__group">Tastenbelegung</h3>
        <div v-for="action in KEY_ACTIONS" :key="action.id" class="settings__row">
          <span>{{ action.label }}</span>
          <button
            type="button"
            class="settings__key"
            :class="{ 'settings__key--listening': listening === action.id }"
            @click="beginCapture(action.id)"
          >
            {{ listening === action.id ? 'Taste drücken …' : keyLabel(keys[action.id]) }}
          </button>
        </div>
        <p v-if="keyError" class="settings__error">{{ keyError }}</p>
        <button class="settings__reset" type="button" @click="resetKeys()">
          Standardbelegung wiederherstellen
        </button>

        <h3 class="settings__group settings__group--danger">Konto</h3>
        <template v-if="!confirmingDelete">
          <button class="settings__delete" type="button" @click="confirmingDelete = true">
            Account löschen
          </button>
        </template>
        <template v-else>
          <p class="settings__warning">
            Dein Konto wird endgültig gelöscht — samt Coins, XP, Inventar und Ausrüstung.
            Das lässt sich nicht rückgängig machen.
          </p>
          <div class="settings__confirm">
            <button
              class="settings__delete settings__delete--confirm"
              type="button"
              :disabled="deleting"
              @click="confirmDelete"
            >
              {{ deleting ? 'Lösche …' : 'Endgültig löschen' }}
            </button>
            <button
              class="settings__cancel"
              type="button"
              :disabled="deleting"
              @click="confirmingDelete = false; deleteError = null"
            >
              Abbrechen
            </button>
          </div>
          <p v-if="deleteError" class="settings__error">{{ deleteError }}</p>
        </template>
      </div>
    </section>
  </div>
</template>

<style scoped>
.settings {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: grid;
  place-items: center;
  background: rgb(2 10 16 / 55%);
  pointer-events: auto;
}

.settings__panel {
  width: min(26rem, calc(100vw - 2rem));
  max-height: calc(100vh - 4rem);
  display: flex;
  flex-direction: column;
  border: 1px solid rgb(214 191 132 / 45%);
  background: #101a22;
  color: #e9e2cd;
  box-shadow: 0 18px 50px rgb(0 0 0 / 55%);
}

.settings__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid rgb(214 191 132 / 25%);
}

.settings__title {
  margin: 0;
  font-size: 0.9375rem;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.settings__close {
  padding: 0 0.3rem;
  border: none;
  background: none;
  color: inherit;
  font: inherit;
  font-size: 1.25rem;
  line-height: 1;
  opacity: 0.6;
  cursor: pointer;
}

.settings__close:hover {
  opacity: 1;
}

.settings__body {
  padding: 0.9rem 1rem 1.1rem;
  overflow-y: auto;
}

.settings__group {
  margin: 1.1rem 0 0.5rem;
  font-size: 0.6875rem;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  opacity: 0.55;
}

.settings__group:first-child {
  margin-top: 0;
}

.settings__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.8rem;
  padding: 0.3rem 0;
  font-size: 0.8125rem;
}

.settings__row--slider input[type='range'] {
  flex: 1;
  accent-color: #d6bf84;
}

.settings__value {
  width: 3.2rem;
  text-align: right;
  opacity: 0.75;
}

.settings__key {
  min-width: 8.5rem;
  padding: 0.3rem 0.6rem;
  border: 1px solid rgb(214 191 132 / 40%);
  background: rgb(0 0 0 / 30%);
  color: inherit;
  font: inherit;
  font-size: 0.75rem;
  cursor: pointer;
}

.settings__key:hover {
  border-color: rgb(214 191 132 / 80%);
}

.settings__key--listening {
  border-color: #d6bf84;
  color: #d6bf84;
  animation: settings-blink 1s steps(2) infinite;
}

@keyframes settings-blink {
  50% {
    opacity: 0.55;
  }
}

.settings__reset {
  margin-top: 0.5rem;
  padding: 0;
  border: none;
  background: none;
  color: inherit;
  font: inherit;
  font-size: 0.75rem;
  opacity: 0.5;
  text-decoration: underline;
  cursor: pointer;
}

.settings__reset:hover {
  opacity: 0.85;
}

.settings__group--danger {
  color: #e2555a;
  opacity: 0.9;
}

.settings__delete {
  width: 100%;
  padding: 0.5rem 0.7rem;
  border: 1px solid rgb(226 85 90 / 60%);
  background: rgb(226 85 90 / 10%);
  color: #f4b3b5;
  font: inherit;
  font-size: 0.8125rem;
  letter-spacing: 0.06em;
  cursor: pointer;
}

.settings__delete:hover:not(:disabled) {
  background: rgb(226 85 90 / 22%);
}

.settings__delete--confirm {
  border-color: #e2555a;
  background: rgb(226 85 90 / 25%);
  color: #ffd7d8;
}

.settings__warning {
  margin: 0 0 0.6rem;
  font-size: 0.8125rem;
  line-height: 1.45;
  color: #f4b3b5;
}

.settings__confirm {
  display: flex;
  gap: 0.5rem;
}

.settings__cancel {
  flex: 0 0 auto;
  padding: 0.5rem 0.9rem;
  border: 1px solid rgb(214 191 132 / 40%);
  background: none;
  color: inherit;
  font: inherit;
  font-size: 0.8125rem;
  cursor: pointer;
}

.settings__error {
  margin: 0.5rem 0 0;
  font-size: 0.8125rem;
  color: #f4b3b5;
}
</style>
