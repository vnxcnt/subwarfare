import { SHIP_PRICES, type PlayableModel } from './economy.js';

/**
 * Werft: Schiffs-Slots und Reparatur.
 *
 * Schiffe sind gekaufte INSTANZEN mit persistenten HP. Versenkung oder das
 * Verlassen der Runde ohne Extraktion setzt sie auf 0; Extraktion erhält die
 * Rest-HP. Reparieren kostet ZEIT (und bei Kaufschiffen Coins) — die Formeln
 * hier sind die einzige Quelle: api (durchsetzen) und Client (anzeigen)
 * rechnen identisch.
 */

/** Schiffs-Slots je Konto — mehr Schiffe gibt es nicht. */
export const SHIP_SLOTS = 6;

/**
 * Reparatur-Basiswert je Modell. 1 entspricht 10 Minuten Vollreparatur —
 * reine Stellschrauben fürs Balancing.
 */
export const REPAIR_BASE: Record<PlayableModel, number> = {
  fregatte01: 1,
  fregatte02: 2.5,
  submarine01: 1,
  submarine02: 3.5,
  destroyer01: 3.5,
  destroyer02: 8,
  destroyer03: 5,
  submarine03: 6,
  submarine04: 3,
};

/** Perk-Slots je Modell — wie viele Perks eine Instanz tragen kann. */
export const PERK_SLOTS_BY_MODEL: Record<PlayableModel, number> = {
  fregatte01: 1,
  fregatte02: 2,
  submarine01: 1,
  submarine02: 3,
  destroyer01: 3,
  destroyer02: 5,
  destroyer03: 4,
  submarine03: 4,
  submarine04: 3,
};

/** Sekunden je Basiswert-Punkt bei Vollreparatur (10 Minuten). */
const SECONDS_PER_BASE = 600;

/** Coins je Basiswert-Punkt bei Vollreparatur (nur Kaufschiffe). */
const COINS_PER_BASE = 150;

/**
 * Schadens-Faktor: Totalschaden (hp ≤ 0) kostet voll; Teilschaden halbiert
 * den Basiswert und skaliert dann anteilig mit den fehlenden HP. Unbeschädigt
 * ist 0 — es gibt nichts zu reparieren.
 */
function damageFactor(hp: number, maxHp: number): number {
  if (hp <= 0) return 1;
  if (hp >= maxHp || maxHp <= 0) return 0;
  return 0.5 * (1 - hp / maxHp);
}

/**
 * Reparaturdauer in Sekunden. `Math.ceil`, damit Restschaden nie in 0 Sekunden
 * verschwindet. Fixtures: destroyer02 hp 0 → 4800; fregatte02 275/550 → 375;
 * submarine02 hp 0 → 2100; fregatte01 100/500 → 240.
 */
export function repairSeconds(model: PlayableModel, hp: number, maxHp: number): number {
  const factor = damageFactor(hp, maxHp);
  if (factor === 0) return 0;
  return Math.ceil(REPAIR_BASE[model] * SECONDS_PER_BASE * factor);
}

/**
 * Reparaturkosten in Coins. Schiffe mit Kaufpreis 0 reparieren GRATIS — wer
 * pleite ist, sperrt sich nie aus. Der Preis kommt seit Migration 18 aus der
 * ships-Tabelle; api und Client reichen ihn durch, der Default deckt nur den
 * Betrieb ohne Katalog. Fixtures: destroyer02 hp 0 → 1200; fregatte02
 * 275/550 → 94; submarine02 hp 0 → 525; fregatte01 → 0.
 */
export function repairCost(
  model: PlayableModel,
  hp: number,
  maxHp: number,
  price: number = SHIP_PRICES[model],
): number {
  if (price === 0) return 0;
  return Math.round(REPAIR_BASE[model] * COINS_PER_BASE * damageFactor(hp, maxHp));
}
