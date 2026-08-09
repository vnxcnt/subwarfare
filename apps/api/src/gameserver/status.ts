import { env } from '../env.js';

export interface GameServerStatus {
  mapId: string;
  players: number;
  capacity: number;
  /** Verbundene Konten — daran erkennt die Lobby eingelöste Tickets. */
  accounts: string[];
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
    };
  } catch {
    return null;
  }
}
