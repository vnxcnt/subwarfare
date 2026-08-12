import type { ArmorState, TubeState, VesselModel, WeaponId, WeatherState } from '@subwarfare/shared';
import { DEFAULT_WEATHER, SHIP_TYPE_SUBMARINE } from '@subwarfare/shared';
import { shallowRef, triggerRef } from 'vue';
import { SONAR } from '../config';
import type { Game } from '../game/Game';
import { getTilt } from '../game/Projection';

/** Ein Sonarkontakt, relativ zum eigenen Boot. Alle Längen in Metern. */
export interface SonarContact {
  id: string;
  dx: number;
  dy: number;
  distance: number;
  /** Kurs des Kontakts in Grad. */
  rotation: number;
}

export interface HudState {
  ready: boolean;
  /** Spielzeit in Sekunden seit dem Start. Taktquelle für Animationen. */
  time: number;
  mapId: string;
  x: number;
  y: number;
  /** Kurs in Grad. */
  course: number;
  /** Tatsächliche Fahrt in m/s. */
  speed: number;
  /** Befohlene Fahrt in m/s. */
  orderedSpeed: number;
  /** Schiffsmodell des eigenen Boots — fürs Dev-Menü. */
  model: string;
  /** Bewaffnung des eigenen Boots (Waffen-Kennungen, Server-Katalog). */
  armament: string[];
  /** Eigene Lebenspunkte laut Server. */
  hp: number;
  /** Maximum des aktuellen Modells (ships-Tabelle) — Bezugsgröße der HP-Leiste. */
  maxHp: number;
  /** Panzerung dieses Einsatzes laut Server; `null` = ungepanzert (keine Leiste). */
  armor: ArmorState | null;
  /** Restmunition je Waffen-Kennung laut Server. Beim Torpedo der VORRAT. */
  ammo: Partial<Record<string, number>>;
  /** Torpedorohre laut Server; leer bei Schiffen ohne Rohre. */
  tubes: TubeState[];
  /** Wetterlage der Karte (Server) und die laufende Bordzeit in Stunden. */
  weather: WeatherState;
  hour: number;
  /** Kann das eigene Schiff tauchen (Typ Submarine laut Katalog)? */
  canDive: boolean;
  /** Tauchtiefe des eigenen Boots, 0..1. */
  depth: number;
  /** Gewollter Tauchzustand (true = unter Wasser). */
  diveTarget: boolean;
  /** Periskop-Ausfahrstand 0..1 des eigenen Boots. */
  periscope: number;
  /** Gewollter Periskop-Zustand (true = ausgefahren). */
  periscopeTarget: boolean;
  maxForward: number;
  telegraphStep: number;
  zoom: number;
  tilt: number;
  following: boolean;
  /** Restdistanz zum Wegpunkt in Metern, oder null. */
  waypointDistance: number | null;
  /** Gesamtstrecke beim Erteilen des Befehls — Bezugsgröße für den Fortschritt. */
  waypointTotal: number | null;
  contacts: SonarContact[];
}

/**
 * Einziger Zustand, den die GUI liest.
 *
 * Bewusst ein `shallowRef` auf ein Objekt, das in place fortgeschrieben wird:
 * es wird pro Frame nichts alloziert, und Vue wird nur gedrosselt geweckt. Ein
 * tiefes `reactive()` wäre hier falsch — es würde für jedes berührte
 * Pixi-Objekt einen Proxy anlegen.
 *
 * ⚠️ Die Objektidentität bleibt dabei konstant. Deshalb darf dieser Zustand
 * NICHT als Prop an Kindkomponenten durchgereicht werden: Vue vergleicht Props
 * mit `===`, fände sie unverändert und überspränge das Update. Jede Komponente
 * importiert `hud` stattdessen selbst, dann hängt ihr eigener Render-Effekt am
 * Ref und `triggerRef` erreicht sie.
 */
export const hud = shallowRef<HudState>({
  ready: false,
  time: 0,
  mapId: '—',
  x: 0,
  y: 0,
  course: 0,
  speed: 0,
  orderedSpeed: 0,
  model: 'fregatte01',
  armament: [],
  hp: 1,
  maxHp: 1,
  armor: null,
  ammo: {},
  tubes: [],
  weather: DEFAULT_WEATHER,
  hour: DEFAULT_WEATHER.timeOfDay,
  canDive: false,
  depth: 0,
  diveTarget: false,
  periscope: 0,
  periscopeTarget: false,
  maxForward: 1,
  telegraphStep: 0,
  zoom: 1,
  tilt: 0.42,
  following: false,
  waypointDistance: null,
  waypointTotal: null,
  contacts: [],
});

