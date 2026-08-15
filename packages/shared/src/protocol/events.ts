import type { GameMap } from '../types/Map.js';
import type { LoadoutEntryStack } from '../meta/ammo.js';
import type { ArmorState } from '../meta/armor.js';
import type { ShipStats, WeaponId } from '../meta/ships.js';
import type { TubeState } from '../meta/tubes.js';
import type { WeatherState } from '../meta/weather.js';
import type { PlayerId, PlayerState, VesselModel } from '../types/Player.js';
import type { Waypoint } from '../sim/VesselProfile.js';

/**
 * Wire-Protokoll v2 als typisierte socket.io-Event-Maps.
 *
 * Grundregel, die das Protokoll trägt: über das Netz gehen ausschließlich
 * **Absichten** — Zielkoordinaten und ein Stufen-Index. Niemals Geschwindigkeiten,
 * Positionen oder Kurse vom Client. Der Server ist die einzige Quelle der
 * Wahrheit und klemmt jeden Wert selbst.
 */

/** Begrüßung direkt nach erfolgreicher Anmeldung am Spielserver. */
export interface WelcomePayload {
  protocolVersion: number;
  /** Eigene Fahrzeug-ID, um sich im State-Broadcast wiederzufinden. */
  selfId: PlayerId;
  map: GameMap;
  /**
   * Schiffs-Basiswerte, wie der Server sie fährt (aus der Datenbank). Der
   * Client leitet daraus Anzeigen ab (Telegraf-Höchstfahrt, Munitionsleiste) —
   * eine eigene Client-Tabelle wäre eine zweite Wahrheit.
   */
  ships: ShipStats[];
  /**
   * Wetterlage dieser Karte: Seegang, Tageszeit, Bewölkung. Der Client leitet
   * daraus Sonnenstand und Himmelsfarben ab — und die Wellenhöhe. Bewusst
   * NEBEN der Karte statt darin: die Geometrie ist statisch, das Wetter kann
   * sich später während einer Partie ändern.
   */
  weather: WeatherState;
  /**
   * Verbaute Perks des EIGENEN Schiffs — der Client spiegelt damit das
   * Fahrprofil (Telegraf-Höchstfahrt, Schadensdrossel). Fremde Perks werden
   * bewusst nie verschickt.
   */
  perks: string[];
  tick: number;
}

/**
 * Ein Projektil im Broadcast — bewusst OHNE Besitzer: wem ein anlaufender
 * Torpedo gehört, muss man aus der Lage erkennen, nicht aus dem Netzverkehr.
 */
export interface ProjectileState {
  id: string;
  /** Grafik-Kennung (z. B. `torpedo01`) — der Client wählt darüber den Atlas. */
  model: string;
  x: number;
  y: number;
  /** Laufrichtung in Grad. 0 = Nord, im Uhrzeigersinn. */
  rotation: number;
  /**
   * Sinkfortschritt 0..1 — nur bei der Wasserbombe, nachdem sie ihren Wurf
   * beendet hat und absinkt. Fehlt bei allen anderen Projektilen (die laufen
   * bis zum Treffer geradeaus).
   */
  sink?: number;
}

/**
 * Weltzustand eines Ticks. Wird mit 20 Hz und `volatile` verschickt.
 *
 * `players` ist PRO EMPFÄNGER gefiltert: enthalten ist nur, was dessen Sonar
 * orten kann (eigenes Boot immer). Ein Fahrzeug außerhalb der Reichweite fehlt
 * nicht nur in der Anzeige, sondern bereits im Netzverkehr — sonst wäre der
 * Broadcast in einem U-Boot-Spiel ein Aufklärungs-Wallhack. `projectiles`
 * läuft durch denselben Filter.
 */
/**
 * Eine Lootkiste im Broadcast — bewusst OHNE Inhalt: was drin ist, erfährt
 * man beim Aufsammeln. Der Wert im Netzverkehr wäre Aufklärung darüber, wie
 * fett die Beute eines Gefechts war, an dem man nicht beteiligt ist.
 */
export interface CrateState {
  id: string;
  x: number;
  y: number;
}

export interface StatePayload {
  tick: number;
  players: PlayerState[];
  projectiles: ProjectileState[];
  /** Lootkisten in Sonar-Reichweite — gefiltert wie Fahrzeuge und Projektile. */
  crates: CrateState[];
}

