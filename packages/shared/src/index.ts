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

// Fahrmodell. Liegt hier, damit Client und Server denselben Code fahren —
// der Server rechnet damit autoritativ, der Client rendert das Ergebnis und
// nutzt es nur im Offline-Demobetrieb selbst.
export * from './sim/angles.js';
export * from './sim/VesselProfile.js';
export * from './sim/movement.js';
export * from './sim/telegraph.js';
export * from './sim/profiles.js';
export * from './sim/Vessel.js';

/**
 * Version des Wire-Protokolls. Client und Server müssen übereinstimmen —
 * bei jeder inkompatiblen Änderung hochzählen.
 *
 * 2: socket.io-Events statt roher WebSocket-Nachrichten; Wegpunkt nur noch an
 *    den Besitzer statt im allgemeinen Broadcast.
 * 3: Schiffsmodell im PlayerState, Rolle im Ticket, dev:model-Befehl.
 * 4: Bewaffnung — order:fire, Projektile im State, HP und Munition im own,
 *    fx- und destroyed-Ereignisse.
 */
export const PROTOCOL_VERSION = 4;
