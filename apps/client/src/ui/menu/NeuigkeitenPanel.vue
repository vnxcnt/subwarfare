<script setup lang="ts">
import bannerUpdate01 from '../../assets/news/update_log_01.webp';

/**
 * Neuigkeiten — Ankündigungen und Patch-Notizen. Die Einträge sind bewusst
 * eine Liste IM CODE (neuester zuerst): sie ändern sich mit einem Deploy,
 * genau wie das, was sie ankündigen. Ein CMS wäre hier nur ein zweiter Ort,
 * der auseinanderlaufen kann.
 */
const EINTRAEGE: ReadonlyArray<{
  id: string;
  titel: string;
  banner: string | null;
  absaetze: string[];
}> = [
  {
    id: 'v0.0.0.1',
    titel: 'Family & Friends Update – v0.0.0.1',
    banner: bannerUpdate01,
    absaetze: [
      'Willkommen zum ersten Family & Friends Test von Sub Warfare!',
      'Mit der Version v0.0.0.1 ist ein wichtiger erster Schritt geschafft: Unsere erste spielbare Map ist fertig und steht ab sofort zum Testen bereit.',
      'Damit beginnt die erste richtige Testphase. Ihr könnt euch auf der Karte bewegen, erste Funktionen ausprobieren und uns dabei helfen, Fehler, Probleme und Verbesserungspotenzial zu finden.',
      'Bitte denkt daran: Das Spiel befindet sich noch in einer sehr frühen Entwicklungsphase. Viele Inhalte, Funktionen und Systeme werden erst nach und nach ergänzt.',
      'Viel Spaß beim Testen und willkommen an Bord!',
    ],
  },
];
</script>

<template>
  <div class="news">
    <section
      v-for="eintrag in EINTRAEGE"
      :key="eintrag.id"
      class="gold-panel menu__panel news__eintrag"
      :aria-label="eintrag.titel"
    >
      <img
        v-if="eintrag.banner"
        class="news__banner"
        :src="eintrag.banner"
        alt=""
        draggable="false"
      />
      <h2 class="news__titel">{{ eintrag.titel }}</h2>
      <p v-for="(absatz, index) in eintrag.absaetze" :key="index" class="news__absatz">
        {{ absatz }}
      </p>
    </section>
  </div>
</template>

<style scoped>
.news {
  display: grid;
  gap: 1rem;
  max-width: none !important;
  width: min(44rem, 100%);
}

.news__banner {
  width: 100%;
  height: auto;
  margin-bottom: 0.9rem;
  border: 1px solid var(--gold-border);
  -webkit-user-drag: none;
}

.news__titel {
  margin: 0 0 0.7rem;
  font-size: 1.05rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: var(--gold-bright);
}

.news__absatz {
  margin: 0 0 0.7rem;
  font-size: 0.8438rem;
  line-height: 1.55;
}

.news__absatz:last-child {
  margin-bottom: 0;
}
</style>
