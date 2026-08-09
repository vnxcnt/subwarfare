import mysql, { type Pool } from 'mysql2/promise';
import { env } from '../env.js';

let pool: Pool | null = null;

/**
 * Verbindungspool zu MariaDB.
 *
 * `dateStrings` ist gesetzt, damit Zeitstempel als Zeichenkette ankommen statt
 * als `Date`: mysql2 legt `Date`-Objekte in der ZEITZONE DES PROZESSES an, und
 * die ist auf dem VPS eine andere als lokal. Als Zeichenkette bleibt der Wert
 * derselbe, den die Datenbank gespeichert hat.
 */
export function getPool(): Pool {
  if (!env.databaseUrl) throw new Error('DATABASE_URL ist nicht gesetzt.');
  pool ??= mysql.createPool({
    uri: env.databaseUrl,
    connectionLimit: 10,
    dateStrings: true,
    // Ohne das liefert mysql2 BIGINT als Zeichenkette zurück, sobald ein Wert
    // die Genauigkeit von number übersteigt — wir haben nur kleine Zahlen.
    supportBigNumbers: true,
  });
  return pool;
}

export async function closePool(): Promise<void> {
  const current = pool;
  pool = null;
  if (current) await current.end();
}
