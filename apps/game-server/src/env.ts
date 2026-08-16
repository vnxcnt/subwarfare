/**
 * Konfiguration aus der Umgebung.
 *
 * `.env` wird über Nodes eingebautes `loadEnvFile` gelesen — kein dotenv nötig.
 * Die Datei ist optional: auf dem Server kommen die Werte aus der systemd-Unit,
 * lokal aus `.env`.
 */
try {
  process.loadEnvFile('.env');
} catch {
  // Keine .env vorhanden — dann gelten die Vorgaben unten.
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}

const DEV_SECRET = 'dev-secret-change-me';

export const env = {
  port: num('PORT', 8080),
  host: process.env['HOST'] ?? '0.0.0.0',
  /**
   * Welche Karte dieser Prozess fährt. Eine zweite Karte heißt ein ZWEITER
   * Serverprozess mit eigenem Port — nicht mehrere Welten in einem Prozess.
   * Unbekannte Kennungen bricht die Karten-Registry beim Start ab.
   */
  mapId: process.env['MAP_ID'] ?? 'ocean01',
  /**
   * Pfad, unter dem dieser Prozess seinen socket.io-Endpunkt anbietet.
   *
   * Hinter dem Reverse-Proxy teilen sich ALLE Karten eine Herkunft —
   * unterscheidbar sind ihre Spielserver dort nur am Pfad. Statt Caddy den
   * Pfad umschreiben zu lassen (eine stille Fehlerquelle: passt die Regel
   * nicht zeichengenau, scheitert der Handshake ohne Meldung), lauscht jeder
   * Prozess gleich dort, wo der Client ihn sucht — der nimmt den Pfad aus der
   * Adresse im Ticket. Damit ist der Proxy eine reine Weiterleitung.
   *
   * ocean01 behält den alten Wert, sonst bräuchte ein bestehender Betrieb
   * plötzlich Konfiguration.
   */
  socketPath: process.env['SOCKET_PATH'] ?? '/game/socket.io',
  /** Muss identisch zum Backend sein — damit prüfen wir dessen Join-Tickets. */
  jwtSecret: process.env['JWT_SECRET'] ?? DEV_SECRET,
  /** Schützt den internen /status-Endpunkt vor Zugriff von außen. */
  internalKey: process.env['INTERNAL_KEY'] ?? 'dev-internal-key',
  /** Interne Adresse des Backends — für den Schiffskatalog beim Start. */
  apiInternalUrl: process.env['API_INTERNAL_URL'] ?? 'http://127.0.0.1:8090',
  maxPlayers: num('MAX_PLAYERS', 32),
  bots: num('BOTS', 5),
  /** Erlaubte Herkunft für Browser-Verbindungen im lokalen Betrieb. */
  corsOrigin: process.env['CORS_ORIGIN'] ?? 'http://localhost:5173',
} as const;

export function warnAboutDefaults(): void {
  if (env.jwtSecret === DEV_SECRET) {
    console.warn(
      '[game-server] ⚠️  JWT_SECRET nicht gesetzt — es gilt der Entwicklungswert. ' +
        'Im Produktivbetrieb setzen, sonst kann sich jeder ein Ticket ausstellen.',
    );
  }
}
