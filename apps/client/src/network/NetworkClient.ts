import type { ClientMessage, ServerMessage } from '@subwarfare/shared';
import { GAME_SERVER_URL } from '../config';

export type ServerMessageHandler = (message: ServerMessage) => void;

/**
 * Dünner, typisierter Wrapper um den Browser-WebSocket. Verbindet sich nicht von
 * selbst — `connect()` wird später vom Spielablauf aufgerufen.
 */
export class NetworkClient {
  private readonly url: string;
  private socket: WebSocket | null = null;
  private readonly handlers = new Set<ServerMessageHandler>();

  constructor(url: string = GAME_SERVER_URL) {
    this.url = url;
  }

  get isConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  connect(): void {
    if (this.socket) return;

    const socket = new WebSocket(this.url);
    socket.addEventListener('message', (event: MessageEvent<string>) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(event.data) as ServerMessage;
      } catch {
        console.warn('[network] Nachricht war kein gültiges JSON:', event.data);
        return;
      }
      for (const handler of this.handlers) handler(message);
    });
    socket.addEventListener('close', () => {
      this.socket = null;
    });
    socket.addEventListener('error', () => {
      console.warn('[network] Verbindungsfehler zu', this.url);
    });

    this.socket = socket;
  }

  disconnect(): void {
    this.socket?.close(1000, 'client closed');
    this.socket = null;
  }

  send(message: ClientMessage): void {
    if (!this.isConnected) {
      console.warn('[network] send() ohne offene Verbindung verworfen:', message.type);
      return;
    }
    this.socket?.send(JSON.stringify(message));
  }

  /** Registriert einen Handler und gibt die Abmeldefunktion zurück. */
  onMessage(handler: ServerMessageHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
}
