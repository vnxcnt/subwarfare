/**
 * Konfiguration aus der Umgebung.
 *
 * Wie beim Spielserver: `.env` lokal, systemd-EnvironmentFile auf dem VPS.
 * Geheimnisse stehen nirgends im Repo.
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
  port: num('PORT', 8090),
  host: process.env['HOST'] ?? '0.0.0.0',

  /**
   * Muss identisch zum Spielserver sein — mit diesem Schlüssel signieren wir
   * die Join-Tickets, die der Spielserver prüft.
   */
  jwtSecret: process.env['JWT_SECRET'] ?? DEV_SECRET,
  /** Gültigkeit eines Join-Tickets in Sekunden. Bewusst kurz. */
  ticketTtl: num('TICKET_TTL', 60),
  /** Gültigkeit einer Sitzung in Tagen. */
  sessionDays: num('SESSION_DAYS', 7),

  /**
   * Entwickler-Login ohne Google. Bewusst ein eigenes Flag statt NODE_ENV:
   * auf dem VPS wird zuerst ohne Google getestet, das ist dann eine bewusste
   * Entscheidung und kein Nebeneffekt der Betriebsart.
   */
  authDev: process.env['AUTH_DEV'] === '1',
  googleClientId: process.env['GOOGLE_CLIENT_ID'] ?? '',

  /**
   * Discord-OAuth. Anders als Google akzeptiert Discord auch nackte
   * IP-Adressen als Redirect-Ziel — deshalb ist das der erste „richtige"
   * Anmeldeweg, noch bevor eine Domain existiert.
   */
  discordClientId: process.env['DISCORD_CLIENT_ID'] ?? '',
  discordClientSecret: process.env['DISCORD_CLIENT_SECRET'] ?? '',
  /** Muss ZEICHENGENAU so im Discord-Entwicklerportal hinterlegt sein. */
  discordRedirectUri:
    process.env['DISCORD_REDIRECT_URI'] ?? 'http://localhost:8090/api/auth/discord/callback',
  /** Wohin der Browser nach dem OAuth-Rücklauf geschickt wird (Client-App). */
  clientUrl: process.env['CLIENT_URL'] ?? 'http://localhost:5173',

  /** Ohne diese Angabe läuft alles im Arbeitsspeicher (lokale Entwicklung). */
  databaseUrl: process.env['DATABASE_URL'] ?? '',

  /** Interne Adresse des Spielservers — nur für die Statusabfrage. */
  gameInternalUrl: process.env['GAME_INTERNAL_URL'] ?? 'http://127.0.0.1:8080',
  /** Adresse, die der Client zum Verbinden bekommt. */
  gamePublicUrl: process.env['GAME_PUBLIC_URL'] ?? 'http://localhost:8080',
  internalKey: process.env['INTERNAL_KEY'] ?? 'dev-internal-key',

  corsOrigin: process.env['CORS_ORIGIN'] ?? 'http://localhost:5173',
} as const;

export function warnAboutDefaults(): void {
  if (env.jwtSecret === DEV_SECRET) {
    console.warn(
      '[api] ⚠️  JWT_SECRET nicht gesetzt — es gilt der Entwicklungswert. ' +
        'Im Produktivbetrieb setzen, sonst kann sich jeder ein Ticket ausstellen.',
    );
  }
  if (env.authDev) {
    console.warn(
      '[api] ⚠️  AUTH_DEV=1 — jeder kann sich mit einem beliebigen Namen anmelden. ' +
        'Für den Produktivbetrieb abschalten.',
    );
  }
  if (!env.authDev && !env.googleClientId && !env.discordClientId) {
    console.warn(
      '[api] ⚠️  Weder AUTH_DEV noch GOOGLE_CLIENT_ID noch DISCORD_CLIENT_ID gesetzt — ' +
        'es gibt derzeit keinen Weg, sich anzumelden.',
    );
  }
  if (!env.databaseUrl) {
    console.warn('[api] ⚠️  DATABASE_URL nicht gesetzt — Konten liegen nur im Arbeitsspeicher.');
  }
}
