import type {
  ExitPoint,
  GameMap,
  PlayerId,
  ProjectileState,
  SpawnPoint,
  VesselModel,
} from '@subwarfare/shared';
import {
  DAMAGE,
  DECOY,
  DEFAULT_VESSEL_MODEL,
  DEG,
  GUN,
  HULL_DIMENSIONS,
  SHIP_TYPE_SUBMARINE,
  TORPEDO,
  Vessel,
  norm360,
  smokeLevelForHp,
} from '@subwarfare/shared';
import type { ShipCatalog } from '../sim/ShipCatalog.js';

/**
 * Ein laufendes Projektil. Lebt NUR auf dem Server — der Client bekommt pro
 * Broadcast eine `ProjectileState`-Momentaufnahme und interpoliert dazwischen,
 * gerechnet wird ausschließlich hier.
 *
 * Zwei Arten: Der **Torpedo** trifft Schiffsrümpfe. Der **Täuschkörper**
 * trifft nichts — aber ein Torpedo, der ihm zu nahe kommt, detoniert mitsamt
 * ihm (Annäherungszündung, beide weg).
 */
interface Projectile {
  id: string;
  kind: 'torpedo' | 'decoy' | 'shell';
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
    if (!vessel) return;
    this.hitpoints.set(id, this.ships.get(vessel.model).hp);
    // Frische HP = frisches Schiff: kein Rauch mehr. Das Fahrprofil setzt der
    // Aufrufer (dev:model) ohnehin neu — die Drossel fällt damit mit.
    vessel.smoke = 0;
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
  /**
   * Gemeinsamer Abschuss: spawnt ein Projektil `offsetMetres` vom Schützen
   * entfernt in `bearingDegrees` und lässt es geradeaus laufen. Berechtigung
   * und Sektorprüfung liegen beim Aufrufer (GameServer) — hier entsteht nur
   * die Physik.
   */
  private launch(
    shooter: Vessel,
    kind: Projectile['kind'],
    model: string,
    bearingDegrees: number,
    offsetMetres: number,
    speed: number,
    damage: number,
    hitRadius: number,
    rangeMetres: number,
  ): void {
    const bearing = norm360(bearingDegrees);
    const heading = bearing * DEG;
    const projectile: Projectile = {
      id: `t-${this.nextProjectileId++}`,
      kind,
      ownerId: shooter.id,
      model,
      x: shooter.x + Math.sin(heading) * offsetMetres,
      y: shooter.y - Math.cos(heading) * offsetMetres,
      rotation: bearing,
      speed,
      damage,
      hitRadius,
      travelled: 0,
      rangeMetres,
    };
    this.projectiles.set(projectile.id, projectile);
  }

  /** U-Boot: Torpedo aus dem Bugrohr, geradeaus in Kursrichtung. */
  fireTorpedo(shooter: Vessel): void {
    const dims = HULL_DIMENSIONS[shooter.model] ?? HULL_DIMENSIONS[DEFAULT_VESSEL_MODEL];
    // Kurz VOR dem Bug, damit der erste Kollisionstest nicht den eigenen —
    // ohnehin ausgenommenen — Rumpf streift.
    this.launch(
      shooter, 'torpedo', TORPEDO.model, shooter.rotation,
      dims.length / 2 + TORPEDO.hitRadius * 2,
      TORPEDO.speed, TORPEDO.damage, TORPEDO.hitRadius, TORPEDO.rangeMetres,
    );
  }

  /**
   * U-Boot: Täuschkörper nach ACHTERN — er läuft entgegen dem Kurs davon,
   * dorthin, wo verfolgende Torpedos herkommen.
   */
  fireDecoy(shooter: Vessel): void {
    const dims = HULL_DIMENSIONS[shooter.model] ?? HULL_DIMENSIONS[DEFAULT_VESSEL_MODEL];
    this.launch(
      shooter, 'decoy', DECOY.model, shooter.rotation + 180,
      dims.length / 2 + DECOY.triggerRadius * 0.2,
      DECOY.speed, 0, 0, DECOY.rangeMetres,
    );
  }

