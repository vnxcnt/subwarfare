<script setup lang="ts">
import { DAMAGE } from '@subwarfare/shared';
import { computed } from 'vue';
import periAusUrl from '../assets/ui/periscope_off.webp';
import periAnUrl from '../assets/ui/periscope_on.webp';
import bootObenUrl from '../assets/ui/submarine_onwater.webp';
import bootUntenUrl from '../assets/ui/submarine_underwater.webp';
import { hud, orderDive, orderPeriscope } from '../state/hud';

/**
 * U-Boot-Steuerung: Periskop und Tauchen in EINEM Rahmen (Auftragsbuch-UX,
 * wie das Instrumenten-Panel daneben). Die Knöpfe sind Zustands-Plaketten —
 * rot heißt aktiv (ausgefahren bzw. abgetaucht), blau ruhend. Sie zeigen das
 * BEFOHLENE Ziel, nicht den Übergang: der Klick antwortet sofort, und der
 * schmale Balken darunter läuft dem Boot hinterher (3 s Periskop, 5 s Tiefe).
 *
 * Erscheint nur bei tauchfähigen Booten; der Server prüft jeden Befehl selbst.
 */
const periBild = computed(() => (hud.value.periscopeTarget ? periAnUrl : periAusUrl));
const tauchBild = computed(() => (hud.value.diveTarget ? bootUntenUrl : bootObenUrl));

/**
 * Schwer beschädigt (unter der Auftauch-Schwelle) ist Abtauchen gesperrt —
 * der Server verwirft den Befehl ohnehin, der Knopf sagt es ehrlich vorher.
 */
const tauchsperre = computed(
  () => !hud.value.diveTarget && hud.value.hp < hud.value.maxHp * DAMAGE.surfaceHpRatio,
);

const periPercent = computed(() => Math.round(hud.value.periscope * 100));
const tauchPercent = computed(() => Math.round(hud.value.depth * 100));

const periLabel = computed(() =>
  hud.value.periscopeTarget ? 'Periskop einfahren' : 'Periskop ausfahren',
);
const tauchLabel = computed(() => {
  if (tauchsperre.value) return 'Zu schwer beschädigt zum Tauchen';
  return hud.value.diveTarget ? 'Auftauchen' : 'Abtauchen';
});
</script>

<template>
  <section v-if="hud.canDive" class="hud__panel uboot" aria-label="U-Boot-Steuerung">
    <div class="uboot__spalte">
      <button
        type="button"
        class="uboot__knopf"
        :aria-label="periLabel"
        :title="periLabel"
        @click="orderPeriscope(!hud.periscopeTarget)"
      >
        <img :src="periBild" alt="" draggable="false" />
      </button>
      <!-- Füllt sich von UNTEN — das Periskop steigt aus dem Turm auf. -->
      <div class="uboot__balken uboot__balken--steigend">
        <div :style="{ height: `${periPercent}%` }"></div>
      </div>
    </div>

    <div class="uboot__spalte">
      <button
        type="button"
        class="uboot__knopf"
        :class="{ 'uboot__knopf--gesperrt': tauchsperre }"
        :disabled="tauchsperre"
        :aria-label="tauchLabel"
        :title="tauchLabel"
        @click="orderDive(!hud.diveTarget)"
      >
        <img :src="tauchBild" alt="" draggable="false" />
      </button>
      <!-- Tiefenanzeige: füllt sich von OBEN — das Boot sinkt ja hinab. -->
      <div class="uboot__balken">
        <div :style="{ height: `${tauchPercent}%` }"></div>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* Gleicher Rahmen wie Auftragsbuch und Instrumenten-Panel: quest-frame als
   9-Slice, dunkler Grund unter dem Rahmenbild. */
.uboot {
  box-sizing: border-box;
  display: flex;
  gap: 10px;
  padding: 6px 8px;
  border: 24px solid transparent;
  border-image: url('../assets/ui/quest-frame.png') 50 / 24px stretch;
  border-radius: 0;
  background: #141310;
  backdrop-filter: none;
}

.uboot__spalte {
  display: flex;
  flex-direction: column;
  gap: 5px;
  align-items: center;
}

/* Die Plaketten bringen Rahmen und Zustand (rot = aktiv) selbst mit. */
.uboot__knopf {
  display: block;
  padding: 0;
  border: 0;
  background: none;
  cursor: pointer;
  filter: drop-shadow(0 2px 3px rgb(0 0 0 / 45%));
}

.uboot__knopf:hover:not(:disabled) img {
  filter: brightness(1.12);
}

.uboot__knopf img {
  display: block;
  width: 82px;
  height: auto;
  -webkit-user-drag: none;
}

.uboot__knopf--gesperrt {
  cursor: not-allowed;
}

.uboot__knopf--gesperrt img {
  filter: grayscale(0.7) brightness(0.7);
}

/* Schmaler Übergangs-Balken — die Plakette sagt WOHIN, er sagt WIE WEIT. */
.uboot__balken {
  width: 82px;
  height: 5px;
  background: rgb(0 0 0 / 55%);
  border: 1px solid rgb(111 208 189 / 25%);
  overflow: hidden;
}

.uboot__balken > div {
  width: 100%;
  background: rgb(111 208 189 / 55%);
  transition: height 120ms linear;
}

/* „Steigend": der Füllstand wächst von unten nach oben. */
.uboot__balken--steigend {
  display: flex;
  align-items: flex-end;
}
</style>
