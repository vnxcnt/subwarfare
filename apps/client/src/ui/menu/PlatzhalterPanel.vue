<script setup lang="ts">
/**
 * Platzhalter für Bereiche, die es noch nicht gibt (Flottille, Neuigkeiten).
 * Bewusst dumm und rein präsentational — sobald ein Bereich echt wird,
 * bekommt er seine eigene Komponente und dieser Eintrag fliegt raus.
 */
defineProps<{ title: string; text: string }>();
</script>

<template>
  <section class="gold-panel menu__panel" :aria-label="title">
    <h2 class="gold-panel__title">{{ title }}</h2>
    <p class="menu__soon">{{ text }}</p>
  </section>
</template>
