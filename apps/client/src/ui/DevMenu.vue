<script setup lang="ts">
import type { WeatherPreset, WeatherState } from '@subwarfare/shared';
import { ROLE_DEVELOPER, VESSEL_MODELS, WEATHER_PRESETS } from '@subwarfare/shared';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { account } from '../state/auth';
import { devSetModel, devSetWeather, hud } from '../state/hud';

/**
 * Entwicklermenü — geöffnet über den Build-Circle-Knopf in der Topbar.
 *
 * Der Knopf erscheint nur mit Entwicklerrolle, aber das ist Anzeige-Logik:
 * durchgesetzt wird die Rolle am Server (`dev:model`-Handler). Erste Funktion
 * ist die Wahl des eigenen Schiffsmodells; weitere Werkzeuge docken hier an.
 */
const open = ref(false);

export interface DevMenuApi {
  toggle: () => void;
}

defineExpose<DevMenuApi>({ toggle: () => (open.value = !open.value) });

const isDeveloper = computed(() => (account.value?.role ?? 0) >= ROLE_DEVELOPER);

const MODEL_LABELS: Record<string, string> = {
  fregatte01: 'Fregatte',
  yachtgun01: 'Kanonenyacht',
  submarine01: 'U-Boot',
  speedster01: 'Speedster',
  tanker01: 'Tanker',
  fregatte02: 'Fregatte II',
  submarine02: 'U-Boot II',
  destroyer01: 'Zerstörer',
  destroyer02: 'Zerstörer II',
};

function choose(model: (typeof VESSEL_MODELS)[number]): void {
  devSetModel(model);
}

/* --- Wetter ------------------------------------------------------------- */

const PRESET_LABELS: Record<WeatherPreset, string> = {
  klarer_tag: 'Klar',
  nordatlantik: 'Nordatl.',
  sturm: 'Sturm',
  daemmerung: 'Dämmerung',
  nacht: 'Nacht',
};

const PRESETS = Object.keys(WEATHER_PRESETS) as WeatherPreset[];

/**
 * Anzeigezustand der Regler.
 *
 * Der Server bleibt die Wahrheit, aber die Regler dürfen ihm nicht direkt
 * folgen: `hud` wird 20-mal pro Sekunde neu ausgelöst, Vue schreibt dabei den
 * gebundenen `value` zurück — und ein noch nicht bestätigter Zug spränge auf
 * den alten Serverwert zurück. Deshalb ein lokaler Entwurf, der beim Ziehen
 * führt und sich wieder an den Server hängt, sobald man losgelassen hat.
 */
const entwurf = ref<WeatherState>({ ...hud.value.weather });
/** Zeitpunkt der letzten Nutzereingabe — solange sie frisch ist, führt der Entwurf. */
let letzteEingabe = 0;
const RUHE_MS = 400;

watch(
  () => hud.value.weather,
  (serverLage) => {
    if (Date.now() - letzteEingabe > RUHE_MS) entwurf.value = { ...serverLage };
  },
);

const weather = computed(() => entwurf.value);

/**
 * Regler feuern beim Ziehen sehr dicht. Ein kleiner Takt hält den Netzverkehr
 * im Rahmen, ohne dass sich die Bedienung träge anfühlt — der Server verteilt
 * jede Änderung ja an alle Verbundenen.
 */
const SENDE_TAKT_MS = 100;
let letzterVersand = 0;
let nachzuegler: ReturnType<typeof setTimeout> | null = null;

function senden(next: WeatherState, sofort = false): void {
  if (nachzuegler !== null) {
    clearTimeout(nachzuegler);
    nachzuegler = null;
  }
  const jetzt = Date.now();
  const wartezeit = SENDE_TAKT_MS - (jetzt - letzterVersand);
  if (sofort || wartezeit <= 0) {
    letzterVersand = jetzt;
    devSetWeather(next);
    return;
  }
  // Letzten Wert nachreichen, sonst bliebe die Endstellung des Reglers liegen.
  nachzuegler = setTimeout(() => {
    nachzuegler = null;
    letzterVersand = Date.now();
    devSetWeather(next);
  }, wartezeit);
}

function setPreset(name: WeatherPreset): void {
  letzteEingabe = Date.now();
  const lage = { ...WEATHER_PRESETS[name] };
  entwurf.value = lage;
  senden(lage, true);
}

function setzeWert(feld: keyof WeatherState, event: Event, teiler = 1): void {
  letzteEingabe = Date.now();
  const wert = Number((event.target as HTMLInputElement).value) / teiler;
  /*
   * Basis ist der EIGENE Entwurf, nicht der nachhinkende Serverspiegel: wer
   * zwei Regler kurz nacheinander bewegt, würde sonst mit dem zweiten Zug den
   * ersten wieder zurücksetzen.
   *
   * Die Tageszeit wird dabei auf die LAUFENDE Bordzeit gehoben — sonst spränge
   * eine laufende Tag/Nacht-Uhr bei jeder anderen Änderung auf die
   * Ausgangszeit zurück.
   */
  const lage: WeatherState = { ...entwurf.value, timeOfDay: hud.value.hour, [feld]: wert };
  entwurf.value = lage;
  senden(lage);
}

// Offener Nachzügler beim Verlassen der Partie: der Timer würde sonst nach dem
// Abbau noch einmal auf einen toten Socket schreiben.
onBeforeUnmount(() => {
  if (nachzuegler !== null) clearTimeout(nachzuegler);
  nachzuegler = null;
});

