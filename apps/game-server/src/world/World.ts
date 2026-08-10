import type {
  ExitPoint,
  GameMap,
  PlayerId,
  ProjectileState,
  SpawnPoint,
  VesselModel,
} from '@subwarfare/shared';
import { DEFAULT_VESSEL_MODEL, DEG, HULL_DIMENSIONS, TORPEDO, Vessel } from '@subwarfare/shared';
import type { ShipCatalog } from '../sim/ShipCatalog.js';

/**
 * Ein laufender Torpedo. Lebt NUR auf dem Server — der Client bekommt pro
 * Broadcast eine `ProjectileState`-Momentaufnahme und interpoliert dazwischen,
 * gerechnet wird ausschließlich hier.
 */
interface Projectile {
  id: string;
  /** Wer ihn abgefeuert hat — der Schütze trifft sich nicht selbst. */
  ownerId: PlayerId;
  model: string;
  x: number;
  y: number;
  /** Laufrichtung in Grad, fest ab Abschuss (Geradeauslauf). */
  rotation: number;
  speed: number;
  damage: number;
  hitRadius: number;
  /** Zurückgelegte Strecke — ab `rangeMetres` ist er ein Blindgänger. */
  travelled: number;
  rangeMetres: number;
}

/** Was ein Simulationsschritt an Kampfereignissen hervorgebracht hat. */
export interface WorldEvents {
  /** Einschläge (Torpedo trifft Rumpf) an ihren Weltpunkten. */
  impacts: Array<{ x: number; y: number }>;
  /** Versenkte Fahrzeuge. Sie stehen noch in der Welt — entfernen entscheidet der Aufrufer. */
  destroyed: Array<{ id: PlayerId; x: number; y: number }>;
}

/**
 * Die laufende Instanz einer Karte: statische Definition plus alle Fahrzeuge,
 * die gerade darin unterwegs sind — Spieler wie Bots — und alle Projektile.
 *
 * Diese Welt ist die **Quelle der Wahrheit**. Was davon ein Client zu sehen
 * bekommt, entscheidet die Sichtbarkeitsfilterung im GameServer; Befehle laufen
 * ausschließlich über `orderMoveTo` und `setTelegraph` der Fahrzeuge, und beide
 * Werte klemmt der Aufrufer vorher. Auch der Abschuss ist nur eine Absicht:
 * `fireTorpedo` rechnet Position und Richtung selbst aus dem Schützen.
 */
export class World {
  readonly map: GameMap;

  private readonly vessels = new Map<PlayerId, Vessel>();
  /** Lebenspunkte je Fahrzeug — Quelle: ships-Tabelle über den Katalog. */
  private readonly hitpoints = new Map<PlayerId, number>();
  private readonly projectiles = new Map<string, Projectile>();
  private nextSpawnIndex = 0;
  private nextProjectileId = 1;

  constructor(
    map: GameMap,
    private readonly ships: ShipCatalog,
  ) {
    this.map = map;
  }

  get count(): number {
    return this.vessels.size;
  }

  /** Legt ein Fahrzeug auf dem nächsten freien Spawnpunkt an. */
  spawn(id: PlayerId, name: string, model: VesselModel = DEFAULT_VESSEL_MODEL): Vessel {
    const point = this.pickSpawnPoint();
    const vessel = new Vessel(
      { id, name, model, x: point.x, y: point.y, rotation: point.rotation },
      this.ships.profile(model),
    );
    this.vessels.set(id, vessel);
    this.hitpoints.set(id, this.ships.get(model).hp);
    return vessel;
  }

  /** Legt ein Fahrzeug an einer bestimmten Stelle an — für Bots. */
  spawnAt(
    id: PlayerId,
    name: string,
    model: VesselModel,
    x: number,
    y: number,
    rotation: number,
  ): Vessel {
    const vessel = new Vessel({ id, name, model, x, y, rotation }, this.ships.profile(model));
    this.vessels.set(id, vessel);
    this.hitpoints.set(id, this.ships.get(model).hp);
    return vessel;
  }