/**
 * Zustand, den nur der Besitzer sehen darf.
 *
 * Der Wegpunkt geht bewusst NICHT in den State-Broadcast: er verrät die Absicht
 * des Gegners und wäre in einem U-Boot-Spiel der gröbste denkbare
 * Aufklärungs-Leak. Ereignisgetrieben und zuverlässig, nicht volatile.
 */
export interface OwnStatePayload {
  telegraphStep: number;
  waypoint: Waypoint | null;
  /** Gewollter Tauchzustand — die Tiefe selbst läuft im Broadcast mit. */
  diveTarget: boolean;
  /** Gewollter Periskop-Zustand (true = ausgefahren). */
  periscopeTarget: boolean;
  /**
   * Eigene Lebenspunkte. Fremde HP laufen bewusst NICHT im Broadcast — wie
   * angeschlagen ein Gegner ist, ist Aufklärung, keine Anzeige.
   */
  hp: number;
  /**
   * Panzerung dieses Einsatzes, oder `null` bei ungepanzerter Fahrt (dann
   * zeigt der Client keine Leiste). Wie die HP nur an den Besitzer.
   */
  armor: ArmorState | null;
  /**
   * Restmunition je Waffen-Kennung. Beim Torpedo ist das der VORRAT, nicht die
   * Schussbereitschaft — die steckt in den Rohren.
   *
   * ⚠️ Enthält seit Protokoll 13 NUR die Waffen, die an Bord sind. Ein
   * fehlender Schlüssel heißt „nicht dabei" und ist etwas anderes als 0
   * („dabei, aber verschossen") — die Gefechtsleiste blendet den Slot im
   * ersten Fall ganz aus.
   */
  ammo: Partial<Record<WeaponId, number>>;
  /**
   * Torpedorohre in Anzeige-Reihenfolge. Leer bei Schiffen ohne Rohre.
   * Nur im Besitzer-Ereignis: fremde Ladezustände wären Aufklärung.
   */
  tubes: TubeState[];
  /**
   * Getragener Loot in Coins. Gehört einem erst nach der Extraktion — bis
   * dahin ist es Fracht, die beim Untergang wieder über Bord geht.
   */
  loot: number;
  /**
   * Sekunden ununterbrochen in einer Extraktionszone; 0 außerhalb. Die
   * Schwelle (EXTRACTION_SECONDS) kennt der Client aus shared.
   */
  extractionSeconds: number;
  /** Zählt bei jedem neuen Befehl hoch — die Anzeige erkennt daran den Wechsel. */
  serial: number;
}

/** Was mit einem Rohr geschehen soll. */
export interface TubeOrder {
  /** Index im `tubes`-Feld. −1 heißt: auf ALLE Rohre anwenden. */
  index: number;
  /** `laden` füllt ein leeres Rohr, `scharf` schaltet ein geladenes um. */
  action: 'laden' | 'scharf';
  /** Nur bei `scharf`: Zielzustand. Fehlt er, wird umgeschaltet. */
  armed?: boolean;
}

export interface PlayerLeftPayload {
  id: PlayerId;
}

export interface KickedPayload {
  code: 'duplicate_session' | 'server_full' | 'shutdown';
  message: string;
}

/**
 * Sichtbares Kampfereignis an einem Weltpunkt — Einschlag oder Versenkung.
 * Geht zuverlässig (nicht volatile) an alle, deren Sonar den Punkt erfasst:
 * eine Explosion darf nicht im Paketverlust untergehen.
 */
export interface FxPayload {
  kind: 'impact' | 'sunk';
  x: number;
  y: number;
}

/**
 * Nur an den Betroffenen: das eigene Boot ist versenkt. Seit Protokoll 19 ist
 * das das RUNDENENDE — der Server trennt die Verbindung gleich darauf, das
 * Schiff liegt beschädigt (HP 0) in der Werft. Bewusst ohne Felder.
 */
export type DestroyedPayload = Record<string, never>;

/**
 * Handruderlage −1 (Backbord) .. 1 (Steuerbord), 0 = mittschiffs. Ersetzt seit
 * Protokoll v6 die Wegpunktsteuerung per Rechtsklick — Spieler lenken mit
 * Tasten, nur Bots fahren noch Wegpunkte (server-intern, nie übers Netz).
 */
export interface SteerOrder {
  value: number;
}

