import type { ClientMessage, ServerMessage } from '@subwarfare/shared';
import { ServerMessageType } from '@subwarfare/shared';
import type { RawData, WebSocket } from 'ws';

export interface ClientConnectionHandlers {
  onMessage(connection: ClientConnection, message: ClientMessage): void;
  onClose(connection: ClientConnection): void;
}

/**
 * Kapselt einen einzelnen WebSocket. Kümmert sich ausschließlich um Transport
 * und JSON-Rahmen — was inhaltlich mit einer Nachricht passiert, entscheidet
 * der `GameServer`.
 */
export class ClientConnection {
  readonly id: string;

  private readonly socket: WebSocket;
  private readonly handlers: ClientConnectionHandlers;

  constructor(id: string, socket: WebSocket, handlers: ClientConnectionHandlers) {
    this.id = id;
    this.socket = socket;
    this.handlers = handlers;

    this.socket.on('message', (data) => this.handleRaw(data));
    this.socket.on('close', () => this.handlers.onClose(this));
    this.socket.on('error', () => this.socket.terminate());
  }

  get isOpen(): boolean {
    return this.socket.readyState === this.socket.OPEN;
  }

  send(message: ServerMessage): void {
    if (!this.isOpen) return;
    this.socket.send(JSON.stringify(message));
  }

  sendError(code: string, message: string): void {
    this.send({ type: ServerMessageType.Error, code, message });
  }

  close(code = 1000, reason = 'closed by server'): void {
    this.socket.close(code, reason);
  }

  private handleRaw(data: RawData): void {
    let message: ClientMessage;
    try {
      message = JSON.parse(data.toString()) as ClientMessage;
    } catch {
      this.sendError('bad_json', 'Nachricht war kein gültiges JSON.');
      return;
    }

    if (typeof message !== 'object' || message === null || typeof message.type !== 'string') {
      this.sendError('bad_message', 'Nachricht hat kein gültiges `type`-Feld.');
      return;
    }

    this.handlers.onMessage(this, message);
  }
}
