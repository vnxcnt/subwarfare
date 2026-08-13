<script setup lang="ts">
import { ref } from 'vue';
import AmmoBar from './AmmoBar.vue';
import DeathNotice from './DeathNotice.vue';
import DevMenu from './DevMenu.vue';
import EventLog from './EventLog.vue';
import ExtractionPanel from './ExtractionPanel.vue';
import QuestLog from './QuestLog.vue';
import SettingsPanel from './SettingsPanel.vue';
import SonarPanel from './SonarPanel.vue';
import StatusBar from './StatusBar.vue';
import TelegraphPanel from './TelegraphPanel.vue';
import UbootPanel from './UbootPanel.vue';
import VitalsPanel from './VitalsPanel.vue';
import { isTextEntry } from './dom';

defineProps<{ error?: string | null }>();

const devMenu = ref<InstanceType<typeof DevMenu> | null>(null);
const settingsOpen = ref(false);

/**
 * Das Browser-Kontextmenü wird bisher nur auf dem Canvas unterdrückt
 * (Game.init). Über einem Panel ginge es sonst auf.
 */
function suppressContextMenu(event: MouseEvent): void {
  if (isTextEntry(event.target)) return;
  event.preventDefault();
}
</script>

<template>
  <!--
    Grid statt absolut positionierter Panels: Grid-Kinder können sich strukturell
    nicht überlagern. Der einzige verbleibende Fehlerfall ist Überlauf, und der
    sieht aus wie Abschneiden statt wie Überdecken.
  -->
  <div class="hud-root" @contextmenu="suppressContextMenu">
    <!--
      Die Panels lesen den HUD-Zustand selbst statt ihn als Prop zu bekommen:
      der Snapshot behält seine Objektidentität, ein Prop wäre für Vue immer
      unverändert und das Update würde übersprungen.
    -->
    <!--
      Die obere Leiste läuft randlos über die volle Breite und bringt ihren
      Innenabstand selbst mit. Deshalb hat `.hud-root` kein Polster mehr —
      sonst könnte ihr Hintergrund nicht bis an die Kanten reichen.
    -->
    <div class="hud-root__top">
      <StatusBar @toggle-dev="devMenu?.toggle()" @toggle-settings="settingsOpen = !settingsOpen" />
      <div class="hud-root__strip"></div>
    </div>

    <SettingsPanel v-if="settingsOpen" @close="settingsOpen = false" />

    <div class="hud-root__middle">
      <div class="hud-root__middle-left">
        <QuestLog />
        <DevMenu ref="devMenu" />
        <p v-if="error" class="hud__panel hud-root__error">Renderer-Fehler: {{ error }}</p>
      </div>
      <VitalsPanel />
    </div>

    <div class="hud-root__bottom">
      <!-- Sonar und Ereignislog teilen sich die linke Ecke; das Log steht
           RECHTS daneben und wächst von unten nach oben. -->
      <div class="hud-root__left">
        <SonarPanel />
        <EventLog />
      </div>
      <AmmoBar />
      <div class="hud-root__right">
        <UbootPanel />
        <TelegraphPanel />
      </div>
    </div>

    <DeathNotice />
    <ExtractionPanel />
  </div>
</template>

<style scoped>
.hud-root {
  position: absolute;
  inset: 0;
  display: grid;
  grid-template-rows: auto 1fr auto;
  /* Kein Polster und kein Zeilenabstand: die obere Leiste läuft randlos, die
     beiden anderen Zeilen bringen ihren Abstand selbst mit. */
  gap: 0;
  padding: 0;
  /* Durchlässig — nur die Panels selbst fangen Eingaben ab. */
  pointer-events: none;
}

/*
 * Eine deckende Leiste ist eine Fläche, durch die man nicht hindurchklickt —
 * anders als die durchsichtigen Panels fängt sie Eingaben auf ganzer Breite ab.
 */
.hud-root__top {
  pointer-events: auto;
}

.hud-root__strip {
  /*
   * Feste 13 px (native Höhe der überarbeiteten Grafik vom 2026-08-12 — die
   * Lücke zur Topbar ist jetzt im Bild selbst geschlossen), bewusst NICHT über
   * `--ui-scale`: die Struktur liegt in der senkrechten Schichtung und ist nur
   * bei nativer Höhe pixelgenau. Die Leiste trägt keine Schrift.
   */
  height: 13px;
  /*
   * Waagerecht auf die volle Breite gezogen statt gekachelt: die Grafik ist
   * 1920 px breit und ihre Struktur so fein, dass die Streckung nicht auffällt,
   * während eine Kachelung an den Stößen sichtbare Nähte hätte.
   */
  background: url('../assets/ui/menu-strip.png') center / 100% 100% no-repeat;
}

/*
 * Zwei Spalten: links der Stapel aus Auftragsbuch und Entwicklermenü, rechts
 * Rumpf und Panzerung. `1fr auto` statt `auto auto` — sonst rückte die rechte
 * Ecke mit, sobald links etwas Breites auftaucht.
 */
.hud-root__middle {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: start;
  gap: var(--ui-gap);
  min-height: 0;
  padding: var(--ui-gap) 16px 0;
}

.hud-root__middle-left {
  display: flex;
  flex-direction: column;
  gap: var(--ui-gap);
  align-items: start;
  min-width: 0;
}

.hud-root__bottom {
  display: grid;
  padding: 0 16px 16px;
  /* Die beiden gleichen 1fr zentrieren die Munitionsleiste exakt auf der
     Bildmitte, unabhängig davon dass Sonar und Telegraf verschieden breit sind. */
  grid-template-columns: 1fr auto 1fr;
  align-items: end;
  gap: var(--ui-gap);
}

.hud-root__bottom > :first-child {
  justify-self: start;
}

.hud-root__bottom > :last-child {
  justify-self: end;
}

/* Tauchsteuerung und Telegraf teilen sich die rechte Ecke. */
.hud-root__right {
  display: flex;
  align-items: flex-end;
  gap: var(--ui-gap);
}

/* Sonar + Ereignislog links — beide auf der Unterkante ausgerichtet. */
.hud-root__left {
  display: flex;
  align-items: flex-end;
  gap: var(--ui-gap);
  min-width: 0;
}

.hud-root__error {
  border-color: #e2555a;
  color: #f4b3b5;
  max-width: 32rem;
}

@media (max-width: 760px) {
  .hud-root {
    --ui-gap: 8px;
  }

  .hud-root__middle {
    padding: var(--ui-gap) 8px 0;
  }

  .hud-root__bottom {
    padding: 0 8px 8px;
  }
}
</style>
