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
  | 'panzerung'
  | 'perk';

/**
 * Obergrenze je Kauf-Anfrage. Schützt vor Tippfehlern und Überlauf-Spielen —
 * wer mehr will, kauft zweimal. Client (Eingabe-Klemme) und api (Validierung)
 * nutzen DENSELBEN Wert.
 */
export const SHOP_BUY_MAX = 999;

/**
 * Kategorien, die es im Shop als Mengenkauf gibt: Verbrauchsgüter. Panzerung
 * bleibt Stückkauf — sie wird pro Einsatz als EIN Stück getragen und der
 * Stepper wäre dort nur eine Falle für Fehlkäufe.
 */
export const BULK_CATEGORIES: readonly ItemCategory[] = [
  'torpedo',
  'wasserbombe',
  'taeuschkoerper',
  'munition',
];

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
  // Perks: ausschließlich erspielbar (NPC-Drops, Loottable folgt) — nie im
  // Shop. Die WERTE stehen im Perk-Katalog (meta/perks.ts), verknüpft über
  // die Id; hier lebt nur, was jedes Item braucht: Name und Besitz-Fähigkeit.
  { id: 'engine01', name: 'Maschine I', category: 'perk', shopPrice: null },
  { id: 'engine02', name: 'Maschine II', category: 'perk', shopPrice: null },
  { id: 'engine03', name: 'Maschine III', category: 'perk', shopPrice: null },
  { id: 'engine04', name: 'Maschine IV', category: 'perk', shopPrice: null },
  { id: 'propeller01', name: 'Schraube I', category: 'perk', shopPrice: null },
  { id: 'propeller02', name: 'Schraube II', category: 'perk', shopPrice: null },
  { id: 'propeller03', name: 'Schraube III', category: 'perk', shopPrice: null },
  { id: 'rudder01', name: 'Ruderanlage I', category: 'perk', shopPrice: null },
  { id: 'rudder02', name: 'Ruderanlage II', category: 'perk', shopPrice: null },
  { id: 'rudder03', name: 'Ruderanlage III', category: 'perk', shopPrice: null },
  { id: 'sonar01', name: 'Sonar I', category: 'perk', shopPrice: null },
  { id: 'sonar02', name: 'Sonar II', category: 'perk', shopPrice: null },
  { id: 'sonar03', name: 'Sonar III', category: 'perk', shopPrice: null },
  { id: 'tube01', name: 'Rohrlademechanik I', category: 'perk', shopPrice: null },
  { id: 'tube02', name: 'Rohrlademechanik II', category: 'perk', shopPrice: null },
  { id: 'tube03', name: 'Rohrlademechanik III', category: 'perk', shopPrice: null },
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
  perk: 'Perk',
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
 * Kaufpreise der spielbaren Schiffe in Coins. 0 = kostenlos (Starter-Schiffe;
 * neue Konten bekommen fregatte01 und submarine01 automatisch in die Werft).
 * Es gibt KEINE Level-Freischaltung und KEINE Einsatzkosten mehr — die
 * Schiffs-Ökonomie sind Kauf und Reparatur (meta/werft.ts). NPC-Modelle
 * stehen bewusst nicht in dieser Liste — was hier fehlt, kann kein Spieler
 * kaufen oder anfordern.
 */
export const SHIP_PRICES = {
  fregatte01: 0,
  fregatte02: 2750,
  submarine01: 0,
  submarine02: 5650,
  destroyer01: 12550,
  destroyer02: 37500,
} as const satisfies Partial<Record<VesselModel, number>>;

export type PlayableModel = keyof typeof SHIP_PRICES;

/** Feste Anzeige-Reihenfolge der Werft (Klassen beisammen, aufsteigend). */
export const PLAYABLE_MODELS: readonly PlayableModel[] = [
  'fregatte01',
  'fregatte02',
  'submarine01',
  'submarine02',
  'destroyer01',
  'destroyer02',
];

export function isPlayableModel(value: unknown): value is PlayableModel {
  return typeof value === 'string' && Object.hasOwn(SHIP_PRICES, value);
}
