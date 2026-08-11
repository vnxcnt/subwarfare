<script setup lang="ts">
import { ROLE_DEVELOPER } from '@subwarfare/shared';
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import devIcon from '../assets/ui/ingame_dev.png';
import exitIcon from '../assets/ui/ingame_exit.png';
import followOffIcon from '../assets/ui/ingame_follow_off.png';
import followOnIcon from '../assets/ui/ingame_follow_on.png';
import settingsIcon from '../assets/ui/ingame_settings.png';
import { KNOTS } from '../config';
import { account } from '../state/auth';
import { hud, orderFollow } from '../state/hud';
import { keyLabel, keys } from '../state/settings';

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

const position = computed(() =>
  hud.value.ready ? `${Math.round(hud.value.x)} / ${Math.round(hud.value.y)}` : '—',
);
const course = computed(() =>
  hud.value.ready ? `${Math.round(hud.value.course).toString().padStart(3, '0')}°` : '—',
);
// In Knoten, nicht in m/s — „20 kn" liest sich als Schiff, „10 m/s" nicht.
const speed = computed(() =>
  hud.value.ready ? `${(hud.value.speed / KNOTS).toFixed(1)} kn` : '—',
);
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

/** Der Hinweistext folgt der tatsächlichen Belegung — nicht den Defaults. */
const keyHint = computed(
  () =>
    `${keyLabel(keys.value.steerLeft)}/${keyLabel(keys.value.steerRight)} steuern, ` +
    `${keyLabel(keys.value.telegraphUp)}/${keyLabel(keys.value.telegraphDown)} Telegraf, ` +
    'Rad zoomt, Ziehen verschiebt',
);
</script>

<template>
  <header class="status">
    <span class="status__title">Sub Warfare</span>
    <span class="status__item">{{ hud.mapId }}</span>
    <span class="status__item">{{ weather }}</span>
    <span class="status__item hud__num">{{ position }}</span>
    <span class="status__item hud__num">{{ course }}</span>
    <span class="status__item hud__num">{{ speed }}</span>
    <span class="status__item hud__num">{{ hud.zoom.toFixed(2) }}×</span>
    <!--
      Folgen ist ein SCHALTER, kein Statustext: bisher schaltete das Ziehen der
      Karte es ab, und es gab keinen Weg zurück außer über den Zielmodus.
    -->
    <button
      class="status__knopf"
      type="button"
      :title="hud.following ? 'Kamera folgt — zum Lösen klicken' : 'Kamera folgt nicht — zum Anheften klicken'"
      :aria-label="hud.following ? 'Kamerafolgen ausschalten' : 'Kamerafolgen einschalten'"
      :aria-pressed="hud.following"
      @click="orderFollow(!hud.following)"
    >
      <img class="status__icon" :src="hud.following ? followOnIcon : followOffIcon" alt="" />
    </button>
    <span v-if="isDev" class="status__item hud__num">Neigung {{ tilt }}</span>
    <!--
      Hinweis und Knöpfe in EINEM rechtsbündigen Block: der Hinweis wird auf
      schmalen Fenstern ausgeblendet, und ein verschwundenes Element trägt
      keinen auto-Margin mehr — die Knöpfe blieben sonst links hängen.
    -->
    <span class="status__right">
      <span class="status__hint">
        {{ keyHint }}<template v-if="isDev">, [ ] neigt</template>
      </span>
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
      <button
        class="status__knopf"
        type="button"
        title="Zurück zum Hauptmenü"
        aria-label="Zurück zum Hauptmenü"
        @click="leaveToMenu"
      >
        <img class="status__icon status__icon--breit" :src="exitIcon" alt="" />
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

.status__hint {
  opacity: 0.4;
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

.status__icon--breit {
  height: 26px;
}

@media (max-width: 900px) {
  .status__hint {
    display: none;
  }
}

/* Sehr schmal: umbrechen statt abschneiden — das Zahnrad muss klickbar
   bleiben, sonst sind die Einstellungen im Spiel unerreichbar. */
@media (max-width: 640px) {
  .status {
    flex-wrap: wrap;
  }
}
</style>