  remove(id: PlayerId): boolean {
    this.hitpoints.delete(id);
    return this.vessels.delete(id);
  }

  get(id: PlayerId): Vessel | undefined {
    return this.vessels.get(id);
  }

  all(): IterableIterator<Vessel> {
    return this.vessels.values();
  }

  /** Restliche Lebenspunkte eines Fahrzeugs. */
  hp(id: PlayerId): number {
    return this.hitpoints.get(id) ?? 0;
  }

  /** Setzt die Lebenspunkte auf das Maximum des aktuellen Modells — Modellwechsel. */
  resetHp(id: PlayerId): void {
    const vessel = this.vessels.get(id);
    if (vessel) this.hitpoints.set(id, this.ships.get(vessel.model).hp);
  }

  /**
   * Momentaufnahmen aller Projektile für den Broadcast — bewusst neu gebaute
   * Objekte OHNE Innereien: `ownerId` oder Schadenswerte im Netzverkehr wären
   * genau die Aufklärung, die das Protokoll nicht hergeben soll.
   */
  projectileStates(): ProjectileState[] {
    const states: ProjectileState[] = [];
    for (const p of this.projectiles.values()) {
      states.push({ id: p.id, model: p.model, x: p.x, y: p.y, rotation: p.rotation });
    }
    return states;
  }

  /**
   * Torpedoabschuss: läuft vom Bug des Schützen geradeaus in dessen Kurs.
   * Berechtigung (Bewaffnung, Munition, Sperre) prüft der Aufrufer — hier
   * entsteht nur die Physik.
   */
  fireTorpedo(shooter: Vessel): void {
    const dims = HULL_DIMENSIONS[shooter.model] ?? HULL_DIMENSIONS[DEFAULT_VESSEL_MODEL];
    const heading = shooter.rotation * DEG;
    // Kurz VOR dem Bug, damit der erste Kollisionstest nicht den eigenen —
    // ohnehin ausgenommenen — Rumpf streift.
    const offset = dims.length / 2 + TORPEDO.hitRadius * 2;

    const projectile: Projectile = {
      id: `t-${this.nextProjectileId++}`,
      ownerId: shooter.id,
      model: TORPEDO.model,
      x: shooter.x + Math.sin(heading) * offset,
      y: shooter.y - Math.cos(heading) * offset,
      rotation: shooter.rotation,
      speed: TORPEDO.speed,
      damage: TORPEDO.damage,
      hitRadius: TORPEDO.hitRadius,
      travelled: 0,
      rangeMetres: TORPEDO.rangeMetres,
    };
    this.projectiles.set(projectile.id, projectile);
  }

  /** Reihum der nächste Spawnpunkt, damit sich Spieler nicht stapeln. */
  pickSpawnPoint(): SpawnPoint {
    const spawn = this.map.spawnPoints[this.nextSpawnIndex % this.map.spawnPoints.length];
    this.nextSpawnIndex += 1;
    return spawn as SpawnPoint;
  }

  /** Begrenzt einen Punkt auf die Karte. Gilt für jeden Befehl von außen. */
  clampToMap(x: number, y: number): { x: number; y: number } {
    return {
      x: Math.min(Math.max(x, 0), this.map.width),
      y: Math.min(Math.max(y, 0), this.map.height),
    };
  }

  /** Exit-Zone, in der sich der Punkt gerade befindet — sonst `undefined`. */
  findExitPointAt(x: number, y: number): ExitPoint | undefined {
    return this.map.exitPoints.find((exit) => {
      const dx = exit.x - x;
      const dy = exit.y - y;
      return dx * dx + dy * dy <= exit.radius * exit.radius;
    });
  }

