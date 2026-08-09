<script setup lang="ts">
import { AMMO_SLOTS } from '../config';

/**
 * ⚠️ Reine Anzeige. Es gibt kein Waffensystem, keinen Schiffstyp-Begriff und
 * keine server-seitige Munitionsverwaltung — die Zahlen stehen fest in der
 * Config. Bewusst so belassen, statt eine Auswahl vorzutäuschen, die nichts tut.
 *
 * Wenn es echt wird: Munition ist server-autoritativ. Der Client zeigt an, was
 * ihm der Server schickt, und schickt nur die Absicht zu feuern.
 */
</script>

<template>
  <section class="ammo" aria-label="Munition">
    <ul class="ammo__slots">
      <li v-for="(slot, index) in AMMO_SLOTS" :key="slot.id" class="hud__panel ammo__slot">
        <span class="ammo__key">{{ index + 1 }}</span>

        <img v-if="slot.icon" class="ammo__icon" :src="slot.icon" :alt="slot.label" />
        <!-- Ohne Grafik das Kürzel, damit der Slot nicht leer dasteht. -->
        <span v-else class="ammo__icon ammo__short">{{ slot.short }}</span>

        <span class="ammo__count hud__num">{{ slot.count }}</span>
        <span class="ammo__label">{{ slot.label }}</span>
      </li>
    </ul>
  </section>
</template>

<style scoped>
/*
 * Der Container bleibt durchlässig — sonst finge ein unsichtbarer Streifen
 * mitten im Bild die Fahrbefehle ab. Nur die Kacheln selbst fangen Klicks
 * (über .hud__panel).
 */
.ammo {
  pointer-events: none;
}

.ammo__slots {
  display: grid;
  grid-template-columns: repeat(4, 64px);
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.ammo__slot {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
  padding: 0.4rem 0.25rem 0.3rem;
  opacity: 0.6;
}

.ammo__key {
  position: absolute;
  top: 2px;
  left: 4px;
  font-size: calc(0.5625rem * var(--ui-scale));
  opacity: 0.45;
}

.ammo__icon {
  display: block;
  width: 100%;
  height: calc(30px * var(--ui-scale));
  object-fit: contain;
  /*
   * Heller Konturschimmer. Die Icons liegen in unterschiedlichen
   * Helligkeitsbereichen — der Torpedo hat gegen den Panel-Hintergrund nur rund
   * 1,8:1 Kontrast und verschwände sonst, während die Wasserbombe bei 11,5:1
   * liegt. Der Schimmer hebt dunkle Silhouetten an, ohne helle zu stören.
   */
  filter: drop-shadow(0 0 1px rgb(207 230 242 / 55%));
}

.ammo__short {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: calc(0.75rem * var(--ui-scale));
  letter-spacing: 0.1em;
  opacity: 0.45;
  filter: none;
}

.ammo__count {
  font-size: calc(1.0625rem * var(--ui-scale));
  line-height: 1.1;
  color: var(--ui-accent);
}

.ammo__label {
  font-size: calc(0.5625rem * var(--ui-scale));
  opacity: 0.4;
}

@media (max-width: 760px) {
  .ammo__slots {
    grid-template-columns: repeat(4, 44px);
  }

  .ammo__label {
    display: none;
  }
}
</style>
