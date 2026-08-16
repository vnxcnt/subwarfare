import { DEFAULT_VESSEL_MODEL, type VesselModel } from '../types/Player.js';

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
 * Die Wasserbombe (Grafik-Atlas `waterbomb01`): die U-Boot-Jagdwaffe der
 * Überwasserschiffe. Sie wird nach ACHTERN und über die SEITEN abgeworfen
 * (`arcHalfAngleDeg` um Achteraus), fliegt kurz und schnell, SINKT dann an
 * Ort und Stelle und detoniert nach `sinkSeconds` mit Flächenwirkung.
 *
 * Der entscheidende Unterschied zu allen anderen Waffen: die Detonation trifft
 * auch GETAUCHTE Boote. Genau dafür ist sie da — Torpedo und Granate lassen
 * ein U-Boot in der Tiefe in Ruhe, die Wasserbombe nicht.
 */
export const DEPTH_CHARGE = {
  weapon: 'wasserbombe',
  model: 'waterbomb01',
  /** Schnell geworfen: die 150 m sind in gut 1,7 s zurückgelegt. */
  speed: 85,
  /** Wurfweite in Metern — bewusst kurz, man muss über das Ziel fahren. */
  rangeMetres: 150,
  /** Sinkzeit am Aufschlagpunkt bis zur Detonation. */
  sinkSeconds: 3,
  /** Schaden im Zentrum; fällt zum Rand des Wirkungskreises linear auf 0. */
  damage: 140,
  /** Wirkungsradius der Detonation in Metern. */
  blastRadius: 60,
  cooldownSeconds: 4,
  capacity: 12,
  /**
   * Halber Öffnungswinkel um ACHTERAUS (180° zum Kurs). 110° heißt: alles vom
   * Querab (90°) bis dead astern ist erlaubt — „nach hinten und zur Seite".
   */
  arcHalfAngleDeg: 110,
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
 * BASIS-Rumpfmaße in Metern für die Kollision: der Rumpf ist eine KAPSEL —
 * Strecke der Länge (length − beam) längs des Kurses, verdickt um beam/2.
 *
 * Seit ships.size (Migration 21) sind das KLASSEN-Basiswerte: alle spielbaren
 * Überwasserschiffe tragen die Fregatten-Basis (140/25), alle U-Boote die
 * U-Boot-Basis (110/13) — die tatsächliche Größe ist Basis × size aus der
 * ships-Tabelle (`scaledHull` unten). NPC-Modelle behalten eigene Maße bei
 * size 1. Die Längen sind dieselben, mit denen der Client die Billboards
 * skaliert; driften die beiden auseinander, explodieren Torpedos sichtbar
 * neben dem Schiff.
 */
export const HULL_DIMENSIONS: Record<VesselModel, { length: number; beam: number }> = {
  fregatte01: { length: 140, beam: 25 },
  yachtgun01: { length: 55, beam: 14 },
  submarine01: { length: 110, beam: 13 },
  speedster01: { length: 18, beam: 6 },
  tanker01: { length: 180, beam: 30 },
  fregatte02: { length: 140, beam: 25 },
  submarine02: { length: 110, beam: 13 },
  destroyer01: { length: 140, beam: 25 },
  destroyer02: { length: 140, beam: 25 },
  destroyer03: { length: 140, beam: 25 },
  submarine03: { length: 110, beam: 13 },
  submarine04: { length: 110, beam: 13 },
  // NPC auf der Überwasser-Basis: die Größe kommt wie bei den spielbaren
  // Schiffen aus ships.size (Träger: 4 → 560 m).
  carrier01: { length: 140, beam: 25 },
};

/**
 * Code-Default der Größenfaktoren (ships.size) — dieselben Zahlen wie der
 * Migrations-Seed; danach führt die DB (Admin-DB-Editor, greift mit
 * Dienst-Neustart). Basis 1 = fregatte01 (Überwasser) bzw. submarine01
 * (U-Boote). Modelle ohne Eintrag (Alt-NPCs mit eigenen Basis-Maßen)
 * fahren 1.
 */
export const DEFAULT_SHIP_SIZES: Partial<Record<VesselModel, number>> = {
  fregatte01: 1,
  fregatte02: 1.1,
  submarine01: 1,
  submarine02: 1.3,
  submarine03: 1.4,
  submarine04: 1.6,
  destroyer01: 1.3,
  destroyer02: 1.9,
  destroyer03: 1.5,
  carrier01: 4,
};

/**
 * Effektive Rumpfmaße eines Modells: Klassen-Basis × Größenfaktor. `size`
 * kommt aus dem Katalog (ships-Tabelle über api/Spielserver/welcome); ohne
 * ihn gilt der Code-Default. Server (Kollision, Abschuss-Offsets) und Client
 * (Billboards, Klickradius) MÜSSEN beide hierüber rechnen.
 */
export function scaledHull(
  model: VesselModel,
  size?: number,
): { length: number; beam: number } {
  const base = HULL_DIMENSIONS[model] ?? HULL_DIMENSIONS[DEFAULT_VESSEL_MODEL];
  const factor =
    typeof size === 'number' && size > 0 ? size : (DEFAULT_SHIP_SIZES[model] ?? 1);
  return { length: base.length * factor, beam: base.beam * factor };
}

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

/**
 * Rammschaden: solange sich zwei Rümpfe überlappen, verlieren BEIDE laufend
 * Substanz. Beide Werte sind Raten je Sekunde und werden mit dem Tick
 * skaliert — „10 % je Sekunde" gilt damit unabhängig von der Tickrate.
 */
export const COLLISION = {
  /** Rumpfschaden je Sekunde Überlappung, als Anteil der maximalen HP. */
  hullFractionPerSecond: 0.1,
  /**
   * Integritätsverlust der Panzerung je Sekunde Überlappung, in Punkten
   * (0..100). Er fällt IMMER an — unabhängig davon, wie viel die Panzerung
   * gerade vom Rumpfschaden schluckt.
   */
  armorCostPerSecond: 10,
} as const;

/** Rauchstufe (PlayerState.smoke) aus HP und Modellmaximum — beide Seiten dieselbe Formel. */
export function smokeLevelForHp(hp: number, maxHp: number): number {
  if (maxHp <= 0 || hp <= 0) return 0;
  if (hp < maxHp * DAMAGE.smokeBlackHpRatio) return 2;
  if (hp < maxHp * DAMAGE.smokeWhiteHpRatio) return 1;
  return 0;
}

/**
 * Bots kehren nach einer Versenkung zeitversetzt zurück — die Karte soll
 * nicht sofort wieder voll sein. (Spieler respawnen seit Protokoll 19 NICHT
 * mehr: Versenkung beendet die Runde, das Schiff liegt beschädigt in der
 * Werft.)
 */
export const BOT_RESPAWN_SECONDS = 10;
