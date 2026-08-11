/** Eindeutige, vom Server vergebene Spieler-ID. */
export type PlayerId = string;

/**
 * Bekannte Schiffsmodelle (Client-Atlanten unter `assets/vessels/<id>/`).
 * Der Server validiert Modellwechsel gegen diese Liste — was hier nicht
 * steht, fährt nicht.
 */
export const VESSEL_MODELS = [
  'fregatte01',
  'yachtgun01',
  'submarine01',
  'speedster01',
  'tanker01',
  'fregatte02',
  'submarine02',
  'destroyer01',
  'destroyer02',
] as const;
export type VesselModel = (typeof VESSEL_MODELS)[number];

export const DEFAULT_VESSEL_MODEL: VesselModel = 'fregatte01';

export function isVesselModel(value: unknown): value is VesselModel {
  return typeof value === 'string' && (VESSEL_MODELS as readonly string[]).includes(value);
}

/**
 * Serialisierbarer Zustand eines Spielers, so wie er über das Netz geht.
 * Bewusst flach gehalten — der Server ist die einzige Quelle der Wahrheit.
 */
export interface PlayerState {
  id: PlayerId;
  name: string;
  /** Schiffsmodell — bestimmt client-seitig den Richtungs-Atlas. */
  model: VesselModel;
  /** Weltkoordinate in Map-Units. */
  x: number;
  /** Weltkoordinate in Map-Units. */
  y: number;
  /** Blickrichtung in Grad. 0 = Norden, im Uhrzeigersinn steigend. */
  rotation: number;
  /** Aktuelle Geschwindigkeit in Map-Units pro Sekunde. */
  speed: number;
  /**
   * Tauchtiefe 0..1 — 0 aufgetaucht, 1 getaucht, dazwischen im Übergang.
   * Nur Schiffe vom Typ Submarine können > 0 erreichen; der Server erzwingt das.
   */
  depth: number;
  /** Periskop-Ausfahrstand 0..1 — nur bei U-Booten je > 0. */
  periscope: number;
  /**
   * Rauchstufe 0/1/2 (keiner/weiß/schwarz) — die einzige HP-Information über
   * FREMDE Schiffe im Broadcast: bewusst grob quantisiert, sichtbarer Schaden
   * ist gewollte Aufklärung, der exakte Zustand nicht.
   */
  smoke: number;
}
