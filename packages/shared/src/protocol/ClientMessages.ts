import type { MapId } from '../types/Map.js';

/** Alle Nachrichtentypen, die der Client an den Server schickt. */
export const ClientMessageType = {
  Join: 'join',
  Input: 'input',
  Leave: 'leave',
  Ping: 'ping',
} as const;

export type ClientMessageType = (typeof ClientMessageType)[keyof typeof ClientMessageType];

/** Betritt den Server über einen Spawnpunkt der gewählten Map. */
export interface JoinMessage {
  type: typeof ClientMessageType.Join;
  name: string;
  /** Optional; ohne Angabe wählt der Server die Standard-Map. */
  mapId?: MapId;
}

/**
 * Reine Eingabe-*Absicht*. Der Server rechnet daraus die Bewegung —
 * niemals der Client (Anti-Cheat).
 */
export interface InputMessage {
  type: typeof ClientMessageType.Input;
  /** -1 = rückwärts, 0 = neutral, 1 = volle Fahrt voraus. */
  throttle: number;
  /** -1 = Ruder backbord, 0 = geradeaus, 1 = Ruder steuerbord. */
  rudder: number;
}

/** Verlässt den Server, z. B. über eine Exit-Zone. */
export interface LeaveMessage {
  type: typeof ClientMessageType.Leave;
}

/** Latenzmessung; der Server spiegelt `sentAt` in einem Pong zurück. */
export interface PingMessage {
  type: typeof ClientMessageType.Ping;
  sentAt: number;
}

export type ClientMessage = JoinMessage | InputMessage | LeaveMessage | PingMessage;
