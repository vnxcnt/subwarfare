import type { AmmoStats } from '@subwarfare/shared';
import { DEFAULT_AMMO_STATS } from '@subwarfare/shared';
import { env } from '../env.js';

/**
 * Munitionskatalog des Spielservers: welche Sorte wie hart zuschlägt.
 *
 * Gleicher Aufbau und gleicher Grund wie Schiffs- und Panzerungskatalog — die
 * Wahrheit steht in `weapon_items`, der Spielserver bleibt datenbankfrei und
 * holt sie beim Start einmal über den internen Kanal.
 *
 * Die STÜCKZAHL steht bewusst nicht hier: die kommt je Einsatz aus dem Ticket,
 * weil sie am Konto hängt und nicht an der Sorte.
 */
export class AmmoCatalog {
  private stats = new Map<string, AmmoStats>(Object.entries(DEFAULT_AMMO_STATS));

  async load(): Promise<void> {
    const ANLAEUFE = 5;
    for (let versuch = 1; versuch <= ANLAEUFE; versuch += 1) {
      try {
        const response = await fetch(`${env.apiInternalUrl}/api/internal/weapons`, {
          headers: { 'x-internal-key': env.internalKey },
          signal: AbortSignal.timeout(3000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = (await response.json()) as { ammo?: AmmoStats[] };
        if (!Array.isArray(data.ammo) || data.ammo.length === 0) throw new Error('leer');

        for (const sorte of data.ammo) this.stats.set(sorte.itemId, sorte);
        console.log(`[game-server] Munitionskatalog geladen: ${data.ammo.length} Sorten.`);
        return;
      } catch (error) {
        if (versuch === ANLAEUFE) {
          console.warn(
            `[game-server] Munitionskatalog nach ${ANLAEUFE} Anläufen nicht abrufbar ` +
              `(${String(error)}) — Standardwerte aktiv.`,
          );
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }

  /**
   * Schaden einer Sorte. Unbekannte Kennung → `null`; der Aufrufer nimmt dann
   * den Grundwert der Waffe aus `combat.ts`, statt Treffer wirkungslos zu
   * machen.
   */
  damage(itemId: string | null | undefined): number | null {
    if (!itemId) return null;
    const sorte = this.stats.get(itemId);
    return sorte ? sorte.damage : null;
  }
}
