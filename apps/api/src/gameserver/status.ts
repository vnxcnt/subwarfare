import { env } from '../env.js';

export interface GameServerStatus {
  mapId: string;
  players: number;
  capacity: number;
  /** Verbundene Konten — daran erkennt die Lobby, wer gerade im Spiel ist. */
  accounts: string[];
  /**
   * Kennungen (`jti`) bereits eingelöster Tickets.
   *
   * `accounts` allein reicht dafür NICHT: wer beitritt und gleich wieder geht,
   * ist beim nächsten Sweep schon nicht mehr verbunden — seine Reservierung
   * stünde dann bis zum Ablauf, und die Lobby würde ihm sein verbranntes Ticket
   * erneut zustellen („Ticket wurde bereits eingelöst"). Die Liste räumt sich
   * beim Spielserver mit dem Ticket-Ablauf selbst.
   */
  redeemed: string[];
}

/**
 * Fragt den Spielserver nach seiner Auslastung.
 *
 * Mit Zeitlimit: ohne das würde ein hängender Spielserver die gesamte
 * Warteschlangen-Prüfung blockieren und damit die Lobby für alle einfrieren.
 */
export async function fetchGameServerStatus(): Promise<GameServerStatus | null> {
  try {
    const response = await fetch(`${env.gameInternalUrl}/status`, {
      headers: { 'x-internal-key': env.internalKey },
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return null;

    const data = (await response.json()) as Partial<GameServerStatus>;
    if (
      typeof data.mapId !== 'string' ||
      typeof data.players !== 'number' ||
      typeof data.capacity !== 'number'
    ) {
      return null;
    }
    return {
      mapId: data.mapId,
      players: data.players,
      capacity: data.capacity,
      accounts: Array.isArray(data.accounts)
        ? data.accounts.filter((id): id is string => typeof id === 'string')
        : [],
      // Fehlt bei einem älteren Spielserver: dann gilt wie bisher allein
      // `accounts`. Leer heißt „nichts eingelöst", nicht „unbekannt" — der
      // schlechtere Fall ist der alte Zustand, kein neuer.
      redeemed: Array.isArray(data.redeemed)
        ? data.redeemed.filter((id): id is string => typeof id === 'string')
        : [],
    };
  } catch {
    return null;
  }
}
