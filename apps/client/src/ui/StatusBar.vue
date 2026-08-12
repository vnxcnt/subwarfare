<script setup lang="ts">
import { ROLE_DEVELOPER } from '@subwarfare/shared';
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import devIcon from '../assets/ui/ingame_dev.png';
import exitIcon from '../assets/ui/ingame_exit.png';
import exitConfirmIcon from '../assets/ui/ingame_exit_confirm.png';
import settingsIcon from '../assets/ui/ingame_settings.png';
import { mapLabel } from '../config';
import { account } from '../state/auth';
import { hud } from '../state/hud';

const isDev = import.meta.env.DEV;
const isDeveloper = computed(() => (account.value?.role ?? 0) >= ROLE_DEVELOPER);

const emit = defineEmits<{ 'toggle-dev': []; 'toggle-settings': [] }>();

/**
 * Zurück ins Hauptmenü.
 *
 * `replace` statt `push`: die Partie ist danach beendet, ein Zurück-Knopf
 * dürfte nicht auf eine tote Karte führen. Das Aufräumen erledigt PlayView in
 * seinem `onBeforeUnmount` — dieselbe Naht, über die auch Rauswurf und
 * Verbindungsabriss zurückführen.
 */
const router = useRouter();
function leaveToMenu(): void {
  void router.replace({ name: 'menu' });
}

const mapName = computed(() => mapLabel(hud.value.mapId));

const tilt = computed(
  () => `${hud.value.tilt.toFixed(2)} · ${((Math.asin(hud.value.tilt) * 180) / Math.PI).toFixed(0)}°`,
);

/**
 * Wetterlage in Seemannssprache: Bordzeit, Bewölkung, Seegang.
 * Der Seegang wird auf die vertraute 0–9-Skala gebracht, nicht als 0..1 gezeigt.
 */
const weather = computed(() => {
  const { weather: w, hour } = hud.value;
  const stunde = Math.floor(hour);
  const minute = Math.floor((hour - stunde) * 60);
  const uhr = `${String(stunde).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  const himmel =
    w.cloudCover < 0.2
      ? 'klar'
      : w.cloudCover < 0.5
        ? 'heiter'
        : w.cloudCover < 0.85
          ? 'bedeckt'
          : 'geschlossen';
  return `${uhr} · ${himmel} · Seegang ${Math.round(w.seaState * 9)}`;
});

</script>

<template>
  <header class="status">
    <span class="status__title">Sub Warfare</span>
    <span class="status__item">{{ mapName }}</span>
    <span class="status__item">{{ weather }}</span>
    <!-- Kein Folgen-Schalter mehr: die Kamera hängt fest am eigenen Boot, und
         umgeschaut wird über den Zeiger. Es gibt keine zweite Ansicht. -->
    <span v-if="isDev" class="status__item hud__num">Neigung {{ tilt }} · [ ] neigt</span>
    <!-- Knöpfe rechtsbündig. -->
    <span class="status__right">
      <!--
        Entwicklerwerkzeuge — nur mit Entwicklerrolle sichtbar. Die Anzeige ist
        Höflichkeit; durchgesetzt wird die Rolle server-seitig am dev:model-Handler.
      -->
      <button
        v-if="isDeveloper"
        class="status__knopf"
        type="button"
        title="Entwicklermenü"
        aria-label="Entwicklermenü"
        @click="emit('toggle-dev')"
      >
        <img class="status__icon" :src="devIcon" alt="" />
      </button>
      <button
        class="status__knopf"
        type="button"
        title="Einstellungen"
        aria-label="Einstellungen"
        @click="emit('toggle-settings')"
      >
        <img class="status__icon" :src="settingsIcon" alt="" />
      </button>
      <!--
        Ausstieg mit eigenem Zeiger-Zustand: BEIDE Grafiken liegen übereinander
        und werden nur überblendet. Ein Quellenwechsel per :src würde die
        zweite Grafik erst beim ersten Überfahren holen — der Knopf bliebe für
        einen Wimpernschlag leer. So sind beide beim Ladeschirm schon dekodiert.
      -->
      <button
        class="status__knopf status__exit"
        type="button"
        title="Karte verlassen — Loot und mitgebrachte Ausrüstung gehen verloren. Sichern: 8 s in einer Bojen-Zone extrahieren."
        aria-label="Karte verlassen (ohne Extraktion gehen Loot und Ausrüstung verloren)"
        @click="leaveToMenu"
      >
        <img class="status__icon" :src="exitIcon" alt="" />
        <img class="status__icon status__icon--hover" :src="exitConfirmIcon" alt="" />
      </button>
    </span>
  </header>
</template>

<style scoped>
.status {
  display: flex;
  gap: 0.75rem;
  align-items: baseline;
  /* Eigener Innenabstand: `.hud-root` hat keinen mehr, damit der Hintergrund
     bis an die Fensterkanten reicht.
     Unten deutlich knapper als oben: darunter folgt die Zierleiste, und der
     symmetrische Abstand ließ dazwischen einen leeren grauen Streifen stehen. */
  padding: 0.4rem 16px 0.15rem;
  background: #363738;
  font-size: calc(0.8125rem * var(--ui-scale));
  letter-spacing: 0.04em;
  text-shadow: 0 1px 3px rgb(0 0 0 / 60%);
}

.status__title {
  font-weight: 600;
  text-transform: uppercase;
}

.status__item {
  opacity: 0.75;
}

.status__right {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 0.6rem;
}

.status__knopf {
  display: inline-flex;
  align-items: center;
  padding: 0;
  border: none;
  background: none;
  cursor: pointer;
  opacity: 0.9;
  /* Selbst zentrieren statt an der Baseline hängen — Bilder haben keine. */
  align-self: center;
  transition: opacity 120ms ease;
}

.status__knopf:hover {
  opacity: 1;
}

.status__knopf:active .status__icon {
  transform: translateY(1px);
}

/*
 * Feste Höhe, Breite aus dem Seitenverhältnis. Die Vorlagen sind 64 px hoch;
 * auf 26 px verkleinert bleiben die gefassten Ränder sauber, ohne die Leiste
 * aufzublähen. `display: block` verhindert den Zeilenabstand unter dem Bild,
 * der sonst die Leiste um ein paar Pixel höher machen würde.
 */
.status__icon {
  display: block;
  height: 26px;
  width: auto;
}

/*
 * Ausstiegsknopf mit zwei Zuständen. Die zweite Grafik liegt DECKUNGSGLEICH
 * über der ersten (`position: absolute` im relativ gesetzten Knopf) und wird
 * eingeblendet, sobald der Zeiger darauf steht oder der Knopf per Tastatur
 * angesteuert wird.
 *
 * Übereinanderlegen statt Quelle tauschen: die Maße bleiben dadurch fest (der
 * Knopf zuckt nicht, falls die Grafiken minimal verschieden breit sind), und
 * die Überblendung braucht beide Bilder gleichzeitig.
 */
.status__exit {
  position: relative;
}

.status__icon--hover {
  position: absolute;
  inset: 0;
  opacity: 0;
  transition: opacity 120ms ease;
}

.status__exit:hover .status__icon--hover,
.status__exit:focus-visible .status__icon--hover {
  opacity: 1;
}

/* Sehr schmal: umbrechen statt abschneiden — die Knöpfe müssen klickbar
   bleiben, sonst sind Einstellungen und Hauptmenü im Spiel unerreichbar. */
@media (max-width: 640px) {
  .status {
    flex-wrap: wrap;
  }
}
</style>
