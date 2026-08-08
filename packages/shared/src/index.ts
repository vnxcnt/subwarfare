export * from './types/Player.js';
export * from './types/SpawnPoint.js';
export * from './types/ExitPoint.js';
export * from './types/Map.js';

export * from './protocol/ClientMessages.js';
export * from './protocol/ServerMessages.js';

/**
 * Version des Wire-Protokolls. Client und Server müssen übereinstimmen —
 * bei jeder inkompatiblen Änderung an den Message-Typen hochzählen.
 */
export const PROTOCOL_VERSION = 1;
