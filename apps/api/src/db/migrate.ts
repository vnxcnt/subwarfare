import type { RowDataPacket } from 'mysql2/promise';
import { pathToFileURL } from 'node:url';
import { env } from '../env.js';
import { MIGRATIONS } from './migrations.js';
import { closePool, getPool } from './pool.js';

/**
 * Wendet ausstehende Migrationen an.
 *
 * Wird beim Start des Backends aufgerufen und zusätzlich vom Deploy-Hook als
 * eigener Befehl (`pnpm --filter @subwarfare/api migrate`).
 */
export async function migrate(): Promise<void> {
  if (!env.databaseUrl) {
    console.log('[api] Keine DATABASE_URL — Migrationen übersprungen.');
    return;
  }

  const pool = getPool();
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       id INT NOT NULL PRIMARY KEY,
       name VARCHAR(64) NOT NULL,
       applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  );

  const [rows] = await pool.query<RowDataPacket[]>('SELECT id FROM schema_migrations');
  const applied = new Set(rows.map((row) => Number(row['id'])));

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;

    // Eine Verbindung für die gesamte Migration, damit die Transaktion hält.
    // DDL in MariaDB committet allerdings implizit — die Transaktion schützt
    // hier nur die Reihenfolge, nicht vor einem halben Schema. Deshalb sind
    // die Anweisungen bewusst idempotent (`IF NOT EXISTS`).
    const connection = await pool.getConnection();
    try {
      for (const statement of migration.statements) {
        await connection.query(statement);
      }
      await connection.execute('INSERT INTO schema_migrations (id, name) VALUES (?, ?)', [
        migration.id,
        migration.name,
      ]);
      console.log(`[api] Migration ${migration.id} (${migration.name}) angewandt.`);
    } finally {
      connection.release();
    }
  }
}

/**
 * Direkter Aufruf: `node dist/db/migrate.js`.
 *
 * Der Vergleich läuft über `pathToFileURL`, weil `process.argv[1]` ein
 * Betriebssystempfad ist und `import.meta.url` eine URL — auf Windows mit
 * Laufwerksbuchstabe und Backslashes stimmen die sonst nie überein.
 */
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    await migrate();
    console.log('[api] Migrationen abgeschlossen.');
  } catch (error) {
    console.error('[api] Migration fehlgeschlagen:', error);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}
