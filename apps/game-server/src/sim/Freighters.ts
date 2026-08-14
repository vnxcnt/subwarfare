import type { RoutePoint } from '@subwarfare/shared';
import { torusDelta, wrapCoord } from '@subwarfare/shared';
import type { World } from '../world/World.js';

/** Frachter je Fahrtrichtung — die Route wird in beiden Richtungen befahren. */
const JE_RICHTUNG = 7;

/** Versenkte Frachter kehren erst nach fünf Minuten zurück. */
const FRACHT_RESPAWN_SECONDS = 300;

/**
 * Ziel-Vorhalte in Metern: der nächste Routenpunkt wird schon HIER
 * weitergeschaltet. Ohne die Vorhalte liefe das Fahrmodell an jedem Punkt in
 * seine Bremsphase (angekommen = Maschine stopp) — die Route würde Stop-and-go.
 */
const VORHALTE = 700;

/** Seitlicher Spur-Versatz: Gegenverkehr fährt auf getrennten Spuren. */
const SPUR_MIN = 200;
const SPUR_MAX = 350;

/**
 * Marschstufen des Telegrafen für Frachter (HF 0.4 / MF 0.6 / GF 0.85) —
 * zufällig je Schiff und gelegentlich neu gewürfelt: der Verkehr soll
 * unregelmäßig wirken, keine Konvoi-Perlenkette.
 */
const STUFEN = [5, 6, 6, 7];

const NAMEN = [
  'MS Nordwind',
  'MS Albatros',
  'MS Kormoran',
  'MS Seestern',
  'MS Pelikan',
  'MS Ostwind',
  'MS Möwe',
  'MS Sturmvogel',
  'MS Delphin',
  'MS Seeschwalbe',
  'MS Passat',
  'MS Monsun',
  'MS Orkan',
  'MS Brise',
];

interface Eintrag {
  name: string;
  /** +1 fährt die Route vorwärts (oben rechts → unten links), −1 rückwärts. */
  richtung: 1 | -1;
  /** Seitlicher Versatz in Metern, immer nach links der Fahrtrichtung. */
  spur: number;
  /** Telegrafenstufe dieses Schiffs. */
  stufe: number;
  /** Index des Routenpunkts, der als Nächstes angesteuert wird. */
  ziel: number;
}

/**
 * NPC-Frachtverkehr auf der festen Route der Karte — die EINZIGE Quelle von
 * Frachtern (tanker01); der Zufallsverkehr in Bots.ts spawnt keine mehr.
 *
 * Die Route ist auf dem Torus eine Schleife: nach dem letzten Punkt geht es
 * auf kürzestem Weg über die Naht zurück zum ersten. Frachter fahren deshalb
 * nie um — sie verkehren endlos, je Richtung auf eigener Spur (links versetzt
 * in Fahrtrichtung), sonst träfen sich Gegenläufer auf derselben Linie.
 *
 * Ids tragen das `bot-`-Präfix — daran hängen die Bot-Bot-Kollisionsausnahme
 * in World.applyCollisions und der NPC-Loot-Pfad im GameServer.
 */
export class Freighters {
  private readonly entries = new Map<string, Eintrag>();
  /** Versenkte Frachter und ihre Restwartezeit bis zum Wiedereinstieg. */
  private readonly pending = new Map<string, number>();
  private readonly route: RoutePoint[];

  constructor(private readonly world: World) {
    this.route = this.world.map.route ?? [];
    // Karten ohne Route haben schlicht keinen Frachtverkehr.
    if (this.route.length < 2) return;

    for (let i = 0; i < JE_RICHTUNG * 2; i += 1) {
      const id = `bot-fracht-${i + 1}`;
      const richtung: 1 | -1 = i < JE_RICHTUNG ? 1 : -1;
      this.entries.set(id, {
        name: NAMEN[i % NAMEN.length] as string,
        richtung,
        spur: zufall(SPUR_MIN, SPUR_MAX),
        stufe: wuerfleStufe(),
        ziel: 0,
      });
      this.spawnAufRoute(id, i % JE_RICHTUNG);
    }
  }

  /**
   * Meldung des GameServers: dieser Frachter wurde versenkt (und ist bereits
   * aus der Welt entfernt). Ersatz läuft erst nach fünf Minuten wieder ein —
   * am Routeneinstieg seiner Richtung, nicht an der Untergangsstelle.
   */
  notifyDestroyed(id: string): void {
    if (this.entries.has(id)) this.pending.set(id, FRACHT_RESPAWN_SECONDS);
  }

  /** Läuft einmal pro Tick — Ziele nachführen, Respawns auszählen. */
  update(deltaSeconds: number): void {
    for (const [id, secondsLeft] of this.pending) {
      const remaining = secondsLeft - deltaSeconds;
      if (remaining > 0) {
        this.pending.set(id, remaining);
        continue;
      }
      this.pending.delete(id);
      this.spawnAmEinstieg(id);
    }

    const breite = this.world.map.width;
    const hoehe = this.world.map.height;
    for (const [id, eintrag] of this.entries) {
      const vessel = this.world.get(id);
      if (!vessel) continue; // versenkt — wartet in pending

      let ziel = this.zielKoordinate(eintrag);
      let dx = torusDelta(vessel.x, ziel.x, breite);
      let dy = torusDelta(vessel.y, ziel.y, hoehe);

      // Früh weiterschalten statt ankommen — siehe VORHALTE. Beim Passieren
      // würfelt das Schiff gelegentlich eine neue Marschstufe.
      if (dx * dx + dy * dy <= VORHALTE * VORHALTE) {
        eintrag.ziel = this.naechsterIndex(eintrag.ziel, eintrag.richtung);
        if (Math.random() < 0.25) eintrag.stufe = wuerfleStufe();
        ziel = this.zielKoordinate(eintrag);
        dx = torusDelta(vessel.x, ziel.x, breite);
        dy = torusDelta(vessel.y, ziel.y, hoehe);
      } else if (vessel.waypoint) {
        // Wegpunkt steht und das Ziel ist noch fern — nichts zu tun.
        continue;
      }

      // Immer die dem Schiff NÄCHSTE Torus-Darstellung des Ziels befehlen —
      // das Fahrmodell rechnet euklidisch, nur so führt der Kurs über die Naht.
      vessel.orderMoveTo(vessel.x + dx, vessel.y + dy);
      vessel.setTelegraph(eintrag.stufe);
    }
  }

