import type { VesselProfile } from '../sim/VesselProfile.js';
import type { ItemId, PlayableModel } from './economy.js';
import { PERK_SLOTS_BY_MODEL } from './werft.js';

/**
 * Perks: verbaubare Verbesserungen je SCHIFFSINSTANZ.
 *
 * Die Perk-Items leben als ganz normale Items im Katalog (economy.ts,
 * category 'perk', nie käuflich — sie kommen als NPC-Drops). HIER stehen die
 * WERTE: was ein Perk am Fahrprofil, am Sonar oder an den Rohren ändert.
 * api (validieren, ins Ticket signieren), game-server (anwenden) und Client
 * (anzeigen, Regeln spiegeln) rechnen mit demselben Katalog.
 */

export type PerkType = 'engine' | 'propeller' | 'rudder' | 'sonar' | 'tube';

export interface PerkDefinition {
  id: PerkId;
  type: PerkType;
  /** Stufe innerhalb des Typs — nur Anzeige/Sortierung. */
  tier: number;
  /**
   * Wirkung je Typ:
   * engine    ×maxForward und ×maxReverse (Höchstfahrt)
   * propeller ×accel (Beschleunigung)
   * rudder    ×turnRadius (kleiner = engere Wende)
   * sonar     +sensorRange in Metern
   * tube      ÷reloadSeconds (Nachladetempo-Faktor)
   */
  value: number;
}

export const PERKS = [
  { id: 'engine01', type: 'engine', tier: 1, value: 1.2 },
  { id: 'engine02', type: 'engine', tier: 2, value: 1.5 },
  { id: 'engine03', type: 'engine', tier: 3, value: 1.85 },
  { id: 'engine04', type: 'engine', tier: 4, value: 1.95 },
  { id: 'propeller01', type: 'propeller', tier: 1, value: 1.1 },
  { id: 'propeller02', type: 'propeller', tier: 2, value: 1.3 },
  { id: 'propeller03', type: 'propeller', tier: 3, value: 1.45 },
  { id: 'rudder01', type: 'rudder', tier: 1, value: 0.9 },
  { id: 'rudder02', type: 'rudder', tier: 2, value: 0.8 },
  { id: 'rudder03', type: 'rudder', tier: 3, value: 0.7 },
  { id: 'sonar01', type: 'sonar', tier: 1, value: 500 },
  { id: 'sonar02', type: 'sonar', tier: 2, value: 1000 },
  { id: 'sonar03', type: 'sonar', tier: 3, value: 1500 },
  { id: 'tube01', type: 'tube', tier: 1, value: 1.3 },
  { id: 'tube02', type: 'tube', tier: 2, value: 1.6 },
  { id: 'tube03', type: 'tube', tier: 3, value: 1.85 },
] as const satisfies ReadonlyArray<{
  id: string;
  type: PerkType;
  tier: number;
  value: number;
}>;

export type PerkId = (typeof PERKS)[number]['id'];

// Compile-Guard: jede Perk-Id MUSS auch eine Item-Id sein — wer einen Perk in
// den einen Katalog einträgt und im anderen vergisst, scheitert hier am Bauen.
const _perkIdsSindItems: readonly ItemId[] = PERKS.map((perk) => perk.id);
void _perkIdsSindItems;

export function isPerkId(value: unknown): value is PerkId {
  return typeof value === 'string' && PERKS.some((perk) => perk.id === value);
}

export function perkById(id: PerkId): PerkDefinition {
  return PERKS.find((perk) => perk.id === id) as PerkDefinition;
}

/** Kurzbeschreibung der Wirkung — für Tooltips in Werft und Depot. */
export function perkEffectLabel(id: PerkId): string {
  const perk = perkById(id);
  switch (perk.type) {
    case 'engine':
      return `Höchstfahrt ×${perk.value}`;
    case 'propeller':
      return `Beschleunigung ×${perk.value}`;
    case 'rudder':
      return `Wenderadius ×${perk.value}`;
    case 'sonar':
      return `Sonar +${perk.value} m`;
    case 'tube':
      return `Rohrladen ×${perk.value}`;
  }
}

/**
 * Wendet eine Perk-Liste auf ein Fahrprofil an. Unbekannte Ids werden
 * ignoriert (Vorwärtskompatibilität alter Tickets); Reihenfolge ist egal —
 * die Wirkungen sind multiplikativ bzw. additiv und je Typ nur einmal erlaubt.
 * Der Tube-Perk wirkt NICHT hier — er hat kein Profilfeld, siehe
 * `tubeReloadFactor`.
 */
export function applyPerksToProfile(
  profile: VesselProfile,
  perkIds: readonly string[],
): VesselProfile {
  const result = { ...profile };
  for (const id of perkIds) {
    if (!isPerkId(id)) continue;
    const perk = perkById(id);
    switch (perk.type) {
      case 'engine':
        result.maxForward *= perk.value;
        result.maxReverse *= perk.value;
        break;
      case 'propeller':
        result.accel *= perk.value;
        break;
      case 'rudder':
        result.turnRadius *= perk.value;
        break;
      case 'sonar':
        result.sensorRange += perk.value;
        break;
      case 'tube':
        break;
    }
  }
  return result;
}

/** Nachlade-Faktor der Torpedorohre: effektive Zeit = reloadSeconds ÷ Faktor. */
export function tubeReloadFactor(perkIds: readonly string[]): number {
  for (const id of perkIds) {
    if (isPerkId(id) && perkById(id).type === 'tube') return perkById(id).value;
  }
  return 1;
}

/**
 * Prüft eine Perk-Auswahl für ein Schiff: nur gültige Ids, höchstens so viele
 * wie das Modell Slots hat, und je TYP höchstens ein Perk. api (durchsetzen)
 * und Client (Knöpfe zeigen) nutzen DIESELBE Funktion. Die Slot-Zahl kommt
 * seit Migration 18 aus der ships-Tabelle (perk_slots) — der Aufrufer reicht
 * sie durch, der Default deckt den Betrieb ohne Katalog.
 */
export function validatePerkSet(
  model: PlayableModel,
  perks: unknown,
  slots: number = PERK_SLOTS_BY_MODEL[model],
): perks is PerkId[] {
  if (!Array.isArray(perks)) return false;
  if (perks.length > slots) return false;
  const typen = new Set<PerkType>();
  for (const id of perks) {
    if (!isPerkId(id)) return false;
    const typ = perkById(id).type;
    if (typen.has(typ)) return false;
    typen.add(typ);
  }
  return true;
}
