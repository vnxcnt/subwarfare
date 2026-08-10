import type { VesselModel } from '@subwarfare/shared';
import { BOT_RESPAWN_SECONDS, TELEGRAPH_CRUISE } from '@subwarfare/shared';
import type { World } from '../world/World.js';

const NAMES = [
  'Kontakt Alpha',
  'Kontakt Bravo',
  'Kontakt Charlie',
  'Kontakt Delta',
  'Kontakt Echo',
  'Kontakt Foxtrot',
  'Kontakt Golf',
  'Kontakt Hotel',
];

/** Zufallsziele bleiben in diesem Abstand zum Kartenrand. */
const MARGIN = 600;

/** Bots fahren die NPC-Schiffe aus der ships-Tabelle (Typ 1). */
const NPC_MODELS: VesselModel[] = ['speedster01', 'yachtgun01', 'tanker01'];

/**
 * Fremdverkehr, damit die Karte nicht leer ist und das Sonar etwas anzeigt.
 *
 * Bewusst keine KI: wer sein Ziel erreicht hat, bekommt ein neues Zufallsziel.
 * Es sind echte Fahrzeuge mit derselben Physik wie Spielerboote — später
 * ersetzen sie sich schlicht durch echte Spieler, ohne dass am Client etwas
 * geändert werden muss.
 *
 * `Math.random()` steht HIER und nicht im Fahrmodell: das muss deterministisch
 * bleiben, damit Client und Server dieselben Schritte rechnen können.
 */
export class Bots {
  private readonly entries = new Map<string, { name: string; model: VesselModel }>();
  /** Versenkte Bots und ihre Restwartezeit bis zum Wiedereinstieg. */
  private readonly pending = new Map<string, number>();

  constructor(
    private readonly world: World,
    count: number,
  ) {
    for (let i = 0; i < count; i += 1) {
      const id = `bot-${i + 1}`;
      const name = NAMES[i % NAMES.length] as string;
      const model = NPC_MODELS[i % NPC_MODELS.length] as VesselModel;
      this.entries.set(id, { name, model });
      this.spawn(id);
    }
  }

  /**
   * Meldung des GameServers: dieser Bot wurde versenkt (und ist bereits aus
   * der Welt entfernt). Er kehrt nach einer Wartezeit an neuer Stelle zurück.
   */
  notifyDestroyed(id: string): void {
    if (this.entries.has(id)) this.pending.set(id, BOT_RESPAWN_SECONDS);
  }

  /** Läuft einmal pro Tick — neue Ziele für Angekommene, Respawns für Versenkte. */
  update(deltaSeconds: number): void {
    for (const [id, secondsLeft] of this.pending) {
      const remaining = secondsLeft - deltaSeconds;
      if (remaining > 0) {
        this.pending.set(id, remaining);
        continue;
      }
      this.pending.delete(id);
      this.spawn(id);
    }

    for (const id of this.entries.keys()) {
      const vessel = this.world.get(id);
      if (!vessel || vessel.waypoint) continue;
      vessel.orderMoveTo(
        randomBetween(MARGIN, this.world.map.width - MARGIN),
        randomBetween(MARGIN, this.world.map.height - MARGIN),
      );
    }
  }

  private spawn(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    const vessel = this.world.spawnAt(
      id,
      entry.name,
      entry.model,
      randomBetween(MARGIN, this.world.map.width - MARGIN),
      randomBetween(MARGIN, this.world.map.height - MARGIN),
      Math.random() * 360,
    );
    vessel.setTelegraph(TELEGRAPH_CRUISE);
  }
}

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}
