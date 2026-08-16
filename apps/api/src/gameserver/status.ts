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

/** Einmal je Karte warnen reicht — der Takt fragt im Sekundentakt. */
const verdrahtungGemeldet = new Set<string>();

/**
 * Fragt den Spielserver EINER Karte nach seiner Auslastung.
 *
 * Jede Karte ist ein eigener Prozess mit eigener Adresse (env.gameMaps) —
 * deshalb gibt der Aufrufer an, welche er meint. Die Karte ist trotzdem
 * optional: es gibt Aufrufer, die kartenunabhängig fragen (die Werft prüft nur
 * „ist dieses Konto gerade auf See?"), und die sehen weiterhin die erste Karte.
 *
 * Mit Zeitlimit: ohne das würde ein hängender Spielserver die gesamte
 * Warteschlangen-Prüfung blockieren und damit die Lobby für alle einfrieren.
 */
export async function fetchGameServerStatus(
  mapId: string = env.defaultMapId,
): Promise<GameServerStatus | null> {
  const ziel = env.gameMaps.get(mapId);
  if (!ziel) return null;

  try {
    const response = await fetch(`${ziel.internalUrl}/status`, {
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
    if (data.mapId !== mapId) {
      /*
       * Falsch verdrahtet: an dieser Adresse läuft eine andere Karte (drüben
       * fehlt MAP_ID, oder zwei Einträge zeigen auf denselben Prozess). Lieber
       * „nicht erreichbar" melden als weiterrechnen — sonst zählten wir die
       * Plätze der einen Karte gegen die Reservierungen der anderen und
       * schickten den Spieler auf eine Karte, die er nicht gewählt hat.
       */
      if (!verdrahtungGemeldet.has(mapId)) {
        verdrahtungGemeldet.add(mapId);
        console.warn(
          `[api] ⚠️  ${ziel.internalUrl} liefert Karte ${data.mapId}, erwartet war ${mapId} — ` +
            'Adressen in GAME_MAPS bzw. MAP_ID des Spielservers prüfen.',
        );
      }
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
