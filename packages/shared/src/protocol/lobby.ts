/**
 * Protokoll der Lobby: Anmeldung, Konto, Warteschlange.
 *
 * Getrennt vom Spielprotokoll, weil es ein eigener Dienst mit eigenem Takt ist.
 * Die Lobby verschickt Ereignisse im Sekundenbereich; das Spiel 20-mal pro
 * Sekunde. Nur der Übergabepunkt ist gemeinsam: das **Join-Ticket**, mit dem
 * sich der Client anschließend am Spielserver anmeldet.
 */

/**
 * Empfänger-Kennungen (`aud`) der beiden Tokenarten.
 *
 * Sie halten Sitzungs-Token und Join-Ticket auseinander. Ohne diese Trennung
 * wäre das Sitzungs-Token — das im Browser des Spielers liegt — zugleich ein
 * gültiges Ticket, und jeder Angemeldete könnte die Warteschlange umgehen.
 * Beide Seiten müssen dieselbe Zeichenkette verwenden, deshalb steht sie hier.
 */
export const SESSION_AUDIENCE = 'subwarfare:session';
export const TICKET_AUDIENCE = 'subwarfare:game';

/** Öffentliche Sicht auf ein Konto. Enthält bewusst keine Mailadresse Dritter. */
export interface AccountProfile {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  /** Über den Entwickler-Login angelegt — im Produktivbetrieb abgeschaltet. */
  isDev: boolean;
  /** Guthaben in der Spielwährung „Coins". Vergeben wird nur server-seitig. */
  coins: number;
  /** XP-Gesamtstand. Level und Rang leiten sich daraus ab (`progressionFromXp`). */
  xp: number;
  /** Kontorolle: 0 Spieler, 1 Moderator, 2 Gamemaster, 3 Entwickler. */
  role: number;
  createdAt: string;
}

export interface AuthResponse {
  token: string;
  account: AccountProfile;
}

export interface QueueJoinRequest {
  mapId: string;
}

/** Zwischenstand, solange die Karte voll ist. */
export interface QueueUpdatePayload {
  mapId: string;
  /** 1 = als Nächstes dran. */
  position: number;
  size: number;
}

/**
 * Der Platz ist frei. Das Ticket gilt 60 Sekunden und genau einmal — der
 * Client muss sich sofort am Spielserver anmelden.
 */
export interface QueueTicketPayload {
  mapId: string;
  ticket: string;
  /**
   * Adresse des Spielservers, inklusive Protokoll. Leer bedeutet: gleiche
   * Herkunft wie der Client — der Normalfall hinter dem Reverse-Proxy.
   */
  gameUrl: string;
  /** Sekunden bis zum Ablauf, damit die Anzeige mitzählen kann. */
  expiresIn: number;
}

export interface QueueErrorPayload {
  message: string;
}

export interface LobbyServerToClientEvents {
  'queue:update': (payload: QueueUpdatePayload) => void;
  'queue:ticket': (payload: QueueTicketPayload) => void;
  'queue:error': (payload: QueueErrorPayload) => void;
}

export interface LobbyClientToServerEvents {
  'queue:join': (payload: QueueJoinRequest) => void;
  'queue:leave': () => void;
}

/** Pro Lobby-Verbindung hinterlegt, nachdem das Sitzungs-Token geprüft wurde. */
export interface LobbySocketData {
  accountId: string;
  name: string;
}

/** Inhalt eines Sitzungs-Tokens. Langlebig, im Gegensatz zum Join-Ticket. */
export interface SessionClaims {
  sub: string;
  name: string;
}
