<script setup lang="ts">
import { computed } from 'vue';
import { account, progression } from '../../state/auth';
import { rankIconUrl } from '../rankIcons';

/**
 * Spieler-Plakette oben rechts — Identität, Rang, XP und Coins auf einen
 * Blick (AoE2-Vorbild). Der middlemenu-Rahmen ist der einzige 9-Slice mit
 * gefülltem Grund und deckt damit den hellen Himmel des Hafenbilds ab.
 * Das Zahnrad öffnet die Einstellungen — die linke Menüspalte bleibt frei
 * für die Spiel-Bereiche.
 */
const emit = defineEmits<{ settings: [] }>();

const coinsFormat = new Intl.NumberFormat('de-DE');
const coins = computed(() => coinsFormat.format(account.value?.coins ?? 0));
const rankIcon = computed(() => rankIconUrl(progression.value.level));
</script>

<template>
  <section class="badge" aria-label="Konto">
    <img
      v-if="account?.avatarUrl"
      class="badge__avatar"
      :src="account.avatarUrl"
      alt=""
      referrerpolicy="no-referrer"
    />
    <div v-else class="badge__avatar badge__avatar--fallback">
      {{ (account?.displayName ?? '?').slice(0, 1).toUpperCase() }}
    </div>

    <div class="badge__who">
      <h1 class="badge__name">{{ account?.displayName ?? '—' }}</h1>
      <p class="badge__meta">{{ account?.isDev ? 'Entwickler-Konto' : 'Kapitän' }}</p>
    </div>

    <div class="badge__rank">
      <img v-if="rankIcon" class="badge__rank-icon" :src="rankIcon" alt="" />
      <div class="badge__rank-text">
        <span class="badge__rank-name">{{ progression.rank }}</span>
        <span class="badge__rank-level hud__num">Level {{ progression.level }}</span>
      </div>
    </div>

    <div class="badge__progress">
      <div
        class="badge__xp-bar"
        :title="
          progression.xpForNext > 0
            ? `${coinsFormat.format(progression.xpIntoLevel)} / ${coinsFormat.format(progression.xpForNext)} XP`
            : 'Höchstrang erreicht'
        "
      >
        <div :style="{ width: `${Math.round(progression.progress * 100)}%` }"></div>
      </div>
      <div class="badge__coins">
        <img class="menu__coin menu__coin--small" src="../../assets/ui/coin.png" alt="" />
        <span class="badge__coins-amount hud__num">{{ coins }}</span>
      </div>
    </div>

    <button
      class="badge__settings"
      type="button"
      title="Einstellungen"
      aria-label="Einstellungen"
      @click="emit('settings')"
    >
      <span class="material-symbols-outlined">settings</span>
    </button>
  </section>
</template>

<style scoped>
.badge {
  position: absolute;
  top: 0.9rem;
  right: 1.1rem;
  z-index: 5;
  display: flex;
  align-items: center;
  gap: 0.8rem;
  box-sizing: border-box;
  padding: 0.4rem 0.7rem;
  border: 18px solid transparent;
  border-image: url('../../assets/ui/middlemenu.png') 90 fill / 18px 26px;
  border-radius: 12px;
  background-color: #141310;
  color: #e9e2cd;
  user-select: none;
}

.badge__avatar {
  width: 40px;
  height: 40px;
  border: 1px solid var(--gold-border);
  object-fit: cover;
}

.badge__avatar--fallback {
  display: grid;
  place-items: center;
  background: var(--gold-faint);
  color: var(--gold);
  font-size: 1.15rem;
  font-weight: 600;
}

.badge__who {
  min-width: 0;
  max-width: 11rem;
}

.badge__name {
  margin: 0;
  font-size: 0.9375rem;
  letter-spacing: 0.05em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.badge__meta {
  margin: 0.1rem 0 0;
  font-size: 0.5625rem;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  opacity: 0.55;
}

.badge__rank {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding-left: 0.8rem;
  border-left: 1px solid var(--gold-border);
}

.badge__rank-icon {
  width: 30px;
  height: 30px;
  image-rendering: -webkit-optimize-contrast;
}

.badge__rank-text {
  display: grid;
  line-height: 1.25;
}

.badge__rank-name {
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  white-space: nowrap;
}

.badge__rank-level {
  font-size: 0.5625rem;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: var(--gold);
  opacity: 0.85;
}

.badge__progress {
  display: grid;
  gap: 0.3rem;
  min-width: 7rem;
  padding-left: 0.8rem;
  border-left: 1px solid var(--gold-border);
}

.badge__xp-bar {
  height: 4px;
  background: var(--gold-faint);
}

.badge__xp-bar > div {
  height: 100%;
  background: linear-gradient(90deg, var(--gold), var(--gold-bright));
}

.badge__coins {
  display: flex;
  align-items: center;
  gap: 0.35rem;
}

.badge__coins-amount {
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--gold-bright);
}

.badge__settings {
  display: inline-flex;
  align-self: flex-start;
  padding: 0.1rem;
  border: none;
  background: none;
  color: var(--gold);
  opacity: 0.65;
  cursor: pointer;
}

.badge__settings:hover {
  opacity: 1;
}

.badge__settings .material-symbols-outlined {
  font-size: 18px;
}

/* Schmale Fenster: die Plakette verliert Rang-Details, bleibt aber lesbar. */
@media (max-width: 980px) {
  .badge__rank,
  .badge__progress {
    display: none;
  }
}
</style>
