import { GameServer } from './server/GameServer.js';

const port = Number.parseInt(process.env['PORT'] ?? '8080', 10);
const host = process.env['HOST'] ?? '0.0.0.0';

const server = new GameServer({ port, host });
server.start();

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