  /** Zielpunkt des Eintrags samt Spur-Versatz (links der Fahrtrichtung). */
  private zielKoordinate(eintrag: Eintrag): RoutePoint {
    const breite = this.world.map.width;
    const hoehe = this.world.map.height;
    const punkt = this.route[eintrag.ziel] as RoutePoint;
    const vorher = this.route[this.naechsterIndex(eintrag.ziel, -eintrag.richtung)] as RoutePoint;
    const dx = torusDelta(vorher.x, punkt.x, breite);
    const dy = torusDelta(vorher.y, punkt.y, hoehe);
    const laenge = Math.hypot(dx, dy) || 1;
    return {
      x: wrapCoord(punkt.x + (-dy / laenge) * eintrag.spur, breite),
      y: wrapCoord(punkt.y + (dx / laenge) * eintrag.spur, hoehe),
    };
  }

  private naechsterIndex(index: number, richtung: number): number {
    const n = this.route.length;
    return (index + richtung + n) % n;
  }

  /**
   * Erstspawn: verteilt die Schiffe einer Richtung gestaffelt über die ganze
   * Schleife (mit Zufallsanteil), damit von Anfang an Verkehr herrscht statt
   * einer Kolonne am Einstieg.
   */
  private spawnAufRoute(id: string, platz: number): void {
    const eintrag = this.entries.get(id);
    if (!eintrag) return;
    const breite = this.world.map.width;
    const hoehe = this.world.map.height;

    // Bogenlängen der Schleife (Kante i: Punkt i → Punkt i+1, torisch).
    const n = this.route.length;
    const kanten: Array<{ dx: number; dy: number; laenge: number }> = [];
    let gesamt = 0;
    for (let i = 0; i < n; i += 1) {
      const a = this.route[i] as RoutePoint;
      const b = this.route[(i + 1) % n] as RoutePoint;
      const dx = torusDelta(a.x, b.x, breite);
      const dy = torusDelta(a.y, b.y, hoehe);
      const laenge = Math.hypot(dx, dy);
      kanten.push({ dx, dy, laenge });
      gesamt += laenge;
    }

    let strecke = ((platz + 0.15 + Math.random() * 0.7) / JE_RICHTUNG) * gesamt;
    let kante = 0;
    while (strecke > (kanten[kante] as { laenge: number }).laenge && kante < n - 1) {
      strecke -= (kanten[kante] as { laenge: number }).laenge;
      kante += 1;
    }
    const k = kanten[kante] as { dx: number; dy: number; laenge: number };
    const anteil = Math.min(strecke / (k.laenge || 1), 1);
    const start = this.route[kante] as RoutePoint;

    // Fahrtrichtung entlang der Kante; Spur-Versatz links davon.
    const vor = eintrag.richtung;
    const fx = (k.dx / (k.laenge || 1)) * vor;
    const fy = (k.dy / (k.laenge || 1)) * vor;
    const x = wrapCoord(start.x + k.dx * anteil + -fy * eintrag.spur, breite);
    const y = wrapCoord(start.y + k.dy * anteil + fx * eintrag.spur, hoehe);

    eintrag.ziel = vor === 1 ? (kante + 1) % n : kante;
    const vessel = this.world.spawnAt(id, eintrag.name, 'tanker01', x, y, kurs(fx, fy));
    vessel.setTelegraph(eintrag.stufe);
  }

  /** Respawn nach Versenkung: am Routeneinstieg der eigenen Richtung. */
  private spawnAmEinstieg(id: string): void {
    const eintrag = this.entries.get(id);
    if (!eintrag) return;
    const n = this.route.length;
    const startIndex = eintrag.richtung === 1 ? 0 : n - 1;
    eintrag.ziel = this.naechsterIndex(startIndex, eintrag.richtung);
    eintrag.spur = zufall(SPUR_MIN, SPUR_MAX);
    eintrag.stufe = wuerfleStufe();

    const start = this.route[startIndex] as RoutePoint;
    const ziel = this.zielKoordinate(eintrag);
    const dx = torusDelta(start.x, ziel.x, this.world.map.width);
    const dy = torusDelta(start.y, ziel.y, this.world.map.height);
    const vessel = this.world.spawnAt(id, eintrag.name, 'tanker01', start.x, start.y, kurs(dx, dy));
    vessel.setTelegraph(eintrag.stufe);
  }
}

function zufall(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function wuerfleStufe(): number {
  return STUFEN[Math.floor(Math.random() * STUFEN.length)] as number;
}

/** Kurs in Grad aus einem Richtungsvektor — 0 = Norden, im Uhrzeigersinn. */
function kurs(dx: number, dy: number): number {
  return (Math.atan2(dx, -dy) * (180 / Math.PI) + 360) % 360;
}
