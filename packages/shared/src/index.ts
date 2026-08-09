export * from './types/Player.js';
export * from './types/SpawnPoint.js';
export * from './types/ExitPoint.js';
export * from './types/Map.js';

export * from './protocol/ClientMessages.js';
export * from './protocol/ServerMessages.js';

// Fahrmodell. Liegt hier, damit Client und Server denselben Code fahren können —
// die Voraussetzung dafür, dass der Server später autoritativ rechnet, ohne dass
// sich das Fahrverhalten ändert.
export * from './sim/angles.js';
export * from './sim/VesselProfile.js';
export * from './sim/movement.js';
export * from './sim/telegraph.js';

/**
 * Version des Wire-Protokolls. Client und Server müssen übereinstimmen —
 * bei jeder inkompatiblen Änderung an den Message-Typen hochzählen.
 */
export const PROTOCOL_VERSION = 1;
