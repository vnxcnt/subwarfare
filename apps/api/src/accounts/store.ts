import type { AccountProfile } from '@subwarfare/shared';

/** Konto, wie es intern vorliegt — mit Feldern, die nie nach außen gehen. */
export interface Account extends AccountProfile {
  /** Googles unveränderliche Nutzerkennung. `null`, wenn nicht verknüpft. */
  googleSub: string | null;
  /** Discords Snowflake-ID. `null`, wenn nicht verknüpft. */
  discordId: string | null;
  email: string | null;
  /** Kontorolle: 0 Spieler, 1 Moderator, 2 Gamemaster, 3 Entwickler. */
  role: number;
  lastLoginAt: string;
}

export interface GoogleIdentity {
  googleSub: string;
  email: string | null;
  displayName: string;
  avatarUrl: string | null;
}

export interface DiscordIdentity {
  discordId: string;
  displayName: string;
  avatarUrl: string | null;
}

/**
 * Konten-Ablage.
 *
 * Durchgehend `async`, obwohl die Speicher-Variante sofort antworten könnte:
 * Die Schnittstelle soll sich beim Wechsel auf MariaDB nicht ändern, und ein
 * nachträgliches Umstellen von synchron auf asynchron zieht sich durch jeden
 * Aufrufer.
 */
export interface AccountStore {
  /** Legt bei erster Anmeldung an, sonst aktualisiert es Name und Bild. */
  upsertGoogle(identity: GoogleIdentity): Promise<Account>;
  /** Wie `upsertGoogle`, nur am Discord-Konto festgemacht. */
  upsertDiscord(identity: DiscordIdentity): Promise<Account>;
  /** Entwickler-Login: Konto am Anzeigenamen festgemacht. */
  upsertDev(displayName: string): Promise<Account>;
  byId(id: string): Promise<Account | null>;
  touchLogin(id: string): Promise<void>;
  close(): Promise<void>;
}

export function toProfile(account: Account): AccountProfile {
  return {
    id: account.id,
    displayName: account.displayName,
    avatarUrl: account.avatarUrl,
    isDev: account.isDev,
    coins: account.coins,
    xp: account.xp,
    role: account.role,
    createdAt: account.createdAt,
  };
}

/** Anzeigenamen begrenzen — sie landen ungefiltert in fremden Anzeigen. */
export function sanitizeDisplayName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // Steuerzeichen entfernen: sie könnten Anzeigen zerlegen oder Namen tarnen.
  const name = raw.replace(/[\p{C}]/gu, '').trim();
  if (name.length < 2 || name.length > 24) return null;
  return name;
}