  /**
   * Ein Simulationsschritt mit festem `dt` für Fahrzeuge und Projektile.
   * Liefert die Kampfereignisse des Schritts — der GameServer macht daraus
   * fx-Meldungen, Versenkungen und Respawns.
   */
  update(deltaSeconds: number): WorldEvents {
    for (const vessel of this.vessels.values()) vessel.simulate(deltaSeconds);

    const events: WorldEvents = { impacts: [], destroyed: [] };
    /** In DIESEM Schritt versenkt — ein Wrack fängt keinen zweiten Torpedo. */
    const sunkThisStep = new Set<PlayerId>();

    for (const projectile of this.projectiles.values()) {
      const step = projectile.speed * deltaSeconds;
      const heading = projectile.rotation * DEG;
      projectile.x += Math.sin(heading) * step;
      projectile.y -= Math.cos(heading) * step;
      projectile.travelled += step;

      const victim = this.findHit(projectile, sunkThisStep);
      if (victim) {
        events.impacts.push({ x: projectile.x, y: projectile.y });
        this.projectiles.delete(projectile.id);

        const remaining = (this.hitpoints.get(victim.id) ?? 0) - projectile.damage;
        this.hitpoints.set(victim.id, Math.max(remaining, 0));
        if (remaining <= 0) {
          sunkThisStep.add(victim.id);
          events.destroyed.push({ id: victim.id, x: victim.x, y: victim.y });
        }
        continue;
      }

      // Blindgänger: Laufstrecke erschöpft oder weit hinter dem Kartenrand.
      if (
        projectile.travelled >= projectile.rangeMetres ||
        projectile.x < -500 ||
        projectile.y < -500 ||
        projectile.x > this.map.width + 500 ||
        projectile.y > this.map.height + 500
      ) {
        this.projectiles.delete(projectile.id);
      }
    }

    return events;
  }

  /**
   * Kollision Projektil ↔ Rumpf.
   *
   * Der Rumpf ist eine KAPSEL: Strecke der Länge (length − beam) längs des
   * Kurses, verdickt um beam/2 — Bug und Heck enden damit in Halbkreisen.
   * Getestet wird die aktuelle Projektilposition gegen diese Strecke; bei
   * 45 m/s und 20 Ticks/s legt ein Torpedo 2,25 m pro Schritt zurück, deutlich
   * weniger als jeder Trefferradius — Durchtunneln ist damit ausgeschlossen.
   *
   * v1 ignoriert die Tauchtiefe: ein Torpedo trifft auch ein getauchtes Boot.
   * Tiefeneinstellung am Torpedo ist ein späteres Feature.
   */
  private findHit(projectile: Projectile, exclude: Set<PlayerId>): Vessel | null {
    for (const vessel of this.vessels.values()) {
      if (vessel.id === projectile.ownerId || exclude.has(vessel.id)) continue;

      const dims = HULL_DIMENSIONS[vessel.model] ?? HULL_DIMENSIONS[DEFAULT_VESSEL_MODEL];
      const reach = dims.beam / 2 + projectile.hitRadius;

      // Billiger Vorfilter: außerhalb des umschließenden Kreises kann nichts
      // treffen. Läuft für jedes Paar aus Projektil und Fahrzeug pro Tick.
      const dx = projectile.x - vessel.x;
      const dy = projectile.y - vessel.y;
      const outer = dims.length / 2 + projectile.hitRadius;
      if (dx * dx + dy * dy > outer * outer) continue;

      const heading = vessel.rotation * DEG;
      const axisX = Math.sin(heading);
      const axisY = -Math.cos(heading);
      const half = Math.max(dims.length / 2 - dims.beam / 2, 0);

      // Projektion auf die Rumpfachse, geklemmt auf die Strecke.
      const along = Math.min(Math.max(dx * axisX + dy * axisY, -half), half);
      const nearestX = vessel.x + axisX * along;
      const nearestY = vessel.y + axisY * along;
      const ox = projectile.x - nearestX;
      const oy = projectile.y - nearestY;
      if (ox * ox + oy * oy <= reach * reach) return vessel;
    }
    return null;
  }
}
