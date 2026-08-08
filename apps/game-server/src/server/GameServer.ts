import type { ClientMessage } from '@subwarfare/shared';
import { ClientMessageType, PROTOCOL_VERSION, ServerMessageType } from '@subwarfare/shared';
import type { WebSocket } from 'ws';
import { WebSocketServer } from 'ws';
import { ocean01 } from '../maps/ocean01.js';
import { ClientConnection } from '../network/ClientConnection.js';
import { World } from '../world/World.js';

export interface GameServerOptions {
  port: number;
  host?: string;
  /** Simulationsschritte pro Sekunde. */
  tickRate?: number;
}

/**
 * Hält den WebSocket-Listener, die offenen Verbindungen und die Welt zusammen.
 * Bewusst noch ohne Spiellogik: Verbindungen werden angenommen und begrüßt,
 * Join/Input sind als Platzhalter markiert.
 */
export class GameServer {
  private readonly port: number;
  private readonly host: string;
  private readonly tickRate: number;

  private readonly world = new World(ocean01);
  private readonly connections = new Map<string, ClientConnection>();

  private wss: WebSocketServer | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private tick = 0;
  private lastTickAt = 0;
  private nextConnectionId = 1;

  constructor(options: GameServerOptions) {
    this.port = options.port;
    this.host = options.host ?? '0.0.0.0';
    this.tickRate = options.tickRate ?? 20;
  }

  start(): void {
    if (this.wss) throw new Error('GameServer läuft bereits.');

    this.wss = new WebSocketServer({ port: this.port, host: this.host });
    this.wss.on('connection', (socket) => this.handleConnection(socket));
    this.wss.on('listening', () => {
      console.log(
        `[game-server] hört auf ws://${this.host}:${this.port} — Map "${this.world.map.id}", ${this.tickRate} Ticks/s`,
      );
    });

    this.lastTickAt = Date.now();
    this.tickTimer = setInterval(() => this.update(), 1000 / this.tickRate);
  }

  async stop(): Promise<void> {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }

    for (const connection of this.connections.values()) {
      connection.close(1001, 'server shutting down');
    }
    this.connections.clear();

    const wss = this.wss;
    this.wss = null;
    if (!wss) return;

    await new Promise<void>((resolve, reject) => {
      wss.close((error) => (error ? reject(error) : resolve()));
    });
    console.log('[game-server] gestoppt.');
  }

  private handleConnection(socket: WebSocket): void {
    const id = `c${this.nextConnectionId++}`;
    const connection = new ClientConnection(id, socket, {
      onMessage: (conn, message) => this.handleMessage(conn, message),
      onClose: (conn) => this.handleClose(conn),
    });

    this.connections.set(id, connection);
    console.log(`[game-server] Verbindung ${id} geöffnet (${this.connections.size} offen).`);

    connection.send({
      type: ServerMessageType.Welcome,
      connectionId: id,
      protocolVersion: PROTOCOL_VERSION,
      map: this.world.map,
    });
  }

  private handleClose(connection: ClientConnection): void {
    this.connections.delete(connection.id);
    this.world.removePlayer(connection.id);
    console.log(`[game-server] Verbindung ${connection.id} geschlossen (${this.connections.size} offen).`);
  }

  private handleMessage(connection: ClientConnection, message: ClientMessage): void {
    switch (message.type) {
      case ClientMessageType.Ping:
        connection.send({
          type: ServerMessageType.Pong,
          sentAt: message.sentAt,
          serverTime: Date.now(),
        });
        break;

      case ClientMessageType.Join:
      case ClientMessageType.Input:
      case ClientMessageType.Leave:
        // TODO: Join/Bewegung/Extraction implementieren.
        connection.sendError('not_implemented', `"${message.type}" ist noch nicht implementiert.`);
        break;

      default:
        connection.sendError('unknown_type', 'Unbekannter Nachrichtentyp.');
    }
  }

  private update(): void {
    const now = Date.now();
    const deltaSeconds = (now - this.lastTickAt) / 1000;
    this.lastTickAt = now;

    this.tick += 1;
    this.world.update(deltaSeconds);

    // TODO: State-Broadcast an alle Verbindungen, sobald es Spieler gibt.
  }
}
