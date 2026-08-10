<script setup lang="ts">
import { computed } from 'vue';
import { hud } from '../state/hud';

/**
 * ⚠️ Es gibt kein Questsystem. Statt erfundene Aufträge anzuzeigen, führt das
 * Auftragsbuch den einen echten, den der Client kennt: den Fahrbefehl.
 *
 * Der Fortschritt wird aus der Restdistanz ABGELEITET und nicht gespeichert —
 * ein zweites Fortschrittsfeld wäre eine zweite Wahrheit und nach dem ersten
 * Teilupdate falsch. Später liefert der Server echte Aufträge, die Struktur
 * (Titel, Ziele, Fortschritt aus Ist/Soll) bleibt dieselbe.
 */
const order = computed(() => {
  const { waypointDistance: remaining, waypointTotal: total } = hud.value;
  if (remaining === null || total === null || total <= 0) return null;

  const done = Math.min(Math.max(1 - remaining / total, 0), 1);
  return {
    remainingKm: (remaining / 1000).toFixed(2),
    totalKm: (total / 1000).toFixed(2),
    percent: Math.round(done * 100),
  };
});
</script>

<template>
  <section class="hud__panel quests" aria-label="Auftragsbuch">
    <h2 class="hud__panel-title">Auftragsbuch</h2>

    <ol v-if="order" class="quests__list">
      <li class="quests__item">
        <div class="quests__head">
          <span class="quests__title">Kurs anliegen</span>
          <span class="quests__percent hud__num">{{ order.percent }} %</span>
        </div>
        <div class="quests__bar"><div :style="{ width: `${order.percent}%` }"></div></div>
        <p class="quests__detail hud__num">
          noch {{ order.remainingKm }} km von {{ order.totalKm }} km
        </p>
      </li>
    </ol>

    <p v-else class="hud__empty">
      Keine Aufträge.<br />
      A/D steuern das Ruder, W/S den Telegrafen.
    </p>
  </section>
</template>

<style scoped>
/*
 * Rahmen als 9-Slice statt als gestrecktes Hintergrundbild: das Panel wächst
 * mit seinem Inhalt, und eine Streckung würde die Eckbeschläge mitverzerren.
 * `border-image` hält die vier Ecken maßstäblich und dehnt nur die Bänder.
 *
 * Anders als beim Sonar liegt der Rahmen hier NICHT über dem Inhalt — er ist
 * der Rand des Elements, der Inhalt sitzt schon innerhalb. Es kann also
 * nichts überdeckt werden.
 *
 * Der Schnitt von 50 deckt die Eckbeschläge ab (sie reichen 49 bzw. 45 px in
 * die Grafik). Bei 24 px Randbreite erscheint das Band 11,5 px stark und passt
 * damit zum Sonarrahmen.
 */
.quests {
  box-sizing: border-box;
  width: 300px;
  max-height: min(260px, 36vh);
  overflow-y: auto;
  padding: 2px 6px 4px;
  border: 24px solid transparent;
  border-image: url('../assets/ui/quest-frame.png') 50 / 24px stretch;
  border-radius: 0;
  /*
   * Der Hintergrund reicht bis zur Außenkante des Randes und liegt unter dem
   * Rahmenbild — dadurch ist die Fläche zwischen Band und Inhalt gefüllt statt
   * durchsichtig, genau wie beim Sonar.
   */
  background: #141310;
  backdrop-filter: none;
}

.quests__list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.quests__head {
  display: flex;
  justify-content: space-between;
  gap: 0.5rem;
}

.quests__title {
  font-weight: 500;
}

.quests__percent {
  color: var(--ui-accent);
}

.quests__bar {
  height: 2px;
  margin: 0.3rem 0;
  background: rgb(111 208 189 / 15%);
}

.quests__bar > div {
  height: 100%;
  background: var(--ui-accent);
}

.quests__detail {
  margin: 0;
  opacity: 0.5;
  font-size: calc(0.6875rem * var(--ui-scale));
}

@media (max-width: 1000px) {
  .quests {
    width: 220px;
  }
}
</style>
