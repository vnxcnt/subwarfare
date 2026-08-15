/**
 * Social: Chat-Kanäle, Freundschaften, Spieler-Profile.
 *
 * Der Funk unten rechts im Hauptmenü ist der Treffpunkt für ALLE
 * Kommunikation: der flüchtige Hafen-Kanal, der gespeicherte Flottillen-Kanal
 * und private Gespräche unter Freunden. Die Regeln stehen hier, damit api
 * (durchsetzen) und Client (anbieten/verstecken) dieselben Begriffe sprechen.
 */

/**
 * Die drei Kanäle. `hafen` bleibt flüchtig (mitlesen ab Eintritt, keine
 * Geschichte), `flottille` und `privat` werden gespeichert und beim Öffnen
 * nachgeladen.
 */
export type ChatChannel = 'hafen' | 'flottille' | 'privat';

export function isChatChannel(value: unknown): value is ChatChannel {
  return value === 'hafen' || value === 'flottille' || value === 'privat';
}

/** Wie viele gespeicherte Zeilen ein Kanal beim Öffnen nachlädt. */
export const CHAT_HISTORY_LIMIT = 50;

/**
 * Freundschaftsstand aus Sicht des Abfragenden — steuert die Knöpfe auf der
 * Profilkarte. Privatnachrichten gibt es NUR bei `friends`.
 */
export type FriendshipState = 'none' | 'friends' | 'incoming' | 'outgoing' | 'self';

export interface FriendEntry {
  accountId: string;
  displayName: string;
  avatarUrl: string | null;
  level: number;
  /** Gerade im Hafen (Lobby-Socket verbunden)? Momentaufnahme der Abfrage. */
  online: boolean;
}

/** Antwort von `GET /api/social/friends`. */
export interface FriendsPayload {
  friends: FriendEntry[];
  /** Anfragen AN mich — warten auf Annehmen/Ablehnen. */
  incoming: FriendEntry[];
  /** Meine offenen Anfragen — zurückziehbar. */
  outgoing: FriendEntry[];
}

/** Öffentliches Spieler-Profil — Klick auf einen Namen öffnet es. */
export interface PlayerProfile {
  accountId: string;
  displayName: string;
  avatarUrl: string | null;
  level: number;
  xp: number;
  /** PvP-Zähler — nur Spieler gegen Spieler. */
  kills: number;
  deaths: number;
  createdAt: string;
  /** Flottille samt Rang — null ohne Mitgliedschaft. */
  fleet: { name: string; rank: number } | null;
  friendship: FriendshipState;
  /**
   * Chatsperre des Spielers — NUR gesetzt, wenn der Abfragende selbst
   * Moderationsrechte hat (steuert die Knöpfe auf der Profilkarte).
   */
  chatMuted?: boolean;
}

/** Eine gespeicherte Chat-Zeile, wie die Historie sie liefert. */
export interface StoredChatMessage {
  id: number;
  senderId: string;
  name: string;
  text: string;
  level: number;
  role: number;
  /** ISO-Zeitstempel des Versands. */
  at: string;
}
