import type { AmmoStats, ItemId, WeaponId } from '@subwarfare/shared';
import { DEFAULT_AMMO_STATS, isItemId } from '@subwarfare/shared';
import type { RowDataPacket } from 'mysql2/promise';
import { getPool } from '../db/pool.js';
import { env } from '../env.js';

interface AmmoRow extends RowDataPacket {
  item_id: string;
  weapon: string;
  damage: number;
}

/** Waffen-Kennungen, die es wirklich gibt — gegen Tippfehler in der Tabelle. */
const WAFFEN = new Set<string>(['torpedo', 'taeuschkoerper', 'geschuetz', 'wasserbombe']);

/**
 * Kampfwerte der Munition aus der Tabelle `weapon_items`.
 *
 * Ohne Datenbank gelten die Standardwerte aus shared — dieselben Zahlen, die
 * auch der Migrations-Seed schreibt. Zeilen mit unbekanntem Item oder
 * unbekannter Waffe werden übersprungen und gemeldet, statt den Katalog zu
 * vergiften; dieselbe Regel wie bei `ships` und `armor`.
 */
export async function loadAmmoStats(): Promise<AmmoStats[]> {
  if (!env.databaseUrl) return Object.values(DEFAULT_AMMO_STATS);

  const [rows] = await getPool().query<AmmoRow[]>(
    'SELECT item_id, weapon, damage FROM weapon_items',
  );

  const ammo: AmmoStats[] = [];
  for (const row of rows) {
    if (!isItemId(row.item_id)) {
      console.warn(`[api] weapon_items: unbekanntes Item "${row.item_id}" übersprungen.`);
      continue;
    }
    if (!WAFFEN.has(row.weapon)) {
      console.warn(
        `[api] weapon_items: "${row.item_id}" nennt Waffe "${row.weapon}" — übersprungen.`,
      );
      continue;
    }
    ammo.push({
      itemId: row.item_id as ItemId,
      weapon: row.weapon as WeaponId,
      damage: Number(row.damage),
    });
  }
  return ammo;
}
