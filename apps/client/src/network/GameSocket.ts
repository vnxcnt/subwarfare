import type {
  ClientToServerEvents,
  DestroyedPayload,
  FxPayload,
  OwnStatePayload,
  ServerToClientEvents,
  StatePayload,
  VesselModel,
  WeaponId,
  WelcomePayload,
} from '@subwarfare/shared';
import { io, type Socket } from 'socket.io-client';

export interface GameSocketHandlers {
  onWelcome: (payload: WelcomePayload) => void;
  onState: (payload: StatePayload) => void;
  onOwn: (payload: OwnStatePayload) => void;
  onPlayerLeft: (id: string) => void;
  /** Kampf-Effekt (Einschlag/Versenkung) in Sonar-Reichweite. */
  onFx: (payload: FxPayload) => void;
  /** Das EIGENE Boot wurde versenkt — Respawn folgt server-seitig. */
  onDestroyed: (payload: DestroyedPayload) => void;
  /** Sitzungsende — Rauswurf, Ablehnung des Tickets oder Verbindungsabriss. */
  onEnded: (message: string) => void;
}

/**
 * Verbindung zum Spielserver.
 *
 * Dünne Schale um socket.io. Über das Netz gehen ausschließlich Absichten —
 * Ruderlage, Telegrafenstufe, Tauch-/Feuerbefehle — der Server rechnet.
 *
 * `reconnection: false` ist kein Versäumnis: das Join-Ticket gilt genau
 * einmal, ein automatischer Wiederaufbau würde also sicher abgelehnt. Der
 * ehrliche Weg zurück führt über die Lobby und ein frisches Ticket.
 */
export class GameSocket {
  private socket: Socket<ServerToClientEvents, ClientToServerEvents> | null = null;
  private ended = false;

  connect(gameUrl: string, ticket: string, handlers: GameSocketHandlers): void {
    if (this.socket) throw new Error('GameSocket ist bereits verbunden.');

    // Leeres gameUrl bedeutet gleiche Herkunft — auf dem VPS führt der
    // Reverse-Proxy den Pfad /game/socket.io an den Spielserver weiter.
    const socket = io(gameUrl || window.location.origin, {
      path: '/game/socket.io',
      auth: { ticket },
      transports: ['websocket'],
      reconnection: false,
    });
    this.socket = socket;

    const end = (message: string): void => {
      // Trennung und Rauswurf treffen oft beide ein — nur das erste zählt.
      if (this.ended) return;
      this.ended = true;
      handlers.onEnded(message);
    };

    socket.on('welcome', handlers.onWelcome);
    socket.on('state', handlers.onState);
    socket.on('own', handlers.onOwn);
    socket.on('player:left', (payload) => handlers.onPlayerLeft(payload.id));
    socket.on('fx', handlers.onFx);
    socket.on('destroyed', handlers.onDestroyed);
    socket.on('kicked', (payload) => end(payload.message));
    socket.on('connect_error', (error) => end(error.message || 'Verbindung abgelehnt.'));
    socket.on('disconnect', (reason) => {
      // Selbst ausgelöste Trennung (Seitenwechsel) ist kein Fehlerfall.
      if (reason !== 'io client disconnect') end('Verbindung zum Spielserver verloren.');
    });
  }

  /** Handruderlage −1..1 — gesendet bei jeder Änderung, der Server klemmt. */
  sendSteer(value: number): void {
    this.socket?.emit('order:steer', { value });
  }

  sendTelegraph(step: number): void {
    this.socket?.emit('order:telegraph', { step });
  }

  /** Tauchbefehl — der Server prüft, ob das Schiff überhaupt tauchen kann. */
  sendDive(submerged: boolean): void {
    this.socket?.emit('order:dive', { submerged });
  }

  /** Periskop aus-/einfahren — Prüfung liegt beim Server. */
  sendPeriscope(extended: boolean): void {
    this.socket?.emit('order:periscope', { extended });
  }

  /**
   * Feuerbefehl — reine Absicht; Bewaffnung, Munition, Sperre und Feuersektor
   * prüft der Server. Überwasserschiffe geben die gezielte Peilung mit.
   */
  sendFire(weapon: WeaponId, bearingDegrees?: number): void {
    this.socket?.emit('order:fire', { weapon, bearingDegrees });
  }

  /** Entwickler: eigenes Schiffsmodell wechseln. Der Server prüft die Rolle. */
  sendDevModel(model: VesselModel): void {
    this.socket?.emit('dev:model', { model });
  }

  disconnect(): void {
    if (!this.socket) return;
    this.ended = true;
    this.socket.removeAllListeners();
    this.socket.disconnect();
    this.socket = null;
  }
}