export type FrameListener = (frameSeconds: number, state: HudState) => void;

/**
 * Wer jeden Frame zeichnen muss, hängt sich hier ein — nicht an Vues
 * Reaktivität und erst recht nicht an eine eigene `requestAnimationFrame`-
 * Schleife. Die Weckung von Vue ist auf 20 Hz gedrosselt, was für Text reicht,
 * für einen drehenden Sonarstrahl aber sichtbar ruckeln würde.
 *
 * Taktquelle bleibt derselbe Pixi-Ticker — es kommt keine zweite Uhr dazu.
 */
const frameListeners = new Set<FrameListener>();

export function onFrame(listener: FrameListener): () => void {
  frameListeners.add(listener);
  return () => frameListeners.delete(listener);
}

let game: Game | null = null;
let sinceWake = 0;
let lastSerial = -1;

/**
 * Weckfrequenz für Vue. Der Snapshot selbst wird jeden Frame geschrieben.
 *
 * 20 Hz und nicht 10, weil das Sonar daran hängt: die Bugmarke dreht mit bis zu
 * 8°/s, bei 10 Hz liefe sie am Rand des Rundsichtgeräts in sichtbaren Sprüngen.
 */
const WAKE_HZ = 20;

export function bindGame(next: Game | null): void {
  game = next;
  lastSerial = -1;
  if (!next) hud.value.ready = false;
}

/** Läuft am Ende des Ticker-Callbacks — dieselbe Uhr wie das Rendering. */
export function writeHud(frameSeconds: number): void {
  const scene = game?.scene;
  const own = game?.ownVessel;

  // Wetter und Bordzeit hängen NICHT am eigenen Boot: sie laufen weiter,
  // während man versenkt auf den Wiedereinstieg wartet. Deshalb vor dem
  // Ausstieg unten — sonst fröre die Uhr in der Statusleiste ein, und das
  // Entwicklermenü zeigte während der Respawn-Wartezeit alte Regler.
  const wetterJetzt = game?.weatherNow();
  if (wetterJetzt) {
    hud.value.weather = wetterJetzt.weather;
    hud.value.hour = wetterJetzt.hour;
    if (!scene || !own) triggerRef(hud);
  }

  if (!scene || !own) return;

  const state = hud.value;
  state.ready = true;
  state.time += frameSeconds;
  state.mapId = scene.currentMap.id;
  state.x = own.x;
  state.y = own.y;
  state.course = own.rotation;
  state.speed = own.speed;
  state.orderedSpeed = own.orderedSpeed;
  state.model = own.model;
  state.armament = game?.shipStats(own.model).armament ?? [];
  state.maxHp = game?.shipStats(own.model).hp ?? 1;
  state.hp = game?.hp ?? state.maxHp;
  // Referenz durchreichen wie bei den Rohren — der Server ersetzt das Objekt
  // bei jedem `own`, hier wird nichts fortgeschrieben.
  state.armor = game?.armor ?? null;
  // In place statt neues Objekt — das läuft jeden Frame (Muster dieser Datei).
  state.ammo['torpedo'] = game?.ammoFor('torpedo') ?? 0;
  state.ammo['taeuschkoerper'] = game?.ammoFor('taeuschkoerper') ?? 0;
  state.ammo['geschuetz'] = game?.ammoFor('geschuetz') ?? 0;
  state.ammo['wasserbombe'] = game?.ammoFor('wasserbombe') ?? 0;
  // Rohre kommen als fertiges Array vom Server — die Referenz durchreichen
  // genügt, sie wird bei jedem `own` ohnehin ersetzt.
  state.tubes = game?.tubes() ?? [];
  state.canDive = game?.shipStats(own.model).type === SHIP_TYPE_SUBMARINE;
  state.depth = own.depth;
  state.diveTarget = own.diveTarget;
  state.periscope = own.periscope;
  state.periscopeTarget = own.periscopeTarget;
  state.maxForward = own.maxForward;
  state.telegraphStep = own.telegraphStep;
  state.zoom = scene.camera.zoom;
  state.tilt = getTilt();
  state.following = scene.isFollowing;

  const remaining = own.distanceToWaypoint;
  state.waypointDistance = remaining;
  if (remaining === null) {
    state.waypointTotal = null;
    lastSerial = -1;
  } else if (own.serial !== lastSerial) {
    // Gesamtstrecke beim Erteilen des Befehls einfrieren — sonst wäre der
    // Fortschritt im Auftragsbuch immer 0 %.
    lastSerial = own.serial;
    state.waypointTotal = remaining;
  }

  writeContacts(state, own.id, own.x, own.y);

  // Zeichnende Abnehmer bekommen jeden Frame, Vue nur gedrosselt.
  for (const listener of frameListeners) listener(frameSeconds, state);

  sinceWake += frameSeconds;
  if (sinceWake >= 1 / WAKE_HZ) {
    sinceWake = 0;
    triggerRef(hud);
  }
}

