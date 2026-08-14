export * from './types/Player.js';
export * from './types/SpawnPoint.js';
export * from './types/ExitPoint.js';
export * from './types/Map.js';

// Wire-Protokoll als typisierte socket.io-Event-Maps.
export * from './protocol/events.js';
export * from './protocol/lobby.js';

// Levelsystem und Ränge — Server vergibt, Client zeigt an.
export * from './meta/progression.js';

// Schiffs-Basiswerte — DB ist die Wahrheit, das hier ist Vertrag + Fallback.
export * from './meta/ships.js';

// Kampfwerte: Waffen, Rumpfmaße für die Kollision, Respawn-Zeiten.
export * from './meta/combat.js';

// Ökonomie: Item-Katalog, Ausrüstungs-Slots, Schiffszugang (Level + Kosten).
export * from './meta/economy.js';

// Panzerung: Absorption je Stufe, Integritätsverlust je Waffe, Schadensteilung.
export * from './meta/armor.js';

// Munition: welches Item welche Waffe speist und wie hart sie zuschlägt.
export * from './meta/ammo.js';

// Loot und Extraktion: Kisten-Drops, NPC-Beute, Extraktionsregeln.
export * from './meta/loot.js';

// Torpedorohre: Bestückung je Schiff, Laden/Scharfschalten, Salven-Fächer.
export * from './meta/tubes.js';

// Wetter, Tageszeit, Seegang — Karten-Parameter, aus denen der Client
// Sonnenstand, Himmelsfarben und Wellenhöhe ableitet.
export * from './meta/weather.js';

// Flottillen (Clans): Ränge, Rechte-Helfer, Namensregeln, Wire-Typen.
export * from './meta/fleet.js';

// Statistik: XP-Belohnungen, Kampf-Ereignisse, Bestenlisten-Wire-Typen.
export * from './meta/stats.js';

// Social: Chat-Kanäle, Freundschaften, Spieler-Profile.
export * from './meta/social.js';

// Fahrmodell. Liegt hier, damit Client und Server denselben Code fahren —
// der Server rechnet damit autoritativ, der Client rendert das Ergebnis und
// nutzt es nur im Offline-Demobetrieb selbst.
export * from './sim/angles.js';
export * from './sim/VesselProfile.js';
export * from './sim/movement.js';
export * from './sim/telegraph.js';
export * from './sim/profiles.js';
export * from './sim/Vessel.js';
export * from './sim/torus.js';

/**
 * Version des Wire-Protokolls. Client und Server müssen übereinstimmen —
 * bei jeder inkompatiblen Änderung hochzählen.
 *
 * 2: socket.io-Events statt roher WebSocket-Nachrichten; Wegpunkt nur noch an
 *    den Besitzer statt im allgemeinen Broadcast.
 * 3: Schiffsmodell im PlayerState, Rolle im Ticket, dev:model-Befehl.
 * 4: Bewaffnung — order:fire, Projektile im State, HP und Munition im own,
 *    fx- und destroyed-Ereignisse.
 * 5: Rauchstufe im PlayerState; Schadensfolgen (Drossel, Zwangsauftauchen)
 *    server-seitig erzwungen.
 * 6: Handruder statt Wegpunkt — order:steer ersetzt order:waypoint;
 *    Täuschkörper als zweite Waffe (order:fire 'taeuschkoerper').
 * 7: Geschütz (order:fire 'geschuetz') und gezielte Peilung im Feuerbefehl —
 *    Überwasserschiffe feuern sektorgebunden (Bug ±20°, Seiten ±10°).
 * 8: Wasserbombe (order:fire 'wasserbombe', Sektor achteraus ±110°) —
 *    Projektile tragen optional `sink` für die Sinkphase vor der Detonation.
 * 9: Torpedorohre — `order:tube` (laden, scharf schalten), Rohr-Zustände im
 *    `own`-Ereignis, Torpedos laufen als Salve aus allen scharfen Rohren.
 * 10: Wetter in der `welcome` — Seegang, Tageszeit und Bewölkung kommen vom
 *     Server (je Karte), der Client leitet Sonne und Himmel daraus ab.
 * 11: Wetterwechsel zur Laufzeit — `dev:weather` (Entwicklerrolle) setzt die
 *     Lage, das `weather`-Ereignis verteilt sie an alle Verbundenen.
 * 12: Panzerung — `armor` im `own`-Ereignis (Stufe, Restintegrität in Prozent,
 *     Absorptionsanteil). Die getragene Stufe kommt signiert im Join-Ticket.
 * 13: Munition aus der Werft — die Bewaffnung eines Einsatzes kommt aus dem
 *     Ticket (Item und Stückzahl je Waffe). `ammo` im `own`-Ereignis führt nur
 *     noch die Waffen, die WIRKLICH an Bord sind; fehlt der Eintrag, hat das
 *     Schiff die Waffe nicht dabei.
 * 14: Loot und Extraktion — `crates` im State-Broadcast, `loot` und
 *     `extractionSeconds` im `own`, `extracted`-Ereignis. Gutschrift und
 *     Munitionsrückgabe gibt es NUR noch über die Extraktion.
 * 15: Ereignislog — `log`-Ereignis mit Kanälen welt (alle), lokal (nur der
 *     Betroffene) und event (Platzhalter).
 * 16: Endlos-Karte (Torus) — Positionen wrappen an den Kartengrenzen statt an
 *     einer Randwand zu stoppen; alle Distanzen laufen über den kürzesten Weg
 *     über die Naht. Alte Clients zeigten Nahtquerungen als Teleport.
 * 17: Frachtroute — die Karte trägt optional `route` (Polylinie, auf dem Torus
 *     zur Schleife geschlossen); NPC-Frachter verkehren ausschließlich darauf,
 *     die Minimap zeichnet die Linie.
 * 18: Kommandanten-Level im PlayerState (aus dem Ticket-Claim `level`) — fürs
 *     Namensschild beim Anklicken fremder Schiffe (Rang + Name, keine HP).
 */
export const PROTOCOL_VERSION = 18;

/**
 * Sichtbare Spielversion (Patch-Stand) — unten im Hauptmenü eingeblendet und
 * Überschrift der Patch-Notizen. Unabhängig vom Wire-Protokoll: die Version
 * erzählt den Spielern etwas, PROTOCOL_VERSION den Maschinen.
 */
export const GAME_VERSION = '0.0.0.1';
