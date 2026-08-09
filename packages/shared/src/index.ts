export * from './types/Player.js';
export * from './types/SpawnPoint.js';
export * from './types/ExitPoint.js';
export * from './types/Map.js';

// Wire-Protokoll als typisierte socket.io-Event-Maps.
export * from './protocol/events.js';
export * from './protocol/lobby.js';

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
 */
export const PROTOCOL_VERSION = 2;
