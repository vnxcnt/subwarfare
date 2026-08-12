import type { ArmorStats } from '@subwarfare/shared';
import { DEFAULT_ARMOR_STATS, isItemId } from '@subwarfare/shared';
import type { RowDataPacket } from 'mysql2/promise';
import { getPool } from '../db/pool.js';
import { env } from '../env.js';

interface ArmorRow extends RowDataPacket {
  item_id: string;
  level: number;
  /** mysql2 liefert DECIMAL als Zeichenkette. */
  absorb: string | number;
}

/**
 * Panzerungswerte aus der Tabelle `armor`.
 *
 * Ohne Datenbank (lokale Entwicklung) gelten die DEFAULTS aus shared — exakt
 * die Werte, die der Migrations-Seed auch schreibt. Unbekannte Kennungen in der
 * Tabelle (Tippfehler, Zukunftszeilen ohne Item im Katalog) werden übersprungen
 * und gemeldet statt den Katalog zu vergiften — dieselbe Regel wie bei `ships`.
 */
export async function loadArmorStats(): Promise<ArmorStats[]> {
  if (!env.databaseUrl) return Object.values(DEFAULT_ARMOR_STATS);

  const [rows] = await getPool().query<ArmorRow[]>('SELECT item_id, level, absorb FROM armor');

  const armor: ArmorStats[] = [];
  for (const row of rows) {
    if (!isItemId(row.item_id)) {
      console.warn(`[api] armor-Tabelle: unbekanntes Item "${row.item_id}" übersprungen.`);
      continue;
    }
    const absorb = Number(row.absorb);
    if (!Number.isFinite(absorb) || absorb < 0 || absorb > 1) {
      console.warn(`[api] armor-Tabelle: "${row.item_id}" hat absorb=${row.absorb} — übersprungen.`);
      continue;
    }
    armor.push({ itemId: row.item_id, level: Number(row.level), absorb });
  }
  return armor;
}
