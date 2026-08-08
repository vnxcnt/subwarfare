/** Eindeutige, vom Server vergebene Spieler-ID. */
export type PlayerId = string;

/**
 * Serialisierbarer Zustand eines Spielers, so wie er über das Netz geht.
 * Bewusst flach gehalten — der Server ist die einzige Quelle der Wahrheit.
 */
export interface PlayerState {
  id: PlayerId;
  name: string;
  /** Weltkoordinate in Map-Units. */
  x: number;
  /** Weltkoordinate in Map-Units. */
  y: number;
  /** Blickrichtung in Grad. 0 = Norden, im Uhrzeigersinn steigend. */
  rotation: number;
  /** Aktuelle Geschwindigkeit in Map-Units pro Sekunde. */
  speed: number;
}
