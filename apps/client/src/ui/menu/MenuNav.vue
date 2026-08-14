<script setup lang="ts">
import { useRouter } from 'vue-router';
import logoUrl from '../../assets/ui/logo_main_white_login.png';
import { logout } from '../../state/auth';
import { leaveQueue } from '../../state/lobby';
import { MAIN_SECTIONS, type MenuSection } from './sections';

/**
 * Linke Menüspalte im AoE2:DE-Stil: Logo, drei große Bereichs-Punkte, ein
 * Zier-Trenner, darunter die kleinen Knöpfe Neuigkeiten und Ausloggen.
 *
 * Die Punkte sind CSS-Text auf dem vorhandenen health.png-9-Slice — bewusst
 * Platzhalter statt neuer Bitmaps, bis eigene Plaketten-Grafiken existieren.
 * Klick auf den aktiven Punkt schließt zurück zum Landing (nur Hafenbild).
 */
const section = defineModel<MenuSection | null>({ required: true });

const router = useRouter();

function wechsle(ziel: MenuSection): void {
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
      :class="{ 'nav__item--active': section === eintrag.id }"
      :data-section="eintrag.id"
      @click="wechsle(eintrag.id)"
    >
      <span class="nav__item-label">{{ eintrag.label }}</span>
      <span class="nav__item-detail">{{ eintrag.detail }}</span>
    </button>

    <div class="nav__strip" aria-hidden="true"></div>

    <button
      type="button"
      class="nav__item nav__item--small"
      :class="{ 'nav__item--active': section === 'neuigkeiten' }"
      data-section="neuigkeiten"
      @click="wechsle('neuigkeiten')"
    >
      <span class="nav__item-label">Neuigkeiten</span>
    </button>
    <button type="button" class="nav__item nav__item--small" @click="signOut">
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

/* Menüpunkt: Text auf dem flachen health.png-Slice — die AoE2-Plakette. */
.nav__item {
  display: grid;
  gap: 0.15rem;
  box-sizing: border-box;
  min-height: 64px;
  padding: 0.55rem 1rem;
  border: 14px solid transparent;
  border-image: url('../../assets/ui/health.png') 70 fill / 14px 20px;
  background: none;
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

/* Aktiv: goldener Balken links + Goldrand — der Punkt „brennt". */
.nav__item--active {
  color: var(--gold-bright);
  box-shadow: inset 0 0 0 1px var(--gold);
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
}

.nav__item-detail {
  font-size: 0.65rem;
  letter-spacing: 0.08em;
  opacity: 0.55;
}

.nav__strip {
  height: 13px;
  margin: 0.8rem 0;
  background: url('../../assets/ui/menu-strip.png') center / 100% 100% no-repeat;
  opacity: 0.7;
}

.nav__item--small {
  min-height: 40px;
  padding: 0.35rem 1rem;
}

.nav__item--small .nav__item-label {
  font-size: 0.75rem;
  letter-spacing: 0.12em;
}
</style>
