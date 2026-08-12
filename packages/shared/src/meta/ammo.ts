import type { ItemCategory, ItemId } from './economy.js';
import type { WeaponId } from './ships.js';

/**
 * Munition: welches Item welche Waffe speist und wie hart sie zuschlägt.
 *
 * Die Werft entscheidet ab jetzt über die Bewaffnung eines Einsatzes. Was im
 * Slot liegt, kommt an Bord — und zwar in der STÜCKZAHL, die im Inventar
 * steht. Ein leerer Slot heißt: die Waffe fehlt, sie taucht im Gefecht gar
 * nicht auf.
 *
 * Der Schaden hängt an der Stufe und steht in der Tabelle `weapon_items`; die
 * Werte hier sind der Rückfall für den Betrieb ohne Datenbank. Dasselbe Muster
 * wie bei Schiffen und Panzerung: der KATALOG (Namen, Preise, Kategorien) lebt
 * im Code, die ZAHLEN führt die Datenbank.
 */

/** Kampfwerte einer Munitionssorte. */
export interface AmmoStats {
  itemId: ItemId;
  /** Welche Waffe damit schießt. */
  weapon: WeaponId;
  /** Schaden eines Treffers. Beim Täuschkörper 0 — er trifft nichts. */
  damage: number;
}

/**
 * Ausrüstungs-Slot → Waffe. Die Kategorie `panzerung` hat keine Waffe und
 * fehlt deshalb; `munition` speist das Geschütz (der Slot heißt nach dem
 * Kaliber, nicht nach der Waffe).
 */
export const WEAPON_FOR_CATEGORY: Partial<Record<ItemCategory, WeaponId>> = {
  torpedo: 'torpedo',
  wasserbombe: 'wasserbombe',
  taeuschkoerper: 'taeuschkoerper',
  munition: 'geschuetz',
};

/** Alle Slots, die Munition tragen — Reihenfolge wie in der Werft. */
export const AMMO_CATEGORIES: ItemCategory[] = [
  'torpedo',
  'wasserbombe',
  'taeuschkoerper',
  'munition',
];

/**
 * Rückfall-Werte. Die Grundstufe trägt exakt den bisherigen Schaden aus
 * `combat.ts` — wer MK I fährt, merkt von der Umstellung nichts. Darüber rund
 * +15 % je Stufe, auf durch fünf teilbare Zahlen gerundet, damit die Leiter im
 * Kopf nachvollziehbar bleibt.
 *
 * Deckt sich zeichengenau mit dem Migrations-Seed; wer hier etwas ändert, muss
 * die Migration nachziehen, sonst driften Betrieb mit und ohne Datenbank.
 */
export const DEFAULT_AMMO_STATS: Record<string, AmmoStats> = {
  torpedo_mk1: { itemId: 'torpedo_mk1', weapon: 'torpedo', damage: 150 },
  torpedo_mk2: { itemId: 'torpedo_mk2', weapon: 'torpedo', damage: 175 },
  torpedo_mk3: { itemId: 'torpedo_mk3', weapon: 'torpedo', damage: 205 },
  torpedo_mk4: { itemId: 'torpedo_mk4', weapon: 'torpedo', damage: 235 },
  torpedo_mk5: { itemId: 'torpedo_mk5', weapon: 'torpedo', damage: 270 },
  wasserbombe: { itemId: 'wasserbombe', weapon: 'wasserbombe', damage: 140 },
  // Der Täuschkörper richtet keinen Schaden an — er fängt Torpedos ab. Er steht
  // hier trotzdem, damit „im Slot, also an Bord" für alle Waffen gleich läuft.
  taeuschkoerper: { itemId: 'taeuschkoerper', weapon: 'taeuschkoerper', damage: 0 },
  munition_mk1: { itemId: 'munition_mk1', weapon: 'geschuetz', damage: 40 },
  munition_mk2: { itemId: 'munition_mk2', weapon: 'geschuetz', damage: 46 },
  munition_mk3: { itemId: 'munition_mk3', weapon: 'geschuetz', damage: 53 },
};

/**
 * Ein Posten der Einsatzausrüstung: welches Item in welcher Stückzahl an Bord
 * geht. Reist im Join-Ticket mit, weil der Spielserver keine Datenbank hat.
 */
export interface LoadoutEntryStack {
  weapon: WeaponId;
  itemId: string;
  /** Stückzahl, die aus dem Inventar mitgenommen wurde. Immer > 0. */
  count: number;
}