export interface TelegraphOrder {
  /** Index in TELEGRAPH_STANDARD. Der Server klemmt auf den gültigen Bereich. */
  step: number;
}

/**
 * Ereignismeldung fürs Log unten links.
 *
 * Drei Kanäle mit unterschiedlicher Reichweite:
 * - `welt`: geht an ALLE auf dem Server (Versenkungen).
 * - `lokal`: geht nur an den Betroffenen (geborgener Loot).
 * - `event`: Platzhalter für spätere Server-Ereignisse.
 *
 * Bewusst zuverlässig (nicht volatile): eine verpasste Meldung sieht aus wie
 * ein Fehler, und der Kanal ist mit wenigen Ereignissen pro Minute billig.
 */
export interface LogPayload {
  kind: 'welt' | 'lokal' | 'event';
  text: string;
}

/**
 * Nur an den Betroffenen: erfolgreich extrahiert. Loot ist gutgeschrieben,
 * Restmunition zurückgebucht — die Verbindung endet unmittelbar danach.
 */
export interface ExtractedPayload {
  /** Gesicherte Coins dieses Einsatzes. */
  coins: number;
}

export interface ServerToClientEvents {
  welcome: (payload: WelcomePayload) => void;
  state: (payload: StatePayload) => void;
  own: (payload: OwnStatePayload) => void;
  'player:left': (payload: PlayerLeftPayload) => void;
  fx: (payload: FxPayload) => void;
  destroyed: (payload: DestroyedPayload) => void;
  extracted: (payload: ExtractedPayload) => void;
  log: (payload: LogPayload) => void;
  kicked: (payload: KickedPayload) => void;
  /**
   * Wetterwechsel während der Partie. Kommt heute nur vom Entwicklermenü —
   * der Weg dafür ist aber genau der, den auch ein späterer Wetterlauf oder
   * ein Frontenzug nehmen würde.
   */
  weather: (payload: WeatherState) => void;
}

/**
 * Entwickler-Befehl: eigenes Schiffsmodell wechseln.
 *
 * Der Server prüft ZWEI Dinge, bevor er etwas anfasst: die Rolle aus dem
 * Ticket (Entwickler) und das Modell gegen VESSEL_MODELS. Der Knopf im
 * Client ist reine Höflichkeit — die Wahrheit sitzt am Handler.
 */
export interface DevModelOrder {
  model: VesselModel;
}

/**
 * Tauchbefehl. Nur Schiffe vom Typ Submarine — der Server prüft das gegen den
 * Schiffskatalog und ignoriert alles andere.
 */
export interface DiveOrder {
  submerged: boolean;
}

/** Periskop aus-/einfahren. Wie der Tauchbefehl nur für U-Boote. */
export interface PeriscopeOrder {
  extended: boolean;
}

/**
 * Feuerbefehl — reine Absicht: WELCHE Waffe und (bei Überwasserschiffen) die
 * gezielte PEILUNG in Kursgrad. Der Server prüft Bewaffnung (ships-Tabelle),
 * Vorrat, Rohr-Sperre UND den Feuersektor: Geschütz nur im Bugsektor,
 * Torpedo/Täuschkörper nur seitlich — außerhalb fällt kein Schuss.
 * U-Boote senden keine Peilung (Bugrohr voraus, Täuschkörper achtern).
 */
export interface FireOrder {
  weapon: WeaponId;
  /** Zielpeilung in Grad (0 = Nord). Pflicht für Überwasserschiffe. */
  bearingDegrees?: number;
}

/**
 * Entwickler: Testkiste mit `coins` Coins kurz vor dem eigenen Bug absetzen.
 * Zum Testen der Beuteschleife ohne Bot-Jagd — Rolle prüft der Server.
 */
export interface DevCrateOrder {
  coins: number;
}

export interface ClientToServerEvents {
  'order:steer': (payload: SteerOrder) => void;
  'order:telegraph': (payload: TelegraphOrder) => void;
  'order:dive': (payload: DiveOrder) => void;
  'order:periscope': (payload: PeriscopeOrder) => void;
  'order:fire': (payload: FireOrder) => void;
  'dev:model': (payload: DevModelOrder) => void;
  /**
   * Entwickler: Wetterlage der laufenden Partie setzen. Wie `dev:model` an die
   * Entwicklerrolle gebunden — und wie dort prüft und klemmt der Server jeden
   * Wert selbst. Wirkt für ALLE Verbundenen, damit sich auch die Spielwirkung
   * (Streuung, Sonar) zu zweit testen lässt.
   */
  'dev:weather': (payload: WeatherState) => void;
  'dev:crate': (payload: DevCrateOrder) => void;
  'order:tube': (payload: TubeOrder) => void;
}

