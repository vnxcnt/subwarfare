import { TELEGRAPH_CRUISE } from '@subwarfare/shared';
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
  private readonly ids: string[] = [];

  constructor(
    private readonly world: World,
    count: number,
  ) {
    for (let i = 0; i < count; i += 1) {
      const id = `bot-${i + 1}`;
      const name = NAMES[i % NAMES.length] as string;
      const vessel = this.world.spawnAt(
        id,
        name,
        randomBetween(MARGIN, world.map.width - MARGIN),
        randomBetween(MARGIN, world.map.height - MARGIN),
        Math.random() * 360,
      );
      vessel.setTelegraph(TELEGRAPH_CRUISE);
      this.ids.push(id);
    }
  }

  /** Läuft einmal pro Tick — vergibt neue Ziele an alle, die angekommen sind. */
  update(): void {
    for (const id of this.ids) {
      const vessel = this.world.get(id);
      if (!vessel || vessel.waypoint) continue;
      vessel.orderMoveTo(
        randomBetween(MARGIN, this.world.map.width - MARGIN),
        randomBetween(MARGIN, this.world.map.height - MARGIN),
      );
    }
  }
}

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}
