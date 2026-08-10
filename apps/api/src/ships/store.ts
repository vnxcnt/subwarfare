import type { ShipStats } from '@subwarfare/shared';
import { DEFAULT_SHIP_STATS, isVesselModel } from '@subwarfare/shared';
import type { RowDataPacket } from 'mysql2/promise';
import { getPool } from '../db/pool.js';
import { env } from '../env.js';

interface ShipRow extends RowDataPacket {
  model: string;
  hp: number;
  type: number;
  /** mysql2 liefert JSON-Spalten bereits geparst. */
  armament: unknown;
  speed: string | number;
}

/**
 * Schiffs-Basiswerte aus der Tabelle `ships`.
 *
 * Ohne Datenbank (lokale Entwicklung) gelten die DEFAULTS aus shared — exakt
 * die Werte, die der Migrations-Seed auch schreibt. Unbekannte Modelle in der
 * Tabelle (Tippfehler, Zukunftszeilen ohne Client-Atlas) werden übersprungen
 * und gemeldet statt den Katalog zu vergiften.
 */
export async function loadShipStats(): Promise<ShipStats[]> {
  if (!env.databaseUrl) return Object.values(DEFAULT_SHIP_STATS);

  const [rows] = await getPool().query<ShipRow[]>(
    'SELECT model, hp, type, armament, speed FROM ships',
  );

  const ships: ShipStats[] = [];
  for (const row of rows) {
    if (!isVesselModel(row.model)) {
      console.warn(`[api] ships-Tabelle: unbekanntes Modell "${row.model}" übersprungen.`);
      continue;
    }
    const armament = Array.isArray(row.armament)
      ? (row.armament.filter((w) => typeof w === 'string') as ShipStats['armament'])
      : [];
    ships.push({
      model: row.model,
      hp: Number(row.hp),
      type: Number(row.type) as ShipStats['type'],
      armament,
      // DECIMAL kommt als Zeichenkette an — Number() ist hier Pflicht.
      speedFactor: Number(row.speed),
    });
  }
  return ships;
}