/**
 * Kontorollen. 0 = normaler Spieler (in der Datenbank schlicht der
 * Default), aufsteigend mehr Rechte.
 */
export const ROLE_PLAYER = 0;
export const ROLE_MODERATOR = 1;
export const ROLE_GAMEMASTER = 2;
export const ROLE_DEVELOPER = 3;

/** Pro Verbindung am Socket hinterlegt, nachdem das Ticket geprüft wurde. */
export interface GameSocketData {
  accountId: string;
  name: string;
  /** Kontorolle aus dem Ticket — Grundlage für Dev-/Admin-Befehle. */
  role: number;
  /** Schiffsmodell aus dem Ticket — die api hat Level und Kosten geprüft. */
  shipModel: string;
  /** Getragene Panzerung aus dem Ticket, `null` = ungepanzert. */
  armorItem: string | null;
  /** Munition aus dem Ticket: je Waffe Sorte und mitgenommene Stückzahl. */
  loadout: LoadoutEntryStack[];
  /** Spielstufe aus dem Ticket — fürs Namensschild im Broadcast. */
  level: number;
  /** Schiffs-INSTANZ aus dem Ticket — Ziel der Schadensmeldung am Rundenende. */
  shipId: string;
  /** Verbaute Perks der Instanz — Profil-, Sonar- und Rohr-Wirkung. */
  perks: string[];
  /** Rest-HP der Instanz beim Auslaufen — der Spawn startet damit. */
  startHp: number;
}

/** Inhalt eines Join-Tickets. Vom Backend signiert, vom Spielserver geprüft. */
export interface TicketClaims {
  /** Account-ID. */
  sub: string;
  name: string;
  mapId: string;
  /** Kontorolle zum Zeitpunkt der Ticketausgabe. */
  role: number;
  /**
   * Bezahltes und freigeschaltetes Schiff für diesen Einsatz. Der Spielserver
   * spawnt genau dieses Modell — die Prüfung (Level, Coins) lief in der api.
   */
  shipModel: string;
  /**
   * Getragene Panzerung für diesen Einsatz, oder `null` für ungepanzert.
   *
   * Steht aus demselben Grund im Ticket wie `shipModel`: der Spielserver hat
   * bewusst keine Datenbankverbindung, die Ausrüstung liegt aber in
   * `ship_loadouts`. Die api liest sie bei der Ticketausgabe und signiert sie
   * mit — der Client kann sie damit nicht fälschen.
   */
  armorItem: string | null;
  /**
   * Munition dieses Einsatzes: je Waffe das Item und die Stückzahl, die aus
   * dem Inventar an Bord gegangen ist. Waffen ohne Eintrag sind NICHT dabei.
   *
   * Die Stückzahl ist bei der Ticketausgabe bereits vom Konto abgebucht — das
   * Ticket ist damit auch der Lieferschein. Was der Einsatz nicht verbraucht,
   * meldet der Spielserver am Ende zurück und die api schreibt es gut.
   */
  loadout: LoadoutEntryStack[];
  /**
   * Spielstufe (aus dem XP-Stand abgeleitet) zum Zeitpunkt der Ticketausgabe.
   * Momentaufnahme wie `role` — geht in den `state`-Broadcast, damit fremde
   * Spieler beim Anklicken Rang und Name sehen.
   */
  level: number;
  /**
   * Schiffs-INSTANZ dieses Einsatzes (account_ships.id). Steht aus demselben
   * Grund im Ticket wie `armorItem`: der Spielserver hat keine Datenbank —
   * am Rundenende meldet er den Schaden gegen genau diese Instanz zurück.
   */
  shipId: string;
  /** Verbaute Perks der Instanz — die api hat die Regeln bereits geprüft. */
  perks: string[];
  /** Rest-HP der Instanz beim Auslaufen — der Spawn startet damit. */
  startHp: number;
  /** Einmalkennung — der Spielserver merkt sich verbrauchte Tickets. */
  jti: string;
}
