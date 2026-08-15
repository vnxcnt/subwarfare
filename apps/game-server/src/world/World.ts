import type {
  ArmorHitKind,
  ArmorState,
  ArmorStats,
  CrateState,
  ExitPoint,
  GameMap,
  PlayerId,
  ProjectileState,
  SpawnPoint,
  VesselModel,
  VesselProfile,
  WeaponId,
} from '@subwarfare/shared';
import {
  COLLISION,
  DAMAGE,
  DECOY,
  DEFAULT_VESSEL_MODEL,
  DEG,
  DEPTH_CHARGE,
  GUN,
  HULL_DIMENSIONS,
  SHIP_TYPE_SUBMARINE,
  TORPEDO,
  Vessel,
  aimSpreadDeg,
  armorHitCost,
  norm360,
  salvoSpread,
  smokeLevelForHp,
  splitDamage,
  torusDelta,
  wrapCoord,
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
  kind: 'torpedo' | 'decoy' | 'shell' | 'depthcharge';
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
  /**
   * Nur Wasserbombe: Restsekunden bis zur Detonation. Läuft erst, wenn der
   * Wurf beendet ist — bis dahin `null`. Bei 0 detoniert sie mit
   * Flächenwirkung (`blastRadius`) statt als Blindgänger zu verschwinden.
   */
  fuseSeconds: number | null;
  /** Nur Wasserbombe: Wirkungsradius der Detonation in Metern. */
  blastRadius: number;
}

/**
 * Höchstabstand zweier Kollisionsproben entlang der Projektilbahn in Metern.
 * Muss klar unter dem kleinsten Trefferzonen-Durchmesser liegen (speedster01
 * gegen Granate: 8 m) — 3 m lässt selbst Streiftreffer an den Kapselkappen
 * nicht durchrutschen. Kostet bei 360 m/s sechs Proben pro Granate und Tick.
 */
const PROJECTILE_SAMPLE_SPACING = 3;

/**
 * Getragene Panzerung mit ihrer Resthaltbarkeit. Lebt NUR hier: sie gehört zum
 * laufenden Einsatz, nicht zum Konto — ein Untergang setzt sie zurück.
 */
interface ArmorSlot {
  stats: ArmorStats;
  /** Restintegrität in Prozent, 0..100. */
  integrity: number;
}

/** Projektilart → Waffen-Kennung, für den Schaden aus der geladenen Sorte. */
const WAFFE_ZU_KIND: Record<Projectile['kind'], WeaponId> = {
  torpedo: 'torpedo',
  decoy: 'taeuschkoerper',
  shell: 'geschuetz',
  depthcharge: 'wasserbombe',
};

/** Was ein Simulationsschritt an Kampfereignissen hervorgebracht hat. */
export interface WorldEvents {
  /** Einschläge (Torpedo trifft Rumpf) an ihren Weltpunkten. */
  impacts: Array<{ x: number; y: number }>;
  /**
   * Versenkte Fahrzeuge. Sie stehen noch in der Welt — entfernen entscheidet
   * der Aufrufer. `killerId` ist der Besitzer des tödlichen Projektils; null
   * nur, wenn der Schütze nicht mehr feststellbar ist.
   */
  destroyed: Array<{ id: PlayerId; x: number; y: number; killerId: PlayerId | null }>;
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
  /**
   * Panzerung je Fahrzeug. Fehlt der Eintrag, fährt es ungepanzert — das ist
   * der Normalfall (Bots, leerer Ausrüstungs-Slot) und braucht keinen
   * Platzhalter.
   */
  private readonly armor = new Map<PlayerId, ArmorSlot>();
  /**
   * Schaden je Fahrzeug und Waffe — er hängt an der geladenen MUNITIONSSORTE,
   * nicht an der Waffe allein. Fehlt ein Eintrag, gilt der Grundwert aus
   * `combat.ts` (Bots, Standardausstattung).
   *
   * Bewusst hier und nicht als Parameter an jeder `fire*`-Methode: die
   * Abschüsse laufen ohnehin alle durch `launch`, und fünf Signaturen um
   * denselben Wert zu erweitern hätte jede neue Waffe wieder mitgeschleppt.
   */
  private readonly weaponDamage = new Map<PlayerId, Partial<Record<WeaponId, number>>>();
  /**
   * Perk-modifiziertes Basisprofil je Fahrzeug. Fehlt der Eintrag, gilt das
   * Katalog-Profil des Modells. WICHTIG für die Schadensdrossel: sie baut das
   * Profil frisch aus der Basis — ohne diesen Merker verlöre der erste
   * Treffer unter der Drossel-Schwelle alle Perk-Wirkungen.
   */
  private readonly profileOverrides = new Map<PlayerId, VesselProfile>();
  private readonly projectiles = new Map<string, Projectile>();
  /**
   * Lootkisten. Der Inhalt (Coins) lebt NUR hier — der Broadcast trägt bloß
   * Kennung und Position, was drin ist, erfährt man beim Aufsammeln.
   */
  private readonly crates = new Map<string, { id: string; x: number; y: number; coins: number }>();
  private nextSpawnIndex = 0;
  private nextProjectileId = 1;
  private nextCrateId = 1;
  /**
   * Seegang der Karte, 0..1. Wirkt auf die Schussstreuung; gesetzt wird er
   * vom GameServer aus dem Karten-Wetter.
   */
  private seaState = 0;

