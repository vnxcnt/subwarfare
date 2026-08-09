import type { GameMap } from '@subwarfare/shared';
import { PATROL_MARGIN } from '../config';
import type { Vessel } from './entities/Vessel';

/**
 * Hält die Demo-Kontakte in Bewegung: wer sein Ziel erreicht hat, bekommt ein
 * neues Zufallsziel. Mehr ist es nicht — keine Verfolgung, keine Ausweichlogik.
 *
 * `Math.random()` steht bewusst HIER und nicht im Fahrmodell in
 * `@subwarfare/shared`: das muss deterministisch bleiben, damit Client und
 * Server später dieselben Schritte rechnen können.
 */
export class DemoTraffic {
  private readonly vessels: Vessel[] = [];

  add(vessel: Vessel): void {
    this.vessels.push(vessel);
  }

  update(map: GameMap): void {
    for (const vessel of this.vessels) {
      if (vessel.waypoint) continue;
      vessel.orderMoveTo(
        randomBetween(PATROL_MARGIN, map.width - PATROL_MARGIN),
        randomBetween(PATROL_MARGIN, map.height - PATROL_MARGIN),
      );
    }
  }
}

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}
