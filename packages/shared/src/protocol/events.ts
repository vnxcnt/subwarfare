import type { GameMap } from '../types/Map.js';
import type { PlayerId, PlayerState } from '../types/Player.js';
import type { Waypoint } from '../sim/VesselProfile.js';

/**
 * Wire-Protokoll v2 als typisierte socket.io-Event-Maps.
 *
 * Grundregel, die das Protokoll trägt: über das Netz gehen ausschließlich
 * **Absichten** — Zielkoordinaten und ein Stufen-Index. Niemals Geschwindigkeiten,
 * Positionen oder Kurse vom Client. Der Server ist die einzige Quelle der
 * Wahrheit und klemmt jeden Wert selbst.
 */

/** Begrüßung direkt nach erfolgreicher Anmeldung am Spielserver. */
export interface WelcomePayload {
  protocolVersion: number;
  /** Eigene Fahrzeug-ID, um sich im State-Broadcast wiederzufinden. */
  selfId: PlayerId;
  map: GameMap;
  tick: number;
}

/**
 * Weltzustand eines Ticks. Wird mit 20 Hz und `volatile` verschickt.
 *
 * `players` ist PRO EMPFÄNGER gefiltert: enthalten ist nur, was dessen Sonar
 * orten kann (eigenes Boot immer). Ein Fahrzeug außerhalb der Reichweite fehlt
 * nicht nur in der Anzeige, sondern bereits im Netzverkehr — sonst wäre der
 * Broadcast in einem U-Boot-Spiel ein Aufklärungs-Wallhack.
 */
export interface StatePayload {
  tick: number;
  players: PlayerState[];
}

/**
 * Zustand, den nur der Besitzer sehen darf.
 *
 * Der Wegpunkt geht bewusst NICHT in den State-Broadcast: er verrät die Absicht
 * des Gegners und wäre in einem U-Boot-Spiel der gröbste denkbare
 * Aufklärungs-Leak. Ereignisgetrieben und zuverlässig, nicht volatile.
 */
export interface OwnStatePayload {
  telegraphStep: number;
  waypoint: Waypoint | null;
  /** Zählt bei jedem neuen Befehl hoch — die Anzeige erkennt daran den Wechsel. */
  serial: number;
}

export interface PlayerLeftPayload {
  id: PlayerId;
}

export interface KickedPayload {
  code: 'duplicate_session' | 'server_full' | 'shutdown';
  message: string;
}

export interface WaypointOrder {
  x: number;
  y: number;
}

export interface TelegraphOrder {
  /** Index in TELEGRAPH_STANDARD. Der Server klemmt auf den gültigen Bereich. */
  step: number;
}

export interface ServerToClientEvents {
  welcome: (payload: WelcomePayload) => void;
  state: (payload: StatePayload) => void;
  own: (payload: OwnStatePayload) => void;
  'player:left': (payload: PlayerLeftPayload) => void;
  kicked: (payload: KickedPayload) => void;
}

export interface ClientToServerEvents {
  'order:waypoint': (payload: WaypointOrder) => void;
  'order:telegraph': (payload: TelegraphOrder) => void;
}

/** Pro Verbindung am Socket hinterlegt, nachdem das Ticket geprüft wurde. */
export interface GameSocketData {
  accountId: string;
  name: string;
}

/** Inhalt eines Join-Tickets. Vom Backend signiert, vom Spielserver geprüft. */
export interface TicketClaims {
  /** Account-ID. */
  sub: string;
  name: string;
  mapId: string;
  /** Einmalkennung — der Spielserver merkt sich verbrauchte Tickets. */
  jti: string;
}
