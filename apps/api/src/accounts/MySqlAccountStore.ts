import type { Pool, RowDataPacket } from 'mysql2/promise';
import { randomUUID } from 'node:crypto';
import { closePool, getPool } from '../db/pool.js';
import type { Account, AccountStore, DiscordIdentity, GoogleIdentity } from './store.js';

interface AccountRow extends RowDataPacket {
  id: string;
  google_sub: string | null;
  discord_id: string | null;
  email: string | null;
  display_name: string;
  avatar_url: string | null;
  is_dev: number;
  coins: number;
  xp: number;
  role: number;
  created_at: string;
  last_login_at: string;
}

function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    googleSub: row.google_sub,
    discordId: row.discord_id,
    email: row.email,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    isDev: row.is_dev === 1,
    coins: row.coins,
    xp: row.xp,
    role: row.role,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  };
}

const SELECT = `SELECT id, google_sub, discord_id, email, display_name, avatar_url, is_dev,
                       coins, xp, role, created_at, last_login_at
                  FROM accounts`;

/**
 * Konten in MariaDB.
 *
 * Alle Abfragen laufen über `execute` (vorbereitete Anweisungen) — dadurch
 * gehen Werte nie als Text in die Abfrage und SQL-Injektion ist strukturell
 * ausgeschlossen, nicht bloß durch Sorgfalt beim Formulieren.
 */
export class MySqlAccountStore implements AccountStore {
  private readonly pool: Pool = getPool();

  async upsertGoogle(identity: GoogleIdentity): Promise<Account> {
    // Erst schreiben, dann lesen. Ein vorheriges SELECT wäre ein Wettlauf:
    // zwei gleichzeitige Anmeldungen desselben Kontos legten sonst zwei an.
    // Der Unique-Index auf google_sub macht das Insert eindeutig.
    await this.pool.execute(
      `INSERT INTO accounts (id, google_sub, email, display_name, avatar_url, is_dev)
       VALUES (?, ?, ?, ?, ?, 0)
       ON DUPLICATE KEY UPDATE
         email = VALUES(email),
         display_name = VALUES(display_name),
         avatar_url = VALUES(avatar_url),
         last_login_at = CURRENT_TIMESTAMP`,
      [randomUUID(), identity.googleSub, identity.email, identity.displayName, identity.avatarUrl],
    );

    const [rows] = await this.pool.execute<AccountRow[]>(
      `${SELECT} WHERE google_sub = ? LIMIT 1`,
      [identity.googleSub],
    );
    const row = rows[0];
    if (!row) throw new Error('Konto konnte nach dem Anlegen nicht gelesen werden.');
    return toAccount(row);
  }

  async upsertDiscord(identity: DiscordIdentity): Promise<Account> {
    // Gleiches Muster wie bei Google: schreiben, dann lesen — der Unique-Index
    // auf discord_id macht gleichzeitige Erstanmeldungen eindeutig.
    await this.pool.execute(
      `INSERT INTO accounts (id, discord_id, display_name, avatar_url, is_dev)
       VALUES (?, ?, ?, ?, 0)
       ON DUPLICATE KEY UPDATE
         display_name = VALUES(display_name),
         avatar_url = VALUES(avatar_url),
         last_login_at = CURRENT_TIMESTAMP`,
      [randomUUID(), identity.discordId, identity.displayName, identity.avatarUrl],
    );

    const [rows] = await this.pool.execute<AccountRow[]>(
      `${SELECT} WHERE discord_id = ? LIMIT 1`,
      [identity.discordId],
    );
    const row = rows[0];
    if (!row) throw new Error('Konto konnte nach dem Anlegen nicht gelesen werden.');
    return toAccount(row);
  }

  async upsertDev(displayName: string): Promise<Account> {
    const key = displayName.toLowerCase();
    const [existing] = await this.pool.execute<AccountRow[]>(
      `${SELECT} WHERE id = (SELECT account_id FROM dev_accounts WHERE display_name_key = ?) LIMIT 1`,
      [key],
    );
    const found = existing[0];
    if (found) return toAccount(found);

    const id = randomUUID();
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute(
        `INSERT INTO accounts (id, google_sub, email, display_name, avatar_url, is_dev)
         VALUES (?, NULL, NULL, ?, NULL, 1)`,
        [id, displayName],
      );
      await connection.execute(
        `INSERT INTO dev_accounts (display_name_key, account_id) VALUES (?, ?)`,
        [key, id],
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      // Ein gleichzeitiger zweiter Anlauf hat den Namen bereits belegt — dann
      // gilt dessen Konto, nicht ein Fehler.
      const [raced] = await this.pool.execute<AccountRow[]>(
        `${SELECT} WHERE id = (SELECT account_id FROM dev_accounts WHERE display_name_key = ?) LIMIT 1`,
        [key],
      );
      const winner = raced[0];
      if (winner) return toAccount(winner);
      throw error;
    } finally {
      connection.release();
    }

    const account = await this.byId(id);
    if (!account) throw new Error('Konto konnte nach dem Anlegen nicht gelesen werden.');
    return account;
  }

  async byId(id: string): Promise<Account | null> {
    const [rows] = await this.pool.execute<AccountRow[]>(`${SELECT} WHERE id = ? LIMIT 1`, [id]);
    const row = rows[0];
    return row ? toAccount(row) : null;
  }

  async touchLogin(id: string): Promise<void> {
    await this.pool.execute('UPDATE accounts SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?', [
      id,
    ]);
  }

  async close(): Promise<void> {
    await closePool();
  }
}
