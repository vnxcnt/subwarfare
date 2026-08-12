import type { ArmorStats } from '@subwarfare/shared';
import { DEFAULT_ARMOR_STATS } from '@subwarfare/shared';
import { env } from '../env.js';

/**
 * Panzerungskatalog des Spielservers.
 *
 * Genau derselbe Aufbau wie der Schiffskatalog und aus demselben Grund: die
 * Wahrheit steht in der Tabelle `armor`, der Spielserver bleibt aber
 * datenbankfrei und holt sie beim Start EINMAL über den internen Kanal. Ist das
 * Backend nicht erreichbar, gelten die Standardwerte aus shared.
 *
 * Was hier NICHT steht, ist die Haltbarkeit: die Integrität läuft je Einsatz in
 * der Welt (`World`), gehört keinem Konto und überlebt keinen Untergang.
 */
export class ArmorCatalog {
  private stats = new Map<string, ArmorStats>(Object.entries(DEFAULT_ARMOR_STATS));

  /** Mit Wiederholung — beim Deploy starten api und Spielserver gleichzeitig. */
  async load(): Promise<void> {
    const ANLAEUFE = 5;
    for (let versuch = 1; versuch <= ANLAEUFE; versuch += 1) {
      try {
        const response = await fetch(`${env.apiInternalUrl}/api/internal/armor`, {
          headers: { 'x-internal-key': env.internalKey },
          signal: AbortSignal.timeout(3000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = (await response.json()) as { armor?: ArmorStats[] };
        if (!Array.isArray(data.armor) || data.armor.length === 0) throw new Error('leer');

        for (const armor of data.armor) this.stats.set(armor.itemId, armor);
        console.log(`[game-server] Panzerungskatalog geladen: ${data.armor.length} Stufen.`);
        return;
      } catch (error) {
        if (versuch === ANLAEUFE) {
          console.warn(
            `[game-server] Panzerungskatalog nach ${ANLAEUFE} Anläufen nicht abrufbar ` +
              `(${String(error)}) — Standardwerte aktiv.`,
          );
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }

  /**
   * Werte zu einer Item-Kennung. `null` bei fehlender oder unbekannter Kennung —
   * das ist der ungepanzerte Fall und braucht keine Sonderbehandlung: eine
   * erfundene Kennung aus einem manipulierten Ticket findet hier nichts und
   * wirkt damit wie gar keine Panzerung.
   */
  get(itemId: string | null | undefined): ArmorStats | null {
    if (!itemId) return null;
    return this.stats.get(itemId) ?? null;
  }
}
