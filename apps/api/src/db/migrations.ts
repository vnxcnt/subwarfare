/**
 * Schema-Migrationen.
 *
 * Als TypeScript-Modul und nicht als `.sql`-Dateien: `tsc` kopiert keine
 * Fremddateien nach `dist`, das Deploy auf dem VPS startet aber genau von
 * dort. Eingebettet gibt es keine Pfadauflösung zur Laufzeit und damit auch
 * keinen Fall, in dem die Migration erst auf dem Server fehlt.
 *
 * Regeln: aufsteigende `id`, niemals eine bestehende Migration ändern —
 * angewandte Migrationen sind in `schema_migrations` festgehalten und werden
 * nicht erneut ausgeführt.
 */
export interface Migration {
  id: number;
  name: string;
  /** Einzeln ausgeführt: mysql2 führt pro Aufruf nur eine Anweisung aus. */
  statements: string[];
}

export const MIGRATIONS: readonly Migration[] = [
  {
    id: 1,
    name: 'accounts',
    statements: [
      `CREATE TABLE IF NOT EXISTS accounts (
         id CHAR(36) NOT NULL PRIMARY KEY,
         google_sub VARCHAR(64) NULL,
         email VARCHAR(255) NULL,
         display_name VARCHAR(24) NOT NULL,
         avatar_url VARCHAR(512) NULL,
         is_dev TINYINT(1) NOT NULL DEFAULT 0,
         created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
         last_login_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
         UNIQUE KEY uq_accounts_google_sub (google_sub),
         KEY idx_accounts_last_login (last_login_at)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      // Entwickler-Konten hängen am Namen. Der Unique-Index steht nur auf
      // dieser Teilmenge, damit ein Google-Nutzer denselben Anzeigenamen
      // trotzdem führen darf.
      `CREATE TABLE IF NOT EXISTS dev_accounts (
         display_name_key VARCHAR(24) NOT NULL PRIMARY KEY,
         account_id CHAR(36) NOT NULL,
         CONSTRAINT fk_dev_accounts_account FOREIGN KEY (account_id)
           REFERENCES accounts (id) ON DELETE CASCADE
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    ],
  },
  {
    id: 2,
    name: 'discord-login',
    statements: [
      // Discords Snowflake-ID ist die unveränderliche Nutzerkennung — analog
      // zu google_sub. Nutzername und Anzeigename können sich jederzeit ändern.
      `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS discord_id VARCHAR(32) NULL AFTER google_sub`,
      `ALTER TABLE accounts ADD UNIQUE KEY IF NOT EXISTS uq_accounts_discord_id (discord_id)`,
    ],
  },
];
