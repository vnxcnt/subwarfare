import { warnAboutDefaults } from './env.js';
import { GameServer } from './server/GameServer.js';

warnAboutDefaults();

const server = new GameServer();
await server.start();

let shuttingDown = false;
const shutdown = (signal: string): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[game-server] ${signal} empfangen, fahre herunter …`);
  server
    .stop()
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      console.error('[game-server] Fehler beim Herunterfahren:', error);
      process.exit(1);
    });
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
