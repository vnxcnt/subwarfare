import type { VesselModel } from '../types/Player.js';

/**
 * Kampfwerte — Waffen und Rumpfmaße.
 *
 * Liegt in shared, weil beide Seiten dieselben Zahlen brauchen: der Server
 * rechnet damit autoritativ (Abschuss, Kollision, Schaden), der Client leitet
 * Anzeigen daraus ab (Munitionsleiste, Nachladebalken). Eine zweite Tabelle im
 * Client wäre eine zweite Wahrheit.
 */

/** Der Standard-Torpedo (Grafik-Atlas `torpedo01`). */
export const TORPEDO = {
  /** Waffen-Kennung in `armament` der ships-Tabelle. */
  weapon: 'torpedo',
  /** Grafik-Kennung — der Client wählt darüber den Richtungs-Atlas. */
  model: 'torpedo01',
  /**
   * Laufgeschwindigkeit in m/s. Muss über der Höchstfahrt des schnellsten
   * Schiffs liegen (speedster01: 1,3 × 34,5 = 44,85 m/s), sonst wäre
   * Weglaufen die beste Torpedoabwehr. (45 → 67,5 am 2026-08-10: +50 %.)
   */
  speed: 67.5,
  /** Laufstrecke in Metern — danach ist er ein Blindgänger und verschwindet. */
  rangeMetres: 2_200,
  damage: 150,
  /** Rohrwechsel: Sperre zwischen zwei Schüssen in Sekunden. */
  cooldownSeconds: 3,
  /** Munitionsvorrat je Einsatz. Aufmunitionierung kommt später. */
  capacity: 12,
  /** Trefferradius des Torpedos selbst (kommt zum halben Beam des Ziels dazu). */
  hitRadius: 1.5,
} as const;

/**
 * Der Täuschkörper (Grafik-Atlas `torpedo02`): wird nach ACHTERN ausgestoßen
 * und läuft dem Boot davon — ein Torpedo, der ihm zu nahe kommt, detoniert
 * mitsamt dem Täuschkörper (Annäherungszündung, beide weg, kein Schaden).
 */
export const DECOY = {
  weapon: 'taeuschkoerper',
  model: 'torpedo02',
  /** Bewusst die URSPRÜNGLICHE Torpedogeschwindigkeit (vor dem +50 %-Buff). */
  speed: 45,
  rangeMetres: 1_500,
  cooldownSeconds: 5,
  capacity: 6,
  /** Abstand, ab dem ein Torpedo den Täuschkörper (und sich selbst) zündet. */
  triggerRadius: 70,
} as const;

/**
 * Das Geschütz (Grafik-Atlas `he_round01`): flach fliegende Granate im
 * BUGSEKTOR (±arcHalfAngleDeg um den Kurs). Die Peilung kommt vom Zielen mit
 * der Maus; außerhalb des Sektors verweigert der Server den Schuss.
 * 360 m/s = 18 m Tick-Schritt — deshalb testet die Kollision die Flugbahn
 * als STRECKE mit Unterproben (World, PROJECTILE_SAMPLE_SPACING), nicht mehr
 * nur die Endposition.
 */
export const GUN = {
  weapon: 'geschuetz',
  model: 'he_round01',
  /** 120 → 360 am 2026-08-10 (×3 auf Wunsch). */
  speed: 360,
  rangeMetres: 1_200,
  damage: 40,
  cooldownSeconds: 1.5,
  capacity: 40,
  hitRadius: 1,
  /** Halber Öffnungswinkel des Bugsektors in Grad. */
  arcHalfAngleDeg: 20,
} as const;

/**
 * Seitlicher Abwurfsektor für Torpedo/Täuschkörper bei ÜBERWASSERSCHIFFEN:
 * ±10° um die beiden Breitseiten (90° backbord/steuerbord vom Kurs). Schiffe
 * schießen Torpedos nicht nach vorn — sie werfen sie über die Seite ab.
 * U-Boote sind davon ausgenommen (Bugrohr voraus, Täuschkörper achtern).
 */
export const SIDE_LAUNCH_HALF_ANGLE_DEG = 10;

/**
 * Server-seitige Nachsicht bei der Sektorprüfung in Grad. Der Client zielt
 * mit der RENDER-Rotation (~125 ms Interpolationsverzug + Latenz) — wer bei
 * Drehfahrt exakt an den Sektorrand zielt, wäre sonst server-seitig schon
 * knapp draußen: grüne Linie, aber kommentarlos kein Schuss. Die Client-
 * Anzeige bleibt STRENG (ohne Toleranz), nur der Server gibt die Marge dazu.
 */
export const SECTOR_TOLERANCE_DEG = 3;

/**
 * Rumpfmaße in Metern für die Kollision: der Rumpf ist eine KAPSEL — Strecke
 * der Länge (length − beam) längs des Kurses, verdickt um beam/2. Die Längen
 * sind dieselben, mit denen der Client die Billboards skaliert; driften die
 * beiden auseinander, explodieren Torpedos sichtbar neben dem Schiff.
 */
export const HULL_DIMENSIONS: Record<VesselModel, { length: number; beam: number }> = {
  fregatte01: { length: 140, beam: 25 },
  yachtgun01: { length: 55, beam: 14 },
  submarine01: { length: 110, beam: 13 },
  speedster01: { length: 18, beam: 6 },
  tanker01: { length: 180, beam: 30 },
  fregatte02: { length: 145, beam: 26 },
  submarine02: { length: 120, beam: 14 },
  destroyer01: { length: 160, beam: 24 },
};

/**
 * Schadensfolgen — alle Schwellen als Anteil der vollen HP des Modells.
 * Der Server erzwingt sie (Drossel, Zwangsauftauchen), der Client zeigt sie
 * (Rauchstufen im Broadcast, gedrosselte Telegraf-Anzeige des eigenen Boots).
 */
export const DAMAGE = {
  /** Unter dieser HP-Quote fährt das Schiff nur noch gedrosselt … */
  slowHpRatio: 0.2,
  /** … mit diesem Anteil seiner Höchst- und Rückwärtsfahrt. */
  slowFactor: 0.5,
  /** Weißer Rauch unter dieser HP-Quote (Rauchstufe 1). */
  smokeWhiteHpRatio: 0.5,
  /** Schwarzer Rauch unter dieser HP-Quote (Rauchstufe 2). */
  smokeBlackHpRatio: 0.2,
  /** U-Boote unter dieser HP-Quote werden zwangsaufgetaucht und tauchen nicht mehr. */
  surfaceHpRatio: 0.2,
} as const;

/** Rauchstufe (PlayerState.smoke) aus HP und Modellmaximum — beide Seiten dieselbe Formel. */
export function smokeLevelForHp(hp: number, maxHp: number): number {
  if (maxHp <= 0 || hp <= 0) return 0;
  if (hp < maxHp * DAMAGE.smokeBlackHpRatio) return 2;
  if (hp < maxHp * DAMAGE.smokeWhiteHpRatio) return 1;
  return 0;
}

/** Wartezeit bis zum Wiedereinstieg nach einer Versenkung, in Sekunden. */
export const RESPAWN_SECONDS = 5;

/** Bots kehren langsamer zurück — die Karte soll nicht sofort wieder voll sein. */
export const BOT_RESPAWN_SECONDS = 10;
