/**
 * Panzerung: Schadensabwehr mit eigener Haltbarkeit.
 *
 * Zwei Größen, die man nicht verwechseln darf:
 *
 * - **Absorption** (`absorb`, 0..1): welcher ANTEIL eines Treffers gar nicht
 *   erst am Rumpf ankommt. Hängt allein an der Stufe des getragenen Items.
 * - **Integrität** (0..100 %): wie viel Panzerung noch da ist. Jeder Treffer
 *   knabbert daran, je nach Waffe unterschiedlich stark. Bei 0 schützt sie
 *   nicht mehr, und der Rumpf nimmt den vollen Schaden.
 *
 * Die Absorption ist damit eine Eigenschaft der AUSRÜSTUNG, die Integrität eine
 * des laufenden Einsatzes. Die Werte hier sind der Rückfall; die Wahrheit steht
 * in der Tabelle `armor` und kommt über den internen Kanal zum Spielserver —
 * dasselbe Muster wie beim Schiffskatalog.
 */

/**
 * Panzerungszustand eines laufenden Einsatzes — für die eigene Anzeige.
 *
 * Geht wie die Lebenspunkte NUR an den Besitzer: wie gut ein Gegner gepanzert
 * ist und wie viel davon noch steht, ist Aufklärung.
 */
export interface ArmorState {
  /** Item-Kennung, z. B. `panzerung_mk3` — der Client leitet die Beschriftung ab. */
  itemId: string;
  level: number;
  /** Restintegrität in Prozent, 0..100. */
  percent: number;
  /** Absorptionsanteil 0..1 — solange etwas übrig ist. */
  absorb: number;
}

/** Basiswerte einer Panzerungsstufe. */
export interface ArmorStats {
  /** Item-Kennung aus dem Katalog, z. B. `panzerung_mk1`. */
  itemId: string;
  /** Stufe. MK I = 1, MK II = 2 … Steuert die Absorption. */
  level: number;
  /** Anteil des Schadens, den die Panzerung schluckt (0..1). */
  absorb: number;
}

/** Absorption der Stufe 1. */
export const ARMOR_BASE_ABSORB = 0.25;
/** Zuwachs je weiterer Stufe. */
export const ARMOR_ABSORB_PER_LEVEL = 0.1;

/**
 * Absorption aus der Stufe. MK I = 25 %, MK II = 35 %, … MK V = 65 %.
 *
 * Gedeckelt bei 90 %: eine Panzerung, die ALLES schluckt, macht ein Schiff
 * unzerstörbar, sobald die Integrität schneller nachwächst als sie fällt —
 * und den Deckel will man an der Formel haben, nicht in jeder Aufrufstelle.
 */
export function absorbForLevel(level: number): number {
  const roh = ARMOR_BASE_ABSORB + (level - 1) * ARMOR_ABSORB_PER_LEVEL;
  return Math.min(Math.max(roh, 0), 0.9);
}

/**
 * Rückfall-Katalog. Deckt sich zeichengenau mit dem Migrations-Seed — wer hier
 * etwas ändert, muss die Migration nachziehen, sonst driften Betrieb mit und
 * ohne Datenbank auseinander.
 */
export const DEFAULT_ARMOR_STATS: Record<string, ArmorStats> = {
  panzerung_mk1: { itemId: 'panzerung_mk1', level: 1, absorb: absorbForLevel(1) },
  panzerung_mk2: { itemId: 'panzerung_mk2', level: 2, absorb: absorbForLevel(2) },
  panzerung_mk3: { itemId: 'panzerung_mk3', level: 3, absorb: absorbForLevel(3) },
  panzerung_mk4: { itemId: 'panzerung_mk4', level: 4, absorb: absorbForLevel(4) },
  panzerung_mk5: { itemId: 'panzerung_mk5', level: 5, absorb: absorbForLevel(5) },
};

/**
 * Integritätsverlust je Treffer in PROZENTPUNKTEN.
 *
 * Bewusst nach Waffenart und nicht nach Schadenshöhe: eine Wasserbombe soll
 * die Panzerung eines getauchten Boots aufreißen, auch wenn sie am Rand der
 * Druckwelle wenig Schaden macht.
 */
export const ARMOR_HIT_COST = {
  geschuetz: 5,
  torpedo: 15,
  /** Nur gegen GETAUCHTE Boote — an der Oberfläche richtet sie nichts aus. */
  wasserbombe: 25,
} as const;

export type ArmorHitKind = keyof typeof ARMOR_HIT_COST;

/**
 * Was ein Treffer der Panzerung kostet.
 *
 * Die Wasserbombe zählt nur gegen getauchte Boote — sie ist eine
 * Unterwasserwaffe, und ein Überwasserschiff steckt sie ohne Panzerungsverlust
 * weg. Alles andere wirkt unabhängig von der Tiefe.
 */
export function armorHitCost(kind: ArmorHitKind, targetSubmerged: boolean): number {
  if (kind === 'wasserbombe') return targetSubmerged ? ARMOR_HIT_COST.wasserbombe : 0;
  return ARMOR_HIT_COST[kind];
}

/**
 * Schaden aufteilen: was die Panzerung schluckt und was am Rumpf ankommt.
 *
 * ⚠️ Die Absorption hängt NICHT an der Restintegrität. Eine Panzerung mit 5 %
 * Rest schützt genauso gut wie eine volle — sie hält nur nicht mehr lange
 * durch. Das ist Absicht: eine mitskalierende Absorption fühlt sich an, als
 * würde der Schaden schleichend steigen, ohne dass man den Grund sieht.
 */
export function splitDamage(
  damage: number,
  absorb: number,
  integrityPercent: number,
): { toHull: number; absorbed: number } {
  if (integrityPercent <= 0 || absorb <= 0) return { toHull: damage, absorbed: 0 };
  const absorbed = damage * absorb;
  return { toHull: damage - absorbed, absorbed };
}