/** Uhrzeit als HH:MM statt als Dezimalstunde. */
const uhrzeit = computed(() => {
  const stunde = Math.floor(weather.value.timeOfDay);
  const minute = Math.floor((weather.value.timeOfDay - stunde) * 60);
  return `${String(stunde).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
});
</script>

<template>
  <section v-if="open && isDeveloper" class="hud__panel devmenu" aria-label="Entwicklermenü">
    <h2 class="hud__panel-title">Entwicklermenü</h2>

    <p class="devmenu__group">Eigenes Schiffsmodell</p>
    <ul class="devmenu__list">
      <li v-for="model in VESSEL_MODELS" :key="model">
        <button
          type="button"
          class="devmenu__model"
          :class="{ 'devmenu__model--active': hud.model === model }"
          @click="choose(model)"
        >
          <span>{{ MODEL_LABELS[model] ?? model }}</span>
          <code class="devmenu__id">{{ model }}</code>
        </button>
      </li>
    </ul>

    <p class="devmenu__group devmenu__group--spaced">Wetter · wirkt für alle</p>
    <div class="devmenu__presets">
      <button
        v-for="name in PRESETS"
        :key="name"
        type="button"
        class="devmenu__preset"
        @click="setPreset(name)"
      >
        {{ PRESET_LABELS[name] }}
      </button>
    </div>

    <label class="devmenu__regler">
      <span>Seegang</span>
      <input
        type="range"
        min="0"
        max="100"
        :value="Math.round(weather.seaState * 100)"
        @input="setzeWert('seaState', $event, 100)"
      />
      <span class="devmenu__wert hud__num">{{ Math.round(weather.seaState * 9) }}</span>
    </label>

    <label class="devmenu__regler">
      <span>Uhrzeit</span>
      <input
        type="range"
        min="0"
        max="1440"
        step="10"
        :value="Math.round(weather.timeOfDay * 60)"
        @input="setzeWert('timeOfDay', $event, 60)"
      />
      <span class="devmenu__wert hud__num">{{ uhrzeit }}</span>
    </label>

    <label class="devmenu__regler">
      <span>Bewölkung</span>
      <input
        type="range"
        min="0"
        max="100"
        :value="Math.round(weather.cloudCover * 100)"
        @input="setzeWert('cloudCover', $event, 100)"
      />
      <span class="devmenu__wert hud__num">{{ Math.round(weather.cloudCover * 100) }}%</span>
    </label>

    <label class="devmenu__regler">
      <span>Tagesdauer</span>
      <input
        type="range"
        min="0"
        max="60"
        :value="Math.round(weather.dayLengthMinutes)"
        @input="setzeWert('dayLengthMinutes', $event)"
      />
      <span class="devmenu__wert hud__num">
        {{ weather.dayLengthMinutes > 0 ? `${Math.round(weather.dayLengthMinutes)} min` : 'aus' }}
      </span>
    </label>

    <p class="devmenu__hint">
      Seegang streut Schüsse und kürzt das Sonar — getaucht wirkt beides kaum.
    </p>
  </section>
</template>

<style scoped>
.devmenu {
  width: 240px;
}

.devmenu__group {
  margin: 0 0 0.35rem;
  font-size: calc(0.6875rem * var(--ui-scale));
  text-transform: uppercase;
  letter-spacing: 0.1em;
  opacity: 0.55;
}

.devmenu__list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 0.3rem;
}

.devmenu__model {
  width: 100%;
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 0.5rem;
  padding: 0.4rem 0.55rem;
  border: 1px solid var(--ui-border);
  border-radius: 2px;
  background: none;
  color: var(--ui-text);
  font: inherit;
  font-size: calc(0.75rem * var(--ui-scale));
  text-align: left;
  cursor: pointer;
}

.devmenu__model:hover {
  background: rgb(111 208 189 / 10%);
}

.devmenu__model--active {
  border-color: var(--ui-accent);
  color: var(--ui-accent);
}

.devmenu__id {
  font-size: calc(0.625rem * var(--ui-scale));
  opacity: 0.5;
}

.devmenu__hint {
  margin: 0.6rem 0 0;
  opacity: 0.4;
  font-size: calc(0.6875rem * var(--ui-scale));
  line-height: 1.4;
}

.devmenu__group--spaced {
  margin-top: 0.9rem;
  padding-top: 0.7rem;
  border-top: 1px solid var(--ui-border);
}

.devmenu__presets {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
  margin-bottom: 0.5rem;
}

.devmenu__preset {
  flex: 1 1 auto;
  padding: 0.25rem 0.4rem;
  border: 1px solid var(--ui-border);
  border-radius: 2px;
  background: none;
  color: var(--ui-text);
  font: inherit;
  font-size: calc(0.625rem * var(--ui-scale));
  cursor: pointer;
}

.devmenu__preset:hover {
  border-color: var(--ui-accent);
  color: var(--ui-accent);
}

.devmenu__regler {
  display: grid;
  grid-template-columns: 4.6rem 1fr 2.6rem;
  align-items: center;
  gap: 0.4rem;
  margin-bottom: 0.2rem;
  font-size: calc(0.625rem * var(--ui-scale));
}

.devmenu__regler input[type='range'] {
  width: 100%;
  accent-color: var(--ui-accent);
}

.devmenu__wert {
  text-align: right;
  opacity: 0.75;
}
</style>