  /** Überwasserschiff: Torpedo über die SEITE abgeworfen, in Zielpeilung. */
  fireTorpedoSide(shooter: Vessel, bearingDegrees: number): void {
    const dims = HULL_DIMENSIONS[shooter.model] ?? HULL_DIMENSIONS[DEFAULT_VESSEL_MODEL];
    this.launch(
      shooter, 'torpedo', TORPEDO.model, bearingDegrees,
      dims.beam / 2 + TORPEDO.hitRadius * 2,
      TORPEDO.speed, TORPEDO.damage, TORPEDO.hitRadius, TORPEDO.rangeMetres,
    );
  }

  /** Überwasserschiff: Täuschkörper über die SEITE, in Zielpeilung. */
  fireDecoySide(shooter: Vessel, bearingDegrees: number): void {
    const dims = HULL_DIMENSIONS[shooter.model] ?? HULL_DIMENSIONS[DEFAULT_VESSEL_MODEL];
    this.launch(
      shooter, 'decoy', DECOY.model, bearingDegrees,
      dims.beam / 2 + DECOY.triggerRadius * 0.2,
      DECOY.speed, 0, 0, DECOY.rangeMetres,
    );
  }

  /**
   * Geschützgranate in Zielpeilung — Sektorprüfung liegt beim GameServer.
   * Kleiner Spawn-Offset (Beam-basiert wie die Seitwerfer): der Schütze ist
   * in der Kollision ohnehin ausgenommen, und ein length/2-Offset (72 m bei
   * der Fregatte) machte alles Nähere prinzipiell unbeschießbar.
   */
  fireShell(shooter: Vessel, bearingDegrees: number): void {
    const dims = HULL_DIMENSIONS[shooter.model] ?? HULL_DIMENSIONS[DEFAULT_VESSEL_MODEL];
    this.launch(
      shooter, 'shell', GUN.model, bearingDegrees,
      dims.beam / 2 + GUN.hitRadius * 2,
      GUN.speed, GUN.damage, GUN.hitRadius, GUN.rangeMetres,
    );
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

    // 1) Bewegen; Blindgänger (Laufstrecke erschöpft, weit hinterm Kartenrand)
    //    verschwinden lautlos.
    for (const projectile of this.projectiles.values()) {
      const step = projectile.speed * deltaSeconds;
      const heading = projectile.rotation * DEG;
      projectile.x += Math.sin(heading) * step;
      projectile.y -= Math.cos(heading) * step;
      projectile.travelled += step;

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

    // 2) Annäherungszündung VOR dem Rumpftreffer: der Täuschkörper soll den
    //    Torpedo abfangen, BEVOR der im selben Schritt noch ein Schiff trifft.
    //    Bewusst ohne Schützen-Ausnahme — ein Täuschkörper unterscheidet nicht,
    //    wessen Torpedo ihm zu nahe kommt.
    let torpedoes: Projectile[] | null = null;
    let decoys: Projectile[] | null = null;
    for (const projectile of this.projectiles.values()) {
      if (projectile.kind === 'torpedo') (torpedoes ??= []).push(projectile);
      else if (projectile.kind === 'decoy') (decoys ??= []).push(projectile);
      // Granaten interessieren den Täuschkörper nicht — sie fliegen durch.
    }
    if (torpedoes && decoys) {
      const trigger = DECOY.triggerRadius * DECOY.triggerRadius;
      for (const torpedo of torpedoes) {
        for (const decoy of decoys) {
          if (!this.projectiles.has(torpedo.id) || !this.projectiles.has(decoy.id)) continue;
          const dx = torpedo.x - decoy.x;
          const dy = torpedo.y - decoy.y;
          if (dx * dx + dy * dy <= trigger) {
            // Beide detonieren — zwei Einschläge, kein Schaden an Schiffen.
            events.impacts.push({ x: torpedo.x, y: torpedo.y });
            events.impacts.push({ x: decoy.x, y: decoy.y });
            this.projectiles.delete(torpedo.id);
            this.projectiles.delete(decoy.id);
          }
        }
      }
    }

    // 3) Rumpftreffer — Torpedos und Granaten; Täuschkörper treffen nichts.
    for (const projectile of this.projectiles.values()) {
      if (projectile.kind === 'decoy') continue;

      // Granaten machen 6-m-Schritte (120 m/s) — der Mittelpunkt des Schritts
      // wird mitgetestet, sonst rutschen Streiftreffer an den Kapselkappen
      // zwischen zwei Ticks hindurch.
      let victim = this.findHit(projectile, sunkThisStep, projectile.x, projectile.y);
      if (!victim && projectile.kind === 'shell') {
        const heading = projectile.rotation * DEG;
        const half = (projectile.speed * deltaSeconds) / 2;
        victim = this.findHit(
          projectile,
          sunkThisStep,
          projectile.x - Math.sin(heading) * half,
          projectile.y + Math.cos(heading) * half,
        );
      }
      if (!victim) continue;

      events.impacts.push({ x: projectile.x, y: projectile.y });
      this.projectiles.delete(projectile.id);

      const remaining = (this.hitpoints.get(victim.id) ?? 0) - projectile.damage;
      this.hitpoints.set(victim.id, Math.max(remaining, 0));
      if (remaining <= 0) {
        sunkThisStep.add(victim.id);
        events.destroyed.push({ id: victim.id, x: victim.x, y: victim.y });
      } else {
        this.applyDamageEffects(victim, remaining);
      }
    }

    return events;
  }

  /**
   * Schadensfolgen nach einem überlebten Treffer: Rauchstufe für alle
   * sichtbar in den Broadcast, unter der Drossel-Schwelle nur noch halbe
   * Fahrt, und ein schwer beschädigtes U-Boot wird zwangsaufgetaucht (den
   * erneuten Tauchbefehl blockt der GameServer am order:dive-Handler).
   */
  private applyDamageEffects(vessel: Vessel, hp: number): void {
    const stats = this.ships.get(vessel.model);
    vessel.smoke = smokeLevelForHp(hp, stats.hp);

    if (hp < stats.hp * DAMAGE.slowHpRatio) {
      const base = this.ships.profile(vessel.model);
      vessel.applyProfile({
        ...base,
        maxForward: base.maxForward * DAMAGE.slowFactor,
        maxReverse: base.maxReverse * DAMAGE.slowFactor,
      });
    }

    if (stats.type === SHIP_TYPE_SUBMARINE && hp < stats.hp * DAMAGE.surfaceHpRatio) {
      vessel.orderDive(false);
      vessel.orderPeriscope(false);
    }
  }

  /**
   * Kollision Projektil ↔ Rumpf.
   *
   * Der Rumpf ist eine KAPSEL: Strecke der Länge (length − beam) längs des
   * Kurses, verdickt um beam/2 — Bug und Heck enden damit in Halbkreisen.
   * Getestet wird die aktuelle Projektilposition gegen diese Strecke; bei
   * 67,5 m/s und 20 Ticks/s legt ein Torpedo ~3,4 m pro Schritt zurück —
   * weniger als der kleinste Kapseldurchmesser (speedster01: 9 m), ein
   * Schritt kann die Kapsel also nicht überspringen. Wer die Torpedo-
   * geschwindigkeit weiter erhöht, muss hier auf Streckentest umbauen.
   *
   * v1 ignoriert die Tauchtiefe für TORPEDOS (Tiefeneinstellung ist ein
   * späteres Feature). Die GRANATE dagegen ist eine Überwasserwaffe: mehr
   * als halb getauchte Boote fliegt sie über — Tauchen schützt vorm Geschütz.
   */
  private findHit(
    projectile: Projectile,
    exclude: Set<PlayerId>,
    x: number,
    y: number,
  ): Vessel | null {
    for (const vessel of this.vessels.values()) {
      if (vessel.id === projectile.ownerId || exclude.has(vessel.id)) continue;
      if (projectile.kind === 'shell' && vessel.depth > 0.5) continue;

      const dims = HULL_DIMENSIONS[vessel.model] ?? HULL_DIMENSIONS[DEFAULT_VESSEL_MODEL];
      const reach = dims.beam / 2 + projectile.hitRadius;

      // Billiger Vorfilter: außerhalb des umschließenden Kreises kann nichts
      // treffen. Läuft für jedes Paar aus Projektil und Fahrzeug pro Tick.
      const dx = x - vessel.x;
      const dy = y - vessel.y;
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
      const ox = x - nearestX;
      const oy = y - nearestY;
      if (ox * ox + oy * oy <= reach * reach) return vessel;
    }
    return null;
  }
}
