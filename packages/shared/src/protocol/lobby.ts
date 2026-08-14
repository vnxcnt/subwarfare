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
  /**
   * Verknüpfte Anmeldewege — nur JA/NEIN, nie die Fremd-IDs selbst: der
   * Client braucht sie ausschließlich für die Anzeige in den Einstellungen.
   */
  hasGoogle: boolean;
  hasDiscord: boolean;
}

export interface AuthResponse {
  token: string;
  account: AccountProfile;
}

export interface QueueJoinRequest {
  mapId: string;
  /**
   * Gewähltes Schiff für diesen Einsatz. Die api prüft Freischalt-Level und
   * zieht die Einsatzkosten bei der Ticketausgabe ab (`SHIP_ACCESS`). Fehlt
   * das Feld (alter Client), fährt die kostenlose Fregatte.
   */
  shipModel?: string;
}

/* --- Inventar, Shop, Ausrüstung (REST unter /api) ----------------------- */

/** Ein Besitz-Eintrag: Item und Stückzahl. */
export interface InventoryItem {
  itemId: string;
  quantity: number;
}

/** Eine Slot-Belegung: Schiff, Slot-Kategorie, zugewiesenes Item. */
export interface LoadoutEntry {
  model: string;
  slot: string;
  itemId: string;
  /**
   * Wunschmenge, die in den Einsatz mitgeht. `null` heißt „alles, was da
   * ist" — das bisherige Verhalten und der Stand alter Slot-Belegungen.
   * Abgebucht wird beim Auslaufen höchstens der tatsächliche Bestand; für
   * nicht verbrauchbare Ausrüstung (Panzerung) ist die Menge bedeutungslos.
   */
  count: number | null;
}

/** Antwort von `GET /api/inventory` — Besitz und Zuordnungen eines Kontos. */
export interface InventoryPayload {
  items: InventoryItem[];
  loadouts: LoadoutEntry[];
}

export interface ShopBuyRequest {
  itemId: string;
}

/** Antwort eines Kaufs: neuer Kontostand + frischer Besitz. */
export interface ShopBuyResponse {
  coins: number;
  items: InventoryItem[];
}

export interface LoadoutUpdateRequest {
  model: string;
  slot: string;
  /** `null` räumt den Slot. */
  itemId: string | null;
  /**
   * Wunschmenge für den Einsatz (ganzzahlig, ≥ 1). Fehlt sie oder ist sie
   * `null`, geht der ganze Bestand mit. Bei Panzerung wird sie verworfen.
   */
  count?: number | null;
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

/**
 * Eine Chat-Zeile des Hauptmenüs. BEWUSST flüchtig: der Server reicht sie nur
 * an die gerade Verbundenen durch und speichert nichts — wer später kommt,
 * liest nichts nach. Der Name stammt aus dem geprüften Sitzungs-Token, nie
 * vom Client.
 */
export interface ChatMessagePayload {
  name: string;
  text: string;
  /** Spielstufe des Absenders — der Client zeigt das Rang-Abzeichen. */
  level: number;
  /** Kontorolle (ROLE_*) — färbt den Namen: Dev lila, GM rot, Mod grün. */
  role: number;
}

export interface ChatSendRequest {
  text: string;
}

export interface LobbyServerToClientEvents {
  'queue:update': (payload: QueueUpdatePayload) => void;
  'queue:ticket': (payload: QueueTicketPayload) => void;
  'queue:error': (payload: QueueErrorPayload) => void;
  'chat:message': (payload: ChatMessagePayload) => void;
}

export interface LobbyClientToServerEvents {
  'queue:join': (payload: QueueJoinRequest) => void;
  'queue:leave': () => void;
  'chat:send': (payload: ChatSendRequest) => void;
}

/** Längste zulässige Chat-Zeile — Client schneidet ab, Server erzwingt. */
export const CHAT_MAX_LENGTH = 200;

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