function writeContacts(state: HudState, ownId: string, ownX: number, ownY: number): void {
  const entities = game?.scene?.entities;
  if (!entities) return;

  const rangeSquared = SONAR.range * SONAR.range;
  const list = state.contacts;
  let count = 0;

  for (const vessel of entities.models()) {
    if (vessel.id === ownId) continue;

    const dx = vessel.x - ownX;
    const dy = vessel.y - ownY;
    const squared = dx * dx + dy * dy;
    // Quadratvergleich statt Wurzel — das läuft für jeden Kontakt in jedem Frame.
    if (squared > rangeSquared) continue;

    const slot = list[count];
    if (slot) {
      slot.id = vessel.id;
      slot.dx = dx;
      slot.dy = dy;
      slot.distance = Math.sqrt(squared);
      slot.rotation = vessel.rotation;
    } else {
      list.push({ id: vessel.id, dx, dy, distance: Math.sqrt(squared), rotation: vessel.rotation });
    }
    count += 1;
  }

  list.length = count;
}

/* --- Befehle aus der GUI ins Spiel ------------------------------------- */

/**
 * Über die Game-Methoden statt direkt aufs Fahrzeug: online geht der Befehl
 * damit als Absicht ans Netz, offline wirkt er lokal — die GUI muss den
 * Unterschied nicht kennen.
 */
export function orderTelegraph(step: number): void {
  game?.orderTelegraph(step);
}

export function nudgeTelegraph(delta: number): void {
  game?.nudgeTelegraph(delta);
}

/** Tauchbefehl fürs eigene Boot — der Server prüft die Tauchfähigkeit. */
export function orderDive(submerged: boolean): void {
  game?.orderDive(submerged);
}

/** Periskop aus-/einfahren — der Server prüft die Fähigkeit. */
export function orderPeriscope(extended: boolean): void {
  game?.orderPeriscope(extended);
}

/**
 * Kamerafolgen ein-/ausschalten. Rein clientseitig — die Kamera ist keine
 * Spielmechanik, der Server erfährt davon nichts.
 */
export function orderFollow(on: boolean): void {
  game?.setFollowing(on);
}

/** Entwickler: eigenes Schiffsmodell wechseln (Server prüft die Rolle). */
export function devSetModel(model: VesselModel): void {
  game?.devSetModel(model);
}

/** Entwickler: Wetterlage setzen (Server prüft Rolle und Wertebereiche). */
export function devSetWeather(weather: WeatherState): void {
  game?.devSetWeather(weather);
}

/** Feuerbefehl — Bewaffnung, Munition und Rohr-Sperre prüft der Server. */
export function orderFire(weapon: WeaponId): void {
  game?.orderFire(weapon);
}

/**
 * Rohr laden oder scharf schalten. Index −1 gilt für alle Rohre.
 * Ob es geht (leer? Vorrat da? geladen?), entscheidet allein der Server.
 */
export function orderTube(index: number, action: 'laden' | 'scharf', armed?: boolean): void {
  game?.orderTube(index, action, armed);
}

/**
 * „Versenkt"-Meldung: Zeitstempel (ms), zu dem der Wiedereinstieg ansteht —
 * oder null. Eigener Ref statt Feld im HUD-Snapshot, weil `writeHud` nach dem
 * Untergang gar nicht mehr läuft (es gibt kein eigenes Boot mehr): die Anzeige
 * muss auch ohne Frame-Schreiber weiterleben.
 */
export const sunkUntil = shallowRef<number | null>(null);

export function setSunkNotice(until: number | null): void {
  sunkUntil.value = until;
}
