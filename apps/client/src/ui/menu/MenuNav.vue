<script setup lang="ts">
import { FLEET_MIN_LEVEL } from '@subwarfare/shared';
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import logoUrl from '../../assets/ui/logo_main_white_login.png';
import artAuslaufen from '../../assets/ui/menu/auslaufen.webp';
import artDepot from '../../assets/ui/menu/depot.webp';
import artEinstellungen from '../../assets/ui/menu/einstellungen.webp';
import artFlottille from '../../assets/ui/menu/flottille.webp';
import artLogout from '../../assets/ui/menu/logout.webp';
import artNeuigkeiten from '../../assets/ui/menu/neuigkeiten.webp';
import artStatistiken from '../../assets/ui/menu/statistiken.webp';
import artWerft from '../../assets/ui/menu/werft.webp';
import seperatorUrl from '../../assets/ui/menu/seperator_menu.webp';
import { account, logout, progression } from '../../state/auth';
import { leaveQueue } from '../../state/lobby';
import { MAIN_SECTIONS, type MenuSection } from './sections';

/**
 * Linke Menüspalte im AoE2:DE-Stil: Logo, drei große Bereichs-Punkte, ein
 * Zier-Trenner, darunter die kleinen Knöpfe Neuigkeiten und Ausloggen.
 *
 * Jeder Punkt trägt sein Aquarell-Artwork als Hintergrund UNTER dem
 * health.png-Rahmen — dessen Mitte ist transparent, das Bild scheint durch
 * (border-image malt über den CSS-Hintergrund, deckt ihn hier aber nicht).
 * Der Text bleibt CSS auf einem seitlichen Verlauf, wie beim Vorbild.
 * Klick auf den aktiven Punkt schließt zurück zum Landing (nur Hafenbild).
 */
const section = defineModel<MenuSection | null>({ required: true });

/**
 * Einstellungen sind KEIN Bereich, sondern ein Overlay über allem (auch im
 * Spiel nutzbar) — der Knopf meldet deshalb nur nach oben, statt `section`
 * zu schalten. Die Shell öffnet dann das SettingsPanel.
 */
const emit = defineEmits<{ settings: [] }>();

const NAV_ART: Record<MenuSection, string> = {
  auslaufen: artAuslaufen,
  werft: artWerft,
  depot: artDepot,
  flottille: artFlottille,
  statistiken: artStatistiken,
  neuigkeiten: artNeuigkeiten,
};

function artStyle(bild: string): Record<string, string> {
  return { '--art': `url(${bild})` };
}

const router = useRouter();

/**
 * Flottillen erst ab FLEET_MIN_LEVEL — Dev-Konten ausgenommen (ohne
 * XP-Vergabe wäre der Punkt sonst für alle zu). Dieselbe Regel setzt die
 * api durch; der gesperrte Punkt ist nur die ehrliche Anzeige davon.
 */
const flottilleGesperrt = computed(
  () => !account.value?.isDev && progression.value.level < FLEET_MIN_LEVEL,
);

function gesperrt(ziel: MenuSection): boolean {
  return ziel === 'flottille' && flottilleGesperrt.value;
}

function detailFuer(eintrag: { id: MenuSection; detail: string }): string {
  return gesperrt(eintrag.id) ? `Ab Level ${FLEET_MIN_LEVEL}` : eintrag.detail;
}

function wechsle(ziel: MenuSection): void {
  if (gesperrt(ziel)) return;
  section.value = section.value === ziel ? null : ziel;
}

function signOut(): void {
  leaveQueue();
  logout();
  void router.replace({ name: 'login' });
}
</script>

<template>
  <nav class="nav" aria-label="Hauptmenü">
    <img class="nav__logo" :src="logoUrl" alt="Sub Warfare" draggable="false" />

    <button
      v-for="eintrag in MAIN_SECTIONS"
      :key="eintrag.id"
      type="button"
      class="nav__item"
      :class="{
        'nav__item--active': section === eintrag.id,
        'nav__item--locked': gesperrt(eintrag.id),
      }"
      :data-section="eintrag.id"
      :style="artStyle(NAV_ART[eintrag.id])"
      @click="wechsle(eintrag.id)"
    >
      <span class="nav__item-label">{{ eintrag.label }}</span>
      <span class="nav__item-detail">{{ detailFuer(eintrag) }}</span>
    </button>

    <div class="nav__trenner" aria-hidden="true">
      <span class="nav__trenner-linie"></span>
      <img class="nav__trenner-bild" :src="seperatorUrl" alt="" draggable="false" />
      <span class="nav__trenner-linie nav__trenner-linie--rechts"></span>
    </div>

    <button
      type="button"
      class="nav__item nav__item--small"
      :class="{ 'nav__item--active': section === 'statistiken' }"
      data-section="statistiken"
      :style="artStyle(NAV_ART.statistiken)"
      @click="wechsle('statistiken')"
    >
      <span class="nav__item-label">Statistiken</span>
    </button>
    <button
      type="button"
      class="nav__item nav__item--small"
      :class="{ 'nav__item--active': section === 'neuigkeiten' }"
      data-section="neuigkeiten"
      :style="artStyle(NAV_ART.neuigkeiten)"
      @click="wechsle('neuigkeiten')"
    >
      <span class="nav__item-label">Neuigkeiten</span>
    </button>
    <button
      type="button"
      class="nav__item nav__item--small"
      data-action="einstellungen"
      :style="artStyle(artEinstellungen)"
      @click="emit('settings')"
    >
      <span class="nav__item-label">Einstellungen</span>
    </button>
    <button
      type="button"
      class="nav__item nav__item--small"
      :style="artStyle(artLogout)"
      @click="signOut"
    >
      <span class="nav__item-label">Ausloggen</span>
    </button>
  </nav>