  constructor(
    map: GameMap,
    private readonly ships: ShipCatalog,
  ) {
    this.map = map;
  }

  /** Seegang der Karte übernehmen (0..1) — steuert die Schussstreuung. */
  setSeaState(value: number): void {
    this.seaState = Math.min(Math.max(value, 0), 1);
  }

  get count(): number {
    return this.vessels.size;
  }

  /**
   * Legt ein Fahrzeug auf dem nächsten freien Spawnpunkt an.
   *
   * `armor` ist die getragene Panzerung aus dem Ticket (vom Aufrufer über den
   * Panzerungskatalog aufgelöst). Sie wird bei JEDEM Spawn frisch gesetzt —
   * auch beim Wiedereinstieg nach einer Versenkung: das Boot ist neu, die
   * Panzerung damit wieder ganz.
   */
  spawn(
    id: PlayerId,
    name: string,
    model: VesselModel = DEFAULT_VESSEL_MODEL,
    armor: ArmorStats | null = null,
    options?: {
      /** Perk-modifiziertes Profil — wird als Basis für die Drossel gemerkt. */
      profile?: VesselProfile;
      /** Start-HP (Rest-HP der Werft-Instanz). Geklemmt auf 1..maxHp. */
      hp?: number;
    },
  ): Vessel {
    const point = this.pickSpawnPoint();
    const profile = options?.profile ?? this.ships.profile(model);
    const vessel = new Vessel(
      { id, name, model, x: point.x, y: point.y, rotation: point.rotation },
      profile,
    );
    this.vessels.set(id, vessel);
    if (options?.profile) this.profileOverrides.set(id, options.profile);
    else this.profileOverrides.delete(id);

    const maxHp = this.ships.get(model).hp;
    // Unter 1 spawnt niemand (die api lässt HP 0 gar nicht auslaufen) und
    // über dem Modell-Maximum auch nicht (Rebalance-Schutz).
    const hp = Math.max(1, Math.min(Math.floor(options?.hp ?? maxHp), maxHp));
    this.hitpoints.set(id, hp);
    if (armor) this.armor.set(id, { stats: armor, integrity: 100 });
    else this.armor.delete(id);
    // Wer angeschlagen ausläuft, raucht und drosselt ab Sekunde eins — die
    // Folgen hängen an den HP, nicht an der Treffer-Geschichte.
    if (hp < maxHp) this.applyDamageEffects(vessel, hp);
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
    this.armor.delete(id);
    this.weaponDamage.delete(id);
    this.profileOverrides.delete(id);
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

  /**
   * Setzt den Schaden, den die Waffen dieses Fahrzeugs anrichten — abgeleitet
   * aus der geladenen Munitionssorte. Ein fehlender Wert lässt den Grundwert
   * der Waffe stehen.
   */
  setWeaponDamage(id: PlayerId, weapon: WeaponId, damage: number): void {
    const eintrag = this.weaponDamage.get(id) ?? {};
    eintrag[weapon] = damage;
    this.weaponDamage.set(id, eintrag);
  }

  /**
   * Panzerungszustand eines Fahrzeugs für dessen eigene Anzeige. `null`, wenn
   * es ungepanzert fährt — der Client blendet die Leiste dann aus.
   */
  armorState(id: PlayerId): ArmorState | null {
    const slot = this.armor.get(id);
    if (!slot) return null;
    return {
      itemId: slot.stats.itemId,
      level: slot.stats.level,
      percent: slot.integrity,
      absorb: slot.stats.absorb,
    };
  }

  /** Setzt die Lebenspunkte auf das Maximum des aktuellen Modells — Modellwechsel. */
  resetHp(id: PlayerId): void {
    const vessel = this.vessels.get(id);
    if (!vessel) return;
    this.hitpoints.set(id, this.ships.get(vessel.model).hp);
    // Der Entwickler-Modellwechsel wirft den Perk-Override ab — die Perks
    // gehören zur Werft-Instanz, nicht zum getauschten Modell (Dev-only).
    this.profileOverrides.delete(id);
    // Frisches Schiff heißt auch frische Panzerung — sonst führe der
    // Entwickler-Modellwechsel ein neues Boot mit aufgerissener Panzerung.
    const slot = this.armor.get(id);
    if (slot) slot.integrity = 100;
    // Frische HP = frisches Schiff: kein Rauch mehr. Das Fahrprofil setzt der
    // Aufrufer (dev:model) ohnehin neu — die Drossel fällt damit mit.
    vessel.smoke = 0;
  }

  /**
   * Lässt eine Lootkiste zu Wasser. Wertlose Kisten entstehen erst gar nicht —
   * eine leere Kiste anzusteuern wäre reine Enttäuschung.
   */
  spawnCrate(x: number, y: number, coins: number): void {
    if (coins <= 0) return;
    const id = `c-${this.nextCrateId++}`;
    // Einwrappen — die Testkiste des Dev-Menüs entsteht „voraus" und kann
    // damit hinter der Naht liegen.
    this.crates.set(id, {
      id,
      x: wrapCoord(x, this.map.width),
      y: wrapCoord(y, this.map.height),
      coins,
    });
  }

  /**
   * Sammelt alle Kisten im Aufsammelradius um das Fahrzeug ein und liefert die
   * Summe. Synchron und damit atomar gegenüber allen anderen Aufrufen im
   * selben Tick — zwei Schiffe können dieselbe Kiste nicht beide bekommen.
   */
  pickupCrates(vessel: Vessel, radius: number): number {
    let summe = 0;
    for (const crate of this.crates.values()) {
      const dx = torusDelta(vessel.x, crate.x, this.map.width);
      const dy = torusDelta(vessel.y, crate.y, this.map.height);
      if (dx * dx + dy * dy > radius * radius) continue;
      summe += crate.coins;
      this.crates.delete(crate.id);
    }
    return summe;
  }

  /** Momentaufnahmen der Kisten für den Broadcast — ohne Inhalt. */
  crateStates(): CrateState[] {
    const states: CrateState[] = [];
    for (const crate of this.crates.values()) {
      states.push({ id: crate.id, x: crate.x, y: crate.y });
    }
    return states;
  }

  /**
   * Momentaufnahmen aller Projektile für den Broadcast — bewusst neu gebaute
   * Objekte OHNE Innereien: `ownerId` oder Schadenswerte im Netzverkehr wären
   * genau die Aufklärung, die das Protokoll nicht hergeben soll.
   */
  projectileStates(): ProjectileState[] {
    const states: ProjectileState[] = [];
    for (const p of this.projectiles.values()) {
      const state: ProjectileState = {
        id: p.id,
        model: p.model,
        x: p.x,
        y: p.y,
        rotation: p.rotation,
      };
      // Sinkende Wasserbombe: der Fortschritt macht die Darstellung möglich
      // (Absacken, Verblassen) — ohne ihn sähe sie aus wie ein liegengebliebener
      // Torpedo.
      if (p.fuseSeconds !== null) {
        state.sink = Math.min(Math.max(1 - p.fuseSeconds / DEPTH_CHARGE.sinkSeconds, 0), 1);
      }
      states.push(state);
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
    blastRadius = 0,
  ): void {
    /*
     * Seegang-Streuung. Sie sitzt bewusst HIER: `launch` ist die einzige
     * Stelle, an der ein Projektil entsteht — Geschütz, Torpedo, Täuschkörper
     * und Wasserbombe bekommen die Wirkung damit zwangsläufig und gleich.
     *
     * Maßgeblich ist die Tiefe des SCHÜTZEN: ein getauchtes Boot rollt nicht.
     * `Math.random` ist hier zulässig (Server-Entscheidung, kein geteiltes
     * Fahrmodell) — dieselbe Regel wie bei den Bot-Zielen.
     */
    const streuung = aimSpreadDeg(this.seaState, shooter.depth);
    const abweichung = streuung > 0 ? (Math.random() * 2 - 1) * streuung : 0;
    const bearing = norm360(bearingDegrees + abweichung);
    // Schaden aus der geladenen Sorte, sonst der Grundwert der Waffe. Auch das
    // läuft hier zusammen, damit keine Abschussstelle es vergessen kann.
    const sorte = this.weaponDamage.get(shooter.id)?.[WAFFE_ZU_KIND[kind]];
    const wirkung = sorte ?? damage;
    const heading = bearing * DEG;
    const projectile: Projectile = {
      id: `t-${this.nextProjectileId++}`,
      kind,
      ownerId: shooter.id,
      model,
      // Direkt einwrappen: der Spawn-Offset kann über die Naht reichen, und
      // die Torus-Deltas erwarten Koordinaten in [0, Kante).
      x: wrapCoord(shooter.x + Math.sin(heading) * offsetMetres, this.map.width),
      y: wrapCoord(shooter.y - Math.cos(heading) * offsetMetres, this.map.height),
      rotation: bearing,
      speed,
      damage: wirkung,
      hitRadius,
      travelled: 0,
      rangeMetres,
      fuseSeconds: null,
      blastRadius,
    };
    this.projectiles.set(projectile.id, projectile);
  }

  /**
   * Überwasserschiff: Wasserbombe achteraus/seitlich in Zielpeilung. Sie fliegt
   * ihre kurze Strecke, bleibt dann liegen und sinkt bis zur Detonation —
   * Sektorprüfung liegt wie bei den anderen Waffen beim GameServer.
   */
  fireDepthCharge(shooter: Vessel, bearingDegrees: number): void {
    const dims = HULL_DIMENSIONS[shooter.model] ?? HULL_DIMENSIONS[DEFAULT_VESSEL_MODEL];
    this.launch(
      shooter, 'depthcharge', DEPTH_CHARGE.model, bearingDegrees,
      dims.beam / 2 + 4,
      DEPTH_CHARGE.speed, DEPTH_CHARGE.damage, 0, DEPTH_CHARGE.rangeMetres,
      DEPTH_CHARGE.blastRadius,
    );
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

  /**
   * Torpedo-SALVE aus mehreren Rohren: `count` Torpedos, gefächert um die
   * Zielpeilung. Der Abschussversatz richtet sich nach der Rohrlage — aus dem
   * Bug schießt es über die Rumpflänge, über die Seite über die Breite.
   */
  fireTorpedoSalvo(
    shooter: Vessel,
    bearingDegrees: number,
    count: number,
    laengs: boolean,
  ): void {
    const dims = HULL_DIMENSIONS[shooter.model] ?? HULL_DIMENSIONS[DEFAULT_VESSEL_MODEL];
    const offset = (laengs ? dims.length / 2 : dims.beam / 2) + TORPEDO.hitRadius * 2;
    for (const versatz of salvoSpread(count)) {
      this.launch(
        shooter, 'torpedo', TORPEDO.model, bearingDegrees + versatz, offset,
        TORPEDO.speed, TORPEDO.damage, TORPEDO.hitRadius, TORPEDO.rangeMetres,
      );
    }
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
   * Detonation der Wasserbombe: Flächenwirkung statt Berührungstreffer.
   *
   * Der Schaden fällt vom Zentrum zum Rand linear auf null. Anders als Torpedo
   * und Granate trifft sie AUCH GETAUCHTE Boote — das ist ihr ganzer Zweck.
   * Auch der Werfer selbst ist NICHT ausgenommen: wer seine eigene Bombe
   * überfährt, bekommt sie ab.
   */
  private detonate(
    charge: Projectile,
    events: WorldEvents,
    sunkThisStep: Set<PlayerId>,
  ): void {
    events.impacts.push({ x: charge.x, y: charge.y });

    for (const vessel of this.vessels.values()) {
      if (sunkThisStep.has(vessel.id)) continue;
      const dx = torusDelta(charge.x, vessel.x, this.map.width);
      const dy = torusDelta(charge.y, vessel.y, this.map.height);
      const distance = Math.hypot(dx, dy);
      if (distance > charge.blastRadius) continue;

      const anteil = 1 - distance / charge.blastRadius;
      const schaden = Math.round(charge.damage * anteil);
      if (schaden <= 0) continue;

      this.applyHit(vessel, schaden, 'wasserbombe', charge.ownerId, events, sunkThisStep);
    }
  }

  /**
   * Ein Treffer: Panzerung schluckt ihren Anteil, der Rest geht an den Rumpf.
   *
   * Reihenfolge mit Absicht — erst absorbieren, DANN die Integrität abziehen:
   * eine Panzerung mit 5 % Rest fängt diesen Treffer noch ab und ist danach
   * durch. Andersherum verpuffte der letzte Rest wirkungslos, und die Anzeige
   * „5 %" wäre eine Lüge.
   *
   * Bleibt nach der Absorption weniger als ein halber Trefferpunkt übrig,
   * kommt am Rumpf nichts an — die Panzerung hat den Schlag ganz geschluckt.
   * Ihre Integrität kostet es trotzdem.
   */
  private applyHit(
    vessel: Vessel,
    damage: number,
    kind: ArmorHitKind,
    killerId: PlayerId,
    events: WorldEvents,
    sunkThisStep: Set<PlayerId>,
  ): void {
    const slot = this.armor.get(vessel.id);
    const absorb = slot?.stats.absorb ?? 0;
    const integrity = slot?.integrity ?? 0;
    const { toHull } = splitDamage(damage, absorb, integrity);

    if (slot && slot.integrity > 0) {
      // Die Wasserbombe zählt nur gegen GETAUCHTE Boote — dieselbe Schwelle
      // wie beim Geschütz-Durchflug in findHit, damit „getaucht" im ganzen
      // Kampfsystem dasselbe heißt.
      const kosten = armorHitCost(kind, vessel.depth > 0.5);
      slot.integrity = Math.max(slot.integrity - kosten, 0);
    }

    const schaden = Math.round(toHull);
    if (schaden <= 0) return;

    const remaining = (this.hitpoints.get(vessel.id) ?? 0) - schaden;
    this.hitpoints.set(vessel.id, Math.max(remaining, 0));
    if (remaining <= 0) {
      sunkThisStep.add(vessel.id);
      events.destroyed.push({ id: vessel.id, x: vessel.x, y: vessel.y, killerId });
    } else {
      this.applyDamageEffects(vessel, remaining);
    }
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
      const dx = torusDelta(x, exit.x, this.map.width);
      const dy = torusDelta(y, exit.y, this.map.height);
      return dx * dx + dy * dy <= exit.radius * exit.radius;
    });
  }

  /**
   * Ein Simulationsschritt mit festem `dt` für Fahrzeuge und Projektile.
   * Liefert die Kampfereignisse des Schritts — der GameServer macht daraus
   * fx-Meldungen, Versenkungen und Respawns.
   */
  update(deltaSeconds: number): WorldEvents {
    for (const vessel of this.vessels.values()) {
      vessel.simulate(deltaSeconds);
      // ENDLOS-KARTE: die frühere Randwand ist weg — wer über eine Kante
      // fährt, kommt auf der Gegenseite wieder herein. Der Wegpunkt (Bots)
      // wandert dabei MIT über die Naht, sonst läge das Ziel plötzlich eine
      // Kartenlänge entfernt und der Autopilot drehte um.
      const rohX = vessel.x;
      const rohY = vessel.y;
      vessel.x = wrapCoord(vessel.x, this.map.width);
      vessel.y = wrapCoord(vessel.y, this.map.height);
      if (vessel.waypoint && (vessel.x !== rohX || vessel.y !== rohY)) {
        vessel.waypoint.x += vessel.x - rohX;
        vessel.waypoint.y += vessel.y - rohY;
      }
    }

    const events: WorldEvents = { impacts: [], destroyed: [] };
    /** In DIESEM Schritt versenkt — ein Wrack fängt keinen zweiten Torpedo. */
    const sunkThisStep = new Set<PlayerId>();
    // Beide werden von `detonate` (Schritt 1) mitbefüllt — deshalb stehen sie
    // vor der Projektilschleife.

    // 0b) Rammschaden: überlappende Rümpfe schleifen sich gegenseitig auf.
    this.applyCollisions(deltaSeconds, events, sunkThisStep);

    // 1) Bewegen; Blindgänger (Laufstrecke erschöpft, weit hinterm Kartenrand)
    //    verschwinden lautlos. Die Wasserbombe ist die Ausnahme: bei
    //    erschöpfter Wurfweite bleibt sie liegen und zündet ihren Sinkzünder.
    for (const projectile of this.projectiles.values()) {
      const sinking = projectile.fuseSeconds !== null;
      if (!sinking) {
        const step = projectile.speed * deltaSeconds;
        const heading = projectile.rotation * DEG;
        // Auch Munition fährt über die Naht — die Endlos-Karte kennt kein
        // „draußen" mehr; begrenzt wird nur noch über die Laufstrecke.
        projectile.x = wrapCoord(projectile.x + Math.sin(heading) * step, this.map.width);
        projectile.y = wrapCoord(projectile.y - Math.cos(heading) * step, this.map.height);
        projectile.travelled += step;
      }

      if (projectile.kind === 'depthcharge') {
        if (!sinking) {
          // Wurf beendet: ab hier sinkt sie an Ort und Stelle.
          if (projectile.travelled >= projectile.rangeMetres) {
            projectile.speed = 0;
            projectile.fuseSeconds = DEPTH_CHARGE.sinkSeconds;
          }
          continue;
        }
        projectile.fuseSeconds = (projectile.fuseSeconds ?? 0) - deltaSeconds;
        if (projectile.fuseSeconds > 0) continue;
        this.projectiles.delete(projectile.id);
        this.detonate(projectile, events, sunkThisStep);
        continue;
      }

      if (projectile.travelled >= projectile.rangeMetres) this.projectiles.delete(projectile.id);
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
    //    Die Flugbahn des Ticks wird als STRECKE geprüft: in Unterproben von
    //    höchstens PROJECTILE_SAMPLE_SPACING Metern, vom Schrittanfang zur
    //    aktuellen Position. Die Granate legt bei 360 m/s 18 m pro Tick
    //    zurück — mehr als der kleinste Trefferzonen-Durchmesser (8 m), ein
    //    reiner Endpunkt-Test flöge mitten durch Rümpfe hindurch.
    for (const projectile of this.projectiles.values()) {
      // Täuschkörper treffen nichts; die Wasserbombe wirkt erst bei der
      // Detonation (Fläche), nicht durch Berührung.
      if (projectile.kind === 'decoy' || projectile.kind === 'depthcharge') continue;

      const step = projectile.speed * deltaSeconds;
      const heading = projectile.rotation * DEG;
      const samples = Math.max(1, Math.ceil(step / PROJECTILE_SAMPLE_SPACING));

      let victim: Vessel | null = null;
      let hitX = projectile.x;
      let hitY = projectile.y;
      for (let i = samples - 1; i >= 0 && !victim; i -= 1) {
        // Rückwärts entlang des Schritts aufgelistet, geprüft wird von der
        // ÄLTESTEN Position aus — der erste Kontakt auf der Bahn gewinnt.
        const back = (step * i) / samples;
        const x = projectile.x - Math.sin(heading) * back;
        const y = projectile.y + Math.cos(heading) * back;
        victim = this.findHit(projectile, sunkThisStep, x, y);
        if (victim) {
          hitX = x;
          hitY = y;
        }
      }
      if (!victim) continue;

      events.impacts.push({ x: hitX, y: hitY });
      this.projectiles.delete(projectile.id);

      this.applyHit(
        victim,
        projectile.damage,
        projectile.kind === 'torpedo' ? 'torpedo' : 'geschuetz',
        projectile.ownerId,
        events,
        sunkThisStep,
      );
    }

    return events;
  }

  /**
   * Kollision Schiff ↔ Schiff: jedes überlappende Paar nimmt laufend Schaden.
   *
   * Regeln:
   * - Zwei Bots zermahlen sich NICHT gegenseitig — sonst prägte die Welt ohne
   *   Spielerzutun Lootkisten aus zufälligen NPC-Begegnungen.
   * - Getaucht (> 0.5) und Überwasser sind getrennte Ebenen; ein U-Boot fährt
   *   UNTER dem Tanker hindurch. Dieselbe Schwelle wie bei Geschütz und
   *   Wasserbombe, damit „getaucht" überall dasselbe heißt.
   * - Wer in diesem Schritt schon versenkt wurde, ist ein Wrack und reibt
   *   nicht weiter — sein Rammpartner nimmt den Schaden dieses Ticks noch,
   *   der Zusammenstoß war ja gleichzeitig.
   */
  private applyCollisions(
    deltaSeconds: number,
    events: WorldEvents,
    sunkThisStep: Set<PlayerId>,
  ): void {
    const list = [...this.vessels.values()];
    for (let i = 0; i < list.length; i += 1) {
      const a = list[i] as Vessel;
      for (let j = i + 1; j < list.length; j += 1) {
        const b = list[j] as Vessel;
        if (sunkThisStep.has(a.id) || sunkThisStep.has(b.id)) continue;
        if (istBot(a.id) && istBot(b.id)) continue;
        if (a.depth > 0.5 !== b.depth > 0.5) continue;
        if (!this.hullsOverlap(a, b)) continue;

        this.applyCollisionDamage(a, b.id, deltaSeconds, events, sunkThisStep);
        this.applyCollisionDamage(b, a.id, deltaSeconds, events, sunkThisStep);
      }
    }
  }

  /**
   * Berühren sich zwei Rümpfe? Beide sind KAPSELN (wie in `findHit`): Strecke
   * der Länge (length − beam) längs des Kurses, verdickt um beam/2 — Kontakt
   * heißt also Streckenabstand ≤ Summe der Halbbreiten.
   */
  private hullsOverlap(a: Vessel, b: Vessel): boolean {
    const da = HULL_DIMENSIONS[a.model] ?? HULL_DIMENSIONS[DEFAULT_VESSEL_MODEL];
    const db = HULL_DIMENSIONS[b.model] ?? HULL_DIMENSIONS[DEFAULT_VESSEL_MODEL];

    // Billiger Vorfilter über die umschließenden Kreise — Torus-Versatz, damit
    // sich zwei Schiffe auch ÜBER die Naht hinweg rammen können.
    const dx = torusDelta(a.x, b.x, this.map.width);
    const dy = torusDelta(a.y, b.y, this.map.height);
    const outer = (da.length + db.length) / 2;
    if (dx * dx + dy * dy > outer * outer) return false;

    // B in die NÄCHSTE Kopie relativ zu A gerückt — danach ist die
    // Kapsel-Mathematik wieder gewöhnliche Ebene.
    const bx = a.x + dx;
    const by = a.y + dy;

    const ha = Math.max(da.length / 2 - da.beam / 2, 0);
    const hb = Math.max(db.length / 2 - db.beam / 2, 0);
    const wa = a.rotation * DEG;
    const wb = b.rotation * DEG;
    const reach = da.beam / 2 + db.beam / 2;

    return (
      segmentDistanceSquared(
        a.x - Math.sin(wa) * ha, a.y + Math.cos(wa) * ha,
        a.x + Math.sin(wa) * ha, a.y - Math.cos(wa) * ha,
        bx - Math.sin(wb) * hb, by + Math.cos(wb) * hb,
        bx + Math.sin(wb) * hb, by - Math.cos(wb) * hb,
      ) <= reach * reach
    );
  }

  /**
   * Rammschaden für EINE Seite des Paars, mit dem Tick skaliert.
   *
   * Der Rumpf verliert COLLISION.hullFractionPerSecond seiner maximalen HP je
   * Sekunde; getragene Panzerung schluckt davon ihren Prozentsatz (dieselbe
   * `splitDamage`-Regel wie bei jedem Treffer), zahlt aber unabhängig davon
   * immer COLLISION.armorCostPerSecond Integrität je Sekunde.
   *
   * Bewusst OHNE Rundung: bei 20 Ticks/s ist der Schaden eines Ticks kleiner
   * als ein ganzer Punkt — gerundet käme entweder nichts oder das Doppelte an.
   * Die Anzeige rundet erst der Client.
   */
  private applyCollisionDamage(
    vessel: Vessel,
    killerId: PlayerId,
    deltaSeconds: number,
    events: WorldEvents,
    sunkThisStep: Set<PlayerId>,
  ): void {
    const stats = this.ships.get(vessel.model);
    const roh = stats.hp * COLLISION.hullFractionPerSecond * deltaSeconds;

    const slot = this.armor.get(vessel.id);
    const { toHull } = splitDamage(roh, slot?.stats.absorb ?? 0, slot?.integrity ?? 0);
    if (slot && slot.integrity > 0) {
      slot.integrity = Math.max(slot.integrity - COLLISION.armorCostPerSecond * deltaSeconds, 0);
    }

    const remaining = (this.hitpoints.get(vessel.id) ?? 0) - toHull;
    this.hitpoints.set(vessel.id, Math.max(remaining, 0));
    if (remaining <= 0) {
      sunkThisStep.add(vessel.id);
      events.destroyed.push({ id: vessel.id, x: vessel.x, y: vessel.y, killerId });
    } else {
      this.applyDamageEffects(vessel, remaining);
    }
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
      // Basis ist das PERK-Profil, falls eines gemerkt ist — sonst nähme der
      // erste Drossel-Treffer dem Boot alle verbauten Perks wieder weg.
      const base = this.profileOverrides.get(vessel.id) ?? this.ships.profile(vessel.model);
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
   * Getestet wird EIN Punkt (x, y) gegen diese Strecke; dass die gesamte
   * Flugbahn eines Ticks abgedeckt ist, stellt der Aufrufer über die
   * Unterproben sicher (PROJECTILE_SAMPLE_SPACING) — Geschwindigkeits-
   * erhöhungen brauchen hier deshalb keinen Umbau mehr.
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
      // Torus: der kürzeste Versatz — ein Schuss trifft auch über die Naht.
      const dx = torusDelta(vessel.x, x, this.map.width);
      const dy = torusDelta(vessel.y, y, this.map.height);
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

/** Bot-Fahrzeuge tragen die `bot-`-Kennung aus Bots.ts — Spieler die Account-Id. */
function istBot(id: PlayerId): boolean {
  return id.startsWith('bot-');
}

/**
 * Quadrat des kleinsten Abstands zweier Strecken (a1→a2, b1→b2).
 * Standardverfahren nach Ericson, „Real-Time Collision Detection": beide
 * Streckenparameter werden auf [0, 1] geklemmt, entartete Strecken (Punkt —
 * bei Rümpfen mit length ≤ beam) fallen auf Punkt-Strecke-Abstand zurück.
 */
function segmentDistanceSquared(
  ax1: number, ay1: number, ax2: number, ay2: number,
  bx1: number, by1: number, bx2: number, by2: number,
): number {
  const d1x = ax2 - ax1;
  const d1y = ay2 - ay1;
  const d2x = bx2 - bx1;
  const d2y = by2 - by1;
  const rx = ax1 - bx1;
  const ry = ay1 - by1;
  const a = d1x * d1x + d1y * d1y;
  const e = d2x * d2x + d2y * d2y;
  const f = d2x * rx + d2y * ry;
  const EPS = 1e-9;

  let s = 0;
  let t = 0;
  if (a <= EPS && e <= EPS) {
    // beide Punkte
  } else if (a <= EPS) {
    t = clamp01(f / e);
  } else {
    const c = d1x * rx + d1y * ry;
    if (e <= EPS) {
      s = clamp01(-c / a);
    } else {
      const b = d1x * d2x + d1y * d2y;
      const denom = a * e - b * b;
      // Parallele Strecken: s = 0 ist ein gültiger Startpunkt, t folgt unten.
      s = denom > EPS ? clamp01((b * f - c * e) / denom) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp01(-c / a);
      } else if (t > 1) {
        t = 1;
        s = clamp01((b - c) / a);
      }
    }
  }

  const px = ax1 + d1x * s - (bx1 + d2x * t);
  const py = ay1 + d1y * s - (by1 + d2y * t);
  return px * px + py * py;
}

function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}
