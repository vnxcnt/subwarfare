import type { ShipStats, VesselModel, VesselProfile } from '@subwarfare/shared';
import { DEFAULT_SHIP_STATS, DESTROYER, profileForShip } from '@subwarfare/shared';
import { env } from '../env.js';

/**
 * Schiffskatalog des Spielservers.
 *
 * Die Wahrheit liegt in der `ships`-Tabelle, aber der Spielserver bleibt
 * bewusst datenbankfrei: er holt den Katalog beim Start EINMAL über den
 * internen Kanal des Backends (derselbe Schlüssel wie dessen Statusabfrage in
 * Gegenrichtung). Ist das Backend nicht erreichbar, gelten die DEFAULTS aus
 * shared — dieselben Zahlen wie der Migrations-Seed, der Betrieb reißt nicht
 * ab. Änderungen an der Tabelle greifen mit dem nächsten Neustart.
 */
export class ShipCatalog {
  private stats = new Map<VesselModel, ShipStats>(
    Object.entries(DEFAULT_SHIP_STATS) as [VesselModel, ShipStats][],
  );
  private readonly profiles = new Map<VesselModel, VesselProfile>();

  /**
   * Mit Wiederholung: beim Deploy starten api und Spielserver GLEICHZEITIG
   * (`systemctl restart` ordnet nicht nach Port-Bereitschaft) — der erste
   * Versuch verliert das Rennen fast immer. Fünf Anläufe über ~10 s decken
   * jeden realistischen api-Start ab; danach gelten die Standardwerte.
   */
  async load(): Promise<void> {
    const ANLAEUFE = 5;
    for (let versuch = 1; versuch <= ANLAEUFE; versuch += 1) {
      try {
        const response = await fetch(`${env.apiInternalUrl}/api/internal/ships`, {
          headers: { 'x-internal-key': env.internalKey },
          signal: AbortSignal.timeout(3000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = (await response.json()) as { ships?: ShipStats[] };
        if (!Array.isArray(data.ships) || data.ships.length === 0) throw new Error('leer');

        for (const ship of data.ships) this.stats.set(ship.model, ship);
        this.profiles.clear();
        console.log(`[game-server] Schiffskatalog geladen: ${data.ships.length} Modelle.`);
        return;
      } catch (error) {
        if (versuch === ANLAEUFE) {
          console.warn(
            `[game-server] Schiffskatalog nach ${ANLAEUFE} Anläufen nicht abrufbar ` +
              `(${String(error)}) — Standardwerte aktiv.`,
          );
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }

  get(model: VesselModel): ShipStats {
    return this.stats.get(model) ?? DEFAULT_SHIP_STATS[model];
  }

  /** Alle Werte für die `welcome` an den Client. */
  all(): ShipStats[] {
    return [...this.stats.values()];
  }

  /** Fahrprofil eines Modells — gecacht, die Objekte sind unveränderlich. */
  profile(model: VesselModel): VesselProfile {
    let profile = this.profiles.get(model);
    if (!profile) {
      profile = profileForShip(DESTROYER, this.get(model));
      this.profiles.set(model, profile);
    }
    return profile;
  }
}
