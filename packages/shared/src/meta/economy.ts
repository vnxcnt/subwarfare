import type { WeaponId } from './ships.js';
import type { VesselModel } from '../types/Player.js';

/**
 * Ökonomie: Item-Katalog, Ausrüstungs-Slots und Schiffszugang.
 *
 * Liegt in `shared`, weil drei Seiten dieselben Zahlen brauchen: die api prüft
 * Käufe und Einsatzkosten (sie ist die Quelle der Wahrheit), der Client zeigt
 * Shop und Werft an, der Spielserver wird die equippten Items später in
 * Kampfwerte übersetzen. Die DATENBANK speichert nur BESITZ und ZUORDNUNG —
 * der Katalog selbst (Namen, Preise, Kategorien) lebt hier im Code, wie die
 * Waffenwerte in `combat.ts`.
 */

/**
 * Item-Kategorie = Slot-Typ der Ausrüstung. Ein Slot nimmt genau Items seiner
 * Kategorie an. ASCII-bewusst — die Kennungen landen in DB-Spalten und
 * Netz-Payloads.
 */
export type ItemCategory =
  | 'torpedo'
  | 'wasserbombe'
  | 'taeuschkoerper'
  | 'munition'
  | 'panzerung';

export interface ItemDefinition {
  id: ItemId;
  /** Anzeigename. Umlaute sind hier erlaubt — nur die `id` muss ASCII sein. */
  name: string;
  category: ItemCategory;
  /**
   * Preis im Shop in Coins. `null` bedeutet: nicht käuflich — solche Items
   * sind nur erspielbar (Belohnungen, Ereignisse) und tauchen im Shop nicht auf.
   */
  shopPrice: number | null;
}

/**
 * Der komplette Item-Katalog. Reihenfolge = Anzeige-Reihenfolge in Inventar
 * und Shop (innerhalb einer Kategorie aufsteigend nach Stärke).
 *
 * Noch OHNE Spielwirkung: Kauf, Besitz und Zuordnung stehen zuerst; welche
 * Werte ein „Torpedo MK II" gegenüber MK I verändert, kommt als eigener
 * Schritt, sobald das Balancing dafür steht.
 */
export const ITEMS = [
  { id: 'torpedo_mk1', name: 'Torpedo MK I', category: 'torpedo', shopPrice: 5 },
  { id: 'torpedo_mk2', name: 'Torpedo MK II', category: 'torpedo', shopPrice: 10 },
  { id: 'torpedo_mk3', name: 'Torpedo MK III', category: 'torpedo', shopPrice: 20 },
  { id: 'torpedo_mk4', name: 'Torpedo MK IV', category: 'torpedo', shopPrice: null },
  { id: 'torpedo_mk5', name: 'Torpedo MK V Prototype', category: 'torpedo', shopPrice: null },
  { id: 'wasserbombe', name: 'Wasserbombe', category: 'wasserbombe', shopPrice: 10 },
  { id: 'taeuschkoerper', name: 'Täuschkörper', category: 'taeuschkoerper', shopPrice: 15 },
  { id: 'panzerung_mk1', name: 'Panzerung MK I', category: 'panzerung', shopPrice: 25 },
  { id: 'panzerung_mk2', name: 'Panzerung MK II', category: 'panzerung', shopPrice: 50 },
  { id: 'panzerung_mk3', name: 'Panzerung MK III', category: 'panzerung', shopPrice: 125 },
  { id: 'panzerung_mk4', name: 'Panzerung MK IV', category: 'panzerung', shopPrice: null },
  { id: 'panzerung_mk5', name: 'Panzerung MK V Prototype', category: 'panzerung', shopPrice: null },
  { id: 'munition_mk1', name: '125mm Munition MK I', category: 'munition', shopPrice: 2 },
  { id: 'munition_mk2', name: '125mm Munition MK II', category: 'munition', shopPrice: 6 },
  { id: 'munition_mk3', name: '125mm Munition MK III', category: 'munition', shopPrice: null },
] as const satisfies ReadonlyArray<{
  id: string;
  name: string;
  category: ItemCategory;
  shopPrice: number | null;
}>;

export type ItemId = (typeof ITEMS)[number]['id'];

export function isItemId(value: unknown): value is ItemId {
  return typeof value === 'string' && ITEMS.some((item) => item.id === value);
}

export function itemById(id: ItemId): ItemDefinition {
  // Der Katalog ist klein und konstant — lineares Suchen ist hier billiger als
  // eine zweite, synchron zu haltende Map.
  return ITEMS.find((item) => item.id === id) as ItemDefinition;
}

/** Anzeigenamen der Kategorien für Slots, Inventar-Gruppen und Shop. */
export const CATEGORY_LABELS: Record<ItemCategory, string> = {
  torpedo: 'Torpedo',
  wasserbombe: 'Wasserbombe',
  taeuschkoerper: 'Täuschkörper',
  munition: '125mm Munition',
  panzerung: 'Panzerung',
};

/**
 * Ausrüstungs-Slots eines Schiffs aus seiner Bewaffnung: je ein Slot für
 * Torpedo, Täuschkörper und Geschützmunition, sofern die Waffe an Bord ist —
 * Panzerung passt auf jeden Rumpf. Die Reihenfolge ist die Anzeige-Reihenfolge.
 */
export function equipSlotsForArmament(armament: readonly WeaponId[]): ItemCategory[] {
  const slots: ItemCategory[] = [];
  if (armament.includes('torpedo')) slots.push('torpedo');
  if (armament.includes('wasserbombe')) slots.push('wasserbombe');
  if (armament.includes('taeuschkoerper')) slots.push('taeuschkoerper');
  if (armament.includes('geschuetz')) slots.push('munition');
  slots.push('panzerung');
  return slots;
}

/**
 * Spielbare Schiffe mit Zugangsregeln: Freischaltung ab Level, Kosten in Coins
 * JE EINSATZ (abgezogen bei der Ticketausgabe, nicht beim Respawn innerhalb
 * einer Partie). NPC-Modelle stehen bewusst nicht in dieser Liste — was hier
 * fehlt, kann kein Spieler anfordern.
 */
export interface ShipAccess {
  /** Ab diesem Level wählbar (1 = von Anfang an). */
  minLevel: number;
  /** Coins je Einsatz. 0 = kostenlos. */
  sortieCost: number;
}

export const SHIP_ACCESS = {
  fregatte01: { minLevel: 1, sortieCost: 0 },
  fregatte02: { minLevel: 3, sortieCost: 25 },
  submarine01: { minLevel: 5, sortieCost: 40 },
  submarine02: { minLevel: 7, sortieCost: 60 },
  destroyer01: { minLevel: 10, sortieCost: 125 },
  destroyer02: { minLevel: 15, sortieCost: 375 },
} as const satisfies Partial<Record<VesselModel, ShipAccess>>;

export type PlayableModel = keyof typeof SHIP_ACCESS;

/** Anzeige-Reihenfolge der Werft: nach Freischalt-Level aufsteigend. */
export const PLAYABLE_MODELS = (Object.keys(SHIP_ACCESS) as PlayableModel[]).sort(
  (a, b) => SHIP_ACCESS[a].minLevel - SHIP_ACCESS[b].minLevel,
);

export function isPlayableModel(value: unknown): value is PlayableModel {
  return typeof value === 'string' && Object.hasOwn(SHIP_ACCESS, value);
}

/** Perk-Slots je Konto. Perk-Items gibt es noch nicht — die Slots stehen schon. */
export const PERK_SLOTS = 3;
