import { randomUUID } from 'node:crypto';
import type { Account, AccountStore, DiscordIdentity, GoogleIdentity } from './store.js';

/**
 * Konten im Arbeitsspeicher — für die Entwicklung ohne Datenbank.
 *
 * Beim Neustart ist alles weg. Das ist Absicht und der Grund, warum auf dem
 * VPS MariaDB läuft: Konten sollen persistent sein.
 */
export class MemoryAccountStore implements AccountStore {
  private readonly byIdMap = new Map<string, Account>();
  private readonly byGoogle = new Map<string, string>();
  private readonly byDiscord = new Map<string, string>();
  private readonly byDevName = new Map<string, string>();

  async upsertGoogle(identity: GoogleIdentity): Promise<Account> {
    const existingId = this.byGoogle.get(identity.googleSub);
    if (existingId) {
      const account = this.byIdMap.get(existingId)!;
      account.displayName = identity.displayName;
      account.avatarUrl = identity.avatarUrl;
      account.email = identity.email;
      return account;
    }

    const account = this.create({
      googleSub: identity.googleSub,
      discordId: null,
      email: identity.email,
      displayName: identity.displayName,
      avatarUrl: identity.avatarUrl,
      isDev: false,
    });
    this.byGoogle.set(identity.googleSub, account.id);
    return account;
  }

  async upsertDiscord(identity: DiscordIdentity): Promise<Account> {
    const existingId = this.byDiscord.get(identity.discordId);
    if (existingId) {
      const account = this.byIdMap.get(existingId)!;
      account.displayName = identity.displayName;
      account.avatarUrl = identity.avatarUrl;
      return account;
    }

    const account = this.create({
      googleSub: null,
      discordId: identity.discordId,
      email: null,
      displayName: identity.displayName,
      avatarUrl: identity.avatarUrl,
      isDev: false,
    });
    this.byDiscord.set(identity.discordId, account.id);
    return account;
  }

  async upsertDev(displayName: string): Promise<Account> {
    const key = displayName.toLowerCase();
    const existingId = this.byDevName.get(key);
    if (existingId) return this.byIdMap.get(existingId)!;

    const account = this.create({
      googleSub: null,
      discordId: null,
      email: null,
      displayName,
      avatarUrl: null,
      isDev: true,
    });
    // Der Entwickler-Zugang IST ein Entwicklerwerkzeug — im Speicherbetrieb
    // bekommt er die Entwicklerrolle, damit das Dev-Menue lokal testbar ist.
    account.role = 3;
    this.byDevName.set(key, account.id);
    return account;
  }

  async byId(id: string): Promise<Account | null> {
    return this.byIdMap.get(id) ?? null;
  }

  async touchLogin(id: string): Promise<void> {
    const account = this.byIdMap.get(id);
    if (account) account.lastLoginAt = new Date().toISOString();
  }

  async close(): Promise<void> {
    // Nichts zu schließen.
  }

  private create(
    fields: Omit<Account, 'id' | 'createdAt' | 'lastLoginAt' | 'coins' | 'xp' | 'role'>,
  ): Account {
    const now = new Date().toISOString();
    const account: Account = {
      ...fields,
      id: randomUUID(),
      // Startwerte wie das Datenbank-Schema: ohne Guthaben, ohne Erfahrung.
      coins: 0,
      xp: 0,
      role: 0,
      createdAt: now,
      lastLoginAt: now,
    };
    this.byIdMap.set(account.id, account);
    return account;
  }
}