</template>

<style scoped>
/*
 * Die Spalte dunkelt das Hafenbild seitlich ab, statt es zu überdecken —
 * rechts läuft der Verlauf ins Transparente aus, das Aquarell bleibt Bühne.
 */
.nav {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  padding: 2rem 1.5rem 2rem 1.4rem;
  background: linear-gradient(
    90deg,
    rgb(10 9 7 / 90%) 0%,
    rgb(10 9 7 / 78%) 70%,
    transparent 100%
  );
  overflow-y: auto;
}

.nav__logo {
  width: 82%;
  max-width: 240px;
  align-self: center;
  margin-bottom: 1.6rem;
  filter: drop-shadow(0 4px 10px rgb(0 0 0 / 55%));
  -webkit-user-drag: none;
}

/*
 * Menüpunkt: Aquarell-Artwork als Grund, darüber der health.png-Rahmen
 * (transparente Mitte), Text auf einem seitlichen Verlauf — links dunkel
 * genug zum Lesen, rechts bleibt die Szene sichtbar.
 */
.nav__item {
  display: grid;
  gap: 0.15rem;
  align-content: center;
  box-sizing: border-box;
  min-height: 64px;
  padding: 0.55rem 1rem;
  border: 14px solid transparent;
  border-image: url('../../assets/ui/health.png') 70 fill / 14px 20px;
  background-image:
    linear-gradient(90deg, rgb(10 9 7 / 72%) 0%, rgb(10 9 7 / 34%) 55%, rgb(10 9 7 / 8%) 100%),
    var(--art);
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
  /* Bis unter die Rahmenkante füllen: Standard ist padding-box — `cover`
     rechnete dann zu klein und ließ oben/unten helle Streifen frei. */
  background-origin: border-box;
  background-clip: border-box;
  color: #e9e2cd;
  font: inherit;
  text-align: left;
  cursor: pointer;
  position: relative;
}

.nav__item:hover {
  color: var(--gold-bright);
  filter: brightness(1.15);
}

/* Aktiv: nur der goldene Balken links — ein Rahmen um den Rahmen wirkte
   wie eine Fehlermarkierung. */
.nav__item--active {
  color: var(--gold-bright);
}

/* Gesperrt (Levelschranke): ausgegraut, Klick läuft ins Leere. */
.nav__item--locked {
  opacity: 0.55;
  filter: grayscale(0.6);
  cursor: default;
}

.nav__item--locked:hover {
  color: #e9e2cd;
  filter: grayscale(0.6);
}

.nav__item--active::before {
  content: '';
  position: absolute;
  top: -8px;
  bottom: -8px;
  left: -11px;
  width: 3px;
  background: linear-gradient(180deg, var(--gold), var(--gold-bright));
}

.nav__item-label {
  font-size: 1rem;
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  text-shadow: 0 1px 3px rgb(0 0 0 / 85%);
}

.nav__item-detail {
  font-size: 0.65rem;
  letter-spacing: 0.08em;
  opacity: 0.7;
  text-shadow: 0 1px 2px rgb(0 0 0 / 85%);
}

/* Trenner: das weiße Ornament mittig, links und rechts eine feine weiße
   Akzentlinie, die zum Ornament hin aufleuchtet und nach außen ausläuft. */
.nav__trenner {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  margin: 0.7rem 0.2rem;
}

.nav__trenner-linie {
  flex: 1;
  height: 1px;
  background: linear-gradient(90deg, transparent, rgb(255 255 255 / 70%));
}

.nav__trenner-linie--rechts {
  background: linear-gradient(90deg, rgb(255 255 255 / 70%), transparent);
}

.nav__trenner-bild {
  height: 26px;
  width: auto;
  opacity: 0.9;
  filter: drop-shadow(0 1px 3px rgb(0 0 0 / 55%));
  -webkit-user-drag: none;
}

.nav__item--small {
  min-height: 40px;
  padding: 0.35rem 1rem;
  /* Die kleinen Motive (Offizier, U-Boot-Crew) leben im unteren Bilddrittel,
     und in 40 px Höhe passt das ganze Bild hinein — erst der Zoom mit
     Boden-Anker rückt die Szene statt des Himmels ins Sichtfenster. */
  background-size: 175% auto;
  background-position: center bottom;
}

.nav__item--small .nav__item-label {
  font-size: 0.75rem;
  letter-spacing: 0.12em;
}
</style>
