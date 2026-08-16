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

/** Ein Spielserver-Prozess, wie ihn die api sieht. */
export interface GameMapTarget {
  /** Interne Adresse — Statusabfrage und Warteschlangen-Takt. */
  internalUrl: string;
  /**
   * Adresse, die der Client im Join-Ticket bekommt. Leer heißt „gleiche
   * Herkunft wie der Client" (Normalfall hinter dem Reverse-Proxy) — bei
   * mehreren Karten kann das höchstens für EINE stimmen.
   */
  publicUrl: string;
}

/**
 * Erhöht den Port einer Adresse — die Vorgabe für Karten ohne eigenes
 * Adresspaar. Adressen OHNE Port (hinter dem Reverse-Proxy: Hostname, 443)
 * bleiben unverändert; dort gibt es nichts hochzuzählen, und der doppelte
 * Eintrag fällt beim Start als Warnung auf.
 */
function portPlus(url: string, offset: number): string {
  if (offset === 0 || url.length === 0) return url;
  try {
    const ziel = new URL(url);
    const port = Number.parseInt(ziel.port, 10);
    if (!Number.isFinite(port)) return url;
    ziel.port = String(port + offset);
    // `toString()` hängt einen Schrägstrich an — der ergäbe in
    // `${internalUrl}/status` eine doppelte Trennung.
    return ziel.toString().replace(/\/+$/, '');
  } catch {
    return url;
  }
}

const BASIS_INTERN = process.env['GAME_INTERNAL_URL'] ?? 'http://127.0.0.1:8080';
const BASIS_OEFFENTLICH = process.env['GAME_PUBLIC_URL'] ?? 'http://localhost:8080';

/*
 * Karten-Tabelle: je Karte der Spielserver-Prozess dahinter.
 *
 * Eine Karte = EIN eigener game-server-Prozess (drüben über MAP_ID gewählt);
 * die api kennt von ihm zwei Adressen, weil sie ihn aus einer anderen Sicht
 * anspricht als der Browser des Spielers.
 *
 * Konfiguration — trägt ocean02/03/05 mit, ohne dass hier Code angefasst wird:
 *   GAME_MAPS=ocean01,ocean04        Welche Karten es gibt (Reihenfolge zählt)
 *   GAME_INTERNAL_URL_OCEAN04=…      Adresspaar je Karte, Kennung GROSS
 *   GAME_PUBLIC_URL_OCEAN04=…
 *
 * Fehlt das Paar einer Karte, gilt die alte Einzelvariable (GAME_INTERNAL_URL /
 * GAME_PUBLIC_URL, Vorgabe Port 8080) mit dem Port um die POSITION in der Liste
 * erhöht: lokal also 8080 für ocean01 und 8081 für ocean04 — ein bestehender
 * Ein-Karten-Betrieb bricht dadurch nicht. Auf dem VPS die Paare trotzdem
 * ausdrücklich setzen: dort steht hinter der öffentlichen Adresse ein Hostname
 * ohne Port, den diese Vorgabe nicht auseinanderziehen kann.
 */
const KARTEN_IDS = (process.env['GAME_MAPS'] ?? 'ocean01,ocean04')
  .split(',')
  .map((eintrag) => eintrag.trim())
  .filter((eintrag) => eintrag.length > 0);

const gameMaps = new Map<string, GameMapTarget>(
  (KARTEN_IDS.length > 0 ? KARTEN_IDS : ['ocean01']).map((mapId, index) => {
    // ocean04 → GAME_INTERNAL_URL_OCEAN04. Alles, was in einem Variablennamen
    // nichts zu suchen hat, wird zum Unterstrich.
    const suffix = mapId.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    return [
      mapId,
      {
        internalUrl: process.env[`GAME_INTERNAL_URL_${suffix}`] ?? portPlus(BASIS_INTERN, index),
        publicUrl: process.env[`GAME_PUBLIC_URL_${suffix}`] ?? portPlus(BASIS_OEFFENTLICH, index),
      },
    ];
  }),
);

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
   * Name-Login (Entwickler-Login ohne OAuth). Opt-in per `AUTH_DEV=1` —
   * lokal steht das in der .env, auf dem VPS steht AUTH_DEV=0 und der Weg
   * ist zu. (Zur F&F-Testphase am 2026-08-14 war er kurzzeitig
   * standardmäßig offen; auf Betreiber-Entscheidung wieder Opt-in.)
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

  /** Alle bespielbaren Karten mit ihrem Spielserver — siehe Tabelle oben. */
  gameMaps: gameMaps as ReadonlyMap<string, GameMapTarget>,
  /**
   * Erste Karte der Liste. Nur für Aufrufer, die kartenunabhängig fragen
   * („fährt dieses Konto gerade?") — Warteschlange und Ticket geben ihre
   * Karte immer ausdrücklich an.
   */
  defaultMapId: KARTEN_IDS[0] ?? 'ocean01',
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

  /*
   * Zwei Karten auf demselben Spielserver sind der teuerste Konfigurationsfehler
   * dieser Tabelle: die Lobby buchte beide Warteschlangen gegen dieselben Plätze,
   * und der Client landete auf der Karte, die er nicht gewählt hat. Passiert
   * genau dann, wenn ein Adresspaar fehlt und die Port-Vorgabe nicht greifen
   * konnte — etwa hinter dem Reverse-Proxy, wo keine Adresse einen Port trägt.
   */
  const belegt = new Map<string, string>();
  for (const [mapId, ziel] of env.gameMaps) {
    for (const adresse of [ziel.internalUrl, ziel.publicUrl]) {
      const andere = belegt.get(adresse);
      if (andere !== undefined && andere !== mapId) {
        console.warn(
          `[api] ⚠️  Karten ${andere} und ${mapId} zeigen auf denselben Spielserver ` +
            `(${adresse || 'gleiche Herkunft wie der Client'}) — je Karte ein eigenes ` +
            'Adresspaar setzen: GAME_INTERNAL_URL_<KARTE> und GAME_PUBLIC_URL_<KARTE>.',
        );
      } else {
        belegt.set(adresse, mapId);
      }
    }
  }
}
