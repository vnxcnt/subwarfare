import type { VesselProfile } from '../sim/VesselProfile.js';
import type { VesselModel } from '../types/Player.js';

/**
 * Basiswerte der Schiffe.
 *
 * Quelle der Wahrheit ist die Tabelle `ships` in der Datenbank (gepflegt per
 * Hand/phpMyAdmin). Der Weg zur Laufzeit: api liest die DB → Spielserver holt
 * den Katalog beim Start über den internen Kanal → Client bekommt ihn in der
 * `welcome`. Die DEFAULTS hier sind das Sicherheitsnetz für den Betrieb ohne
 * Datenbank (lokale Entwicklung, api nicht erreichbar) — dieselben Zahlen wie
 * der Seed der Migration.
 */

/** Schiffstyp. Zahlenwerte sind Vorgabe des Designs. */
export const SHIP_TYPE_NPC = 1;
export const SHIP_TYPE_SUBMARINE = 2;
export const SHIP_TYPE_VESSEL = 3;
export type ShipType = typeof SHIP_TYPE_NPC | typeof SHIP_TYPE_SUBMARINE | typeof SHIP_TYPE_VESSEL;

/**
 * Waffen-Kennungen — ASCII-bewusst (keine Umlaute), sie landen in JSON-Spalten
 * und Netz-Payloads.
 */
export type WeaponId = 'torpedo' | 'wasserbombe' | 'taeuschkoerper' | 'geschuetz';

export interface ShipStats {
  model: VesselModel;
  /** Lebenspunkte. Noch ohne Spielwirkung — Kampf kommt später. */
  hp: number;
  type: ShipType;
  /** Bewaffnung als Liste von Waffen-Kennungen (DB: JSON-Spalte). */
  armament: WeaponId[];
  /**
   * Fahrt-Faktor relativ zum Basiswert 1 (= heutige Fregatte, 30 m/s
   * Höchstfahrt). 0,7 fährt entsprechend langsamer, 1,3 schneller. Skaliert
   * Höchst- UND Rückwärtsfahrt — die Telegrafenstufen bleiben dadurch Anteile
   * der EIGENEN Höchstfahrt.
   */
  speedFactor: number;
  /**
   * Kaufpreis in Coins (ships.price). OPTIONAL, weil die Code-Defaults hier
   * die Werte nicht doppeln dürfen — sie leben in SHIP_PRICES (economy.ts),
   * und ein Import von dort wäre zirkulär. Die api füllt das Feld beim Laden
   * (DB-Spalte bzw. SHIP_PRICES im Memory-Betrieb); NPC-Modelle: 0.
   */
  price?: number;
  /** Perk-Slots je Instanz (ships.perk_slots) — gleiche Regel wie price;
   *  Code-Default ist PERK_SLOTS_BY_MODEL (werft.ts). NPC-Modelle: 0. */
  perkSlots?: number;
  /**
   * Größenfaktor (ships.size) relativ zur Klassen-Basis (fregatte01 bzw.
   * submarine01 = 1). Skaliert Kollision UND Darstellung — siehe scaledHull
   * (combat.ts). Code-Default: DEFAULT_SHIP_SIZES; NPC-Modelle: 1.
   */
  size?: number;
}

export const DEFAULT_SHIP_STATS: Record<VesselModel, ShipStats> = {
  /**
   * Fregatten sind Geleitschiffe: Geschütz und Wasserbomben. Torpedos und
   * Täuschkörper bleiben den ZERSTÖRERN vorbehalten — die Fregatte jagt
   * U-Boote, sie duelliert sich nicht mit ihnen.
   */
  fregatte01: {
    model: 'fregatte01',
    hp: 500,
    type: SHIP_TYPE_VESSEL,
    armament: ['wasserbombe', 'geschuetz'],
    speedFactor: 1,
  },
  submarine01: {
    model: 'submarine01',
    hp: 350,
    type: SHIP_TYPE_SUBMARINE,
    armament: ['torpedo', 'taeuschkoerper'],
    speedFactor: 0.7,
  },
  speedster01: {
    model: 'speedster01',
    hp: 150,
    type: SHIP_TYPE_NPC,
    armament: ['geschuetz'],
    speedFactor: 1.3,
  },
  yachtgun01: {
    model: 'yachtgun01',
    hp: 200,
    type: SHIP_TYPE_NPC,
    armament: ['geschuetz'],
    speedFactor: 1.3,
  },
  /** Unbewaffneter Frachtverkehr — groß, zäh, langsam. */
  tanker01: {
    model: 'tanker01',
    hp: 800,
    type: SHIP_TYPE_NPC,
    armament: [],
    speedFactor: 0.5,
  },
  fregatte02: {
    model: 'fregatte02',
    hp: 550,
    type: SHIP_TYPE_VESSEL,
    armament: ['wasserbombe', 'geschuetz'],
    speedFactor: 0.95,
  },
  submarine02: {
    model: 'submarine02',
    hp: 450,
    type: SHIP_TYPE_SUBMARINE,
    armament: ['torpedo', 'taeuschkoerper'],
    speedFactor: 0.65,
  },
  destroyer01: {
    model: 'destroyer01',
    hp: 650,
    type: SHIP_TYPE_VESSEL,
    armament: ['torpedo', 'wasserbombe', 'taeuschkoerper', 'geschuetz'],
    speedFactor: 1.1,
  },
  destroyer02: {
    model: 'destroyer02',
    hp: 750,
    type: SHIP_TYPE_VESSEL,
    armament: ['torpedo', 'wasserbombe', 'taeuschkoerper', 'geschuetz'],
    speedFactor: 1.15,
  },
  /**
   * Zwischenstufe der Zerstörer (trägt die Grafik, die bis Protokoll 19
   * fälschlich als fregatte02 fuhr — fregatte02 hat seither ihren echten
   * Atlas).
   */
  destroyer03: {
    model: 'destroyer03',
    hp: 700,
    type: SHIP_TYPE_VESSEL,
    armament: ['torpedo', 'wasserbombe', 'taeuschkoerper', 'geschuetz'],
    speedFactor: 1.12,
  },
  /** Endgame-Boot: großes Atom-U-Boot — zäh und teuer, dafür träge. */
  submarine03: {
    model: 'submarine03',
    hp: 600,
    type: SHIP_TYPE_SUBMARINE,
    armament: ['torpedo', 'taeuschkoerper'],
    speedFactor: 0.6,
  },
  /** Flinker Jäger: klassisches WK2-Boot — schnellstes U-Boot, dünnhäutig. */
  submarine04: {
    model: 'submarine04',
    hp: 380,
    type: SHIP_TYPE_SUBMARINE,
    armament: ['torpedo', 'taeuschkoerper'],
    speedFactor: 0.75,
  },
};

/**
 * Fahrprofil eines Schiffs aus Basisprofil und Fahrt-Faktor.
 *
 * Bewusst NUR die Fahrtwerte skaliert: Beschleunigung, Bremsen und Wendekreis
 * bleiben vorerst Klassen-gleich — sie werden eigene Basiswerte, sobald das
 * Design sie braucht, und gehören dann in die Tabelle statt in eine Formel.
 */
export function profileForShip(base: VesselProfile, stats: ShipStats): VesselProfile {
  return {
    ...base,
    maxForward: base.maxForward * stats.speedFactor,
    maxReverse: base.maxReverse * stats.speedFactor,
  };
}
