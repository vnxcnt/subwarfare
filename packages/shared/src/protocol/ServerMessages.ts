import type { GameMap } from '../types/Map.js';
import type { PlayerId, PlayerState } from '../types/Player.js';

/** Alle Nachrichtentypen, die der Server an den Client schickt. */
export const ServerMessageType = {
  Welcome: 'welcome',
  Joined: 'joined',
  State: 'state',
  PlayerLeft: 'player_left',
  Pong: 'pong',
  Error: 'error',
} as const;

export type ServerMessageType = (typeof ServerMessageType)[keyof typeof ServerMessageType];

/** Erste Nachricht nach dem Verbindungsaufbau, noch vor einem Join. */
export interface WelcomeMessage {
  type: typeof ServerMessageType.Welcome;
  connectionId: string;
  protocolVersion: number;
  /** Statische Map-Definition, damit der Client die Welt aufbauen kann. */
  map: GameMap;
}

/** Bestätigt einen Join und nennt den zugewiesenen Spawnpunkt. */
export interface JoinedMessage {
  type: typeof ServerMessageType.Joined;
  player: PlayerState;
  spawnPointId: string;
}

/** Regelmäßiger Weltzustand eines Ticks. */
export interface StateMessage {
  type: typeof ServerMessageType.State;
  tick: number;
  players: PlayerState[];
}

export interface PlayerLeftMessage {
  type: typeof ServerMessageType.PlayerLeft;
  playerId: PlayerId;
}

export interface PongMessage {
  type: typeof ServerMessageType.Pong;
  /** Unverändert aus dem Ping übernommen. */
  sentAt: number;
  serverTime: number;
}

export interface ErrorMessage {
  type: typeof ServerMessageType.Error;
  code: string;
  message: string;
}

export type ServerMessage =
  | WelcomeMessage
  | JoinedMessage
  | StateMessage
  | PlayerLeftMessage
  | PongMessage
  | ErrorMessage;
