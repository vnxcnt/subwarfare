import type {
  LobbyClientToServerEvents,
  LobbyServerToClientEvents,
  LobbySocketData,
} from '@subwarfare/shared';
import type { Server, Socket } from 'socket.io';
import { signTicket, verifySession } from '../auth/jwt.js';
import { env } from '../env.js';
import { fetchGameServerStatus, type GameServerStatus } from '../gameserver/status.js';
import type { MatchQueue } from './queue.js';

type LobbySocket = Socket<
  LobbyClientToServerEvents,
  LobbyServerToClientEvents,
  Record<string, never>,
  LobbySocketData
>;

/** Solange es nur eine Karte gibt, steht sie hier. Später kommt sie aus der DB. */
const KNOWN_MAPS = new Set(['ocean01']);

/** Wie oft geprüft wird, ob ein Platz frei geworden ist. */
const POLL_MS = 1000;

export class LobbyGateway {
  /**
   * Ausgestellte, noch nicht eingelöste Tickets — Konto → Ablauf.
   *
   * Ohne diese Reservierung würden wir überbuchen: zwischen Ticketausgabe und
   * tatsächlicher Anmeldung am Spielserver vergehen bis zu 60 Sekunden, in
   * denen dessen Spielerzahl den Platz noch nicht zeigt. Eine Reservierung
   * verfällt auf zwei Wegen: das Konto taucht unter den Verbundenen auf (das
   * Ticket ist eingelöst, ab jetzt zählt es in `players`) oder die
   * Ticket-Gültigkeit läuft ab, ohne dass es eingelöst wurde.
   */
  private readonly reservations = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly io: Server,
    private readonly queue: MatchQueue,
  ) {}

  register(): void {
    const lobby = this.io.of('/lobby');

    lobby.use((socket, next) => {
      void this.authorize(socket as LobbySocket, next);
    });

    lobby.on('connection', (socket) => this.handleConnection(socket as LobbySocket));
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async authorize(socket: LobbySocket, next: (error?: Error) => void): Promise<void> {
    const token = socket.handshake.auth?.['token'];
    const claims = typeof token === 'string' ? await verifySession(token) : null;
    if (!claims) {
      next(new Error('Nicht angemeldet.'));
      return;
    }
    socket.data.accountId = claims.sub;
    socket.data.name = claims.name;
    next();
  }

  private handleConnection(socket: LobbySocket): void {
    // Ein Konto steht in höchstens einer Schlange — der Raum je Konto macht das
    // Zustellen der Nachricht unabhängig davon, welche Verbindung gerade offen
    // ist (zweiter Reiter, Neuladen).
    void socket.join(`account:${socket.data.accountId}`);

    socket.on('queue:join', (payload) => {
      void this.handleJoin(socket, payload?.mapId);
    });

    socket.on('queue:leave', () => {
      void this.queue.leave('ocean01', socket.data.accountId);
    });

    socket.on('disconnect', () => {
      // Beim Trennen ausreihen — sonst hält ein geschlossener Reiter den Platz.
      // Ein Ticket, das bereits ausgestellt wurde, bleibt davon unberührt.
      for (const mapId of KNOWN_MAPS) void this.queue.leave(mapId, socket.data.accountId);
    });
  }

  private async handleJoin(socket: LobbySocket, mapId: unknown): Promise<void> {
    if (typeof mapId !== 'string' || !KNOWN_MAPS.has(mapId)) {
      socket.emit('queue:error', { message: 'Unbekannte Karte.' });
      return;
    }

    const status = await fetchGameServerStatus();
    if (!status) {
      socket.emit('queue:error', { message: 'Spielserver ist nicht erreichbar.' });
      return;
    }

    const waiting = await this.queue.size(mapId);
    // Nur direkt durchlassen, wenn niemand wartet — sonst würde ein neu
    // Eintreffender an den Wartenden vorbeiziehen.
    if (waiting === 0 && this.free(status) > 0) {
      await this.issueTicket(socket.data.accountId, socket.data.name, mapId);
      return;
    }

    const position = await this.queue.join(mapId, {
      accountId: socket.data.accountId,
      name: socket.data.name,
      joinedAt: Date.now(),
    });
    socket.emit('queue:update', { mapId, position, size: await this.queue.size(mapId) });
    this.ensureTimer();
  }

  /** Freie Plätze abzüglich der bereits vergebenen, noch offenen Tickets. */
  private free(status: GameServerStatus): number {
    const now = Date.now();
    for (const [accountId, expiresAt] of this.reservations) {
      if (expiresAt <= now || status.accounts.includes(accountId)) {
        this.reservations.delete(accountId);
      }
    }
    return status.capacity - status.players - this.reservations.size;
  }

  private async issueTicket(accountId: string, name: string, mapId: string): Promise<void> {
    const ticket = await signTicket({ sub: accountId, name, mapId });

    this.reservations.set(accountId, Date.now() + env.ticketTtl * 1000);
    await this.queue.leave(mapId, accountId);

    this.io.of('/lobby').to(`account:${accountId}`).emit('queue:ticket', {
      mapId,
      ticket,
      gameUrl: env.gamePublicUrl,
      expiresIn: env.ticketTtl,
    });
  }

  private ensureTimer(): void {
    this.timer ??= setInterval(() => {
      void this.tick();
    }, POLL_MS);
  }

  /**
   * Ein Durchlauf der Warteschlange.
   *
   * Fragt den Spielserver einmal je Karte — nicht einmal je Wartendem — und
   * gibt so viele Tickets aus, wie Plätze frei sind.
   */
  private async tick(): Promise<void> {
    let anyWaiting = false;

    for (const mapId of KNOWN_MAPS) {
      const waiting = await this.queue.list(mapId);
      if (waiting.length === 0) continue;
      anyWaiting = true;

      const status = await fetchGameServerStatus();
      if (!status) continue;

      let free = this.free(status);
      while (free > 0) {
        const next = await this.queue.peek(mapId);
        if (!next) break;
        await this.issueTicket(next.accountId, next.name, mapId);
        free -= 1;
      }

      // Die Verbliebenen bekommen ihren neuen Platz.
      const rest = await this.queue.list(mapId);
      rest.forEach((entry, index) => {
        this.io
          .of('/lobby')
          .to(`account:${entry.accountId}`)
          .emit('queue:update', { mapId, position: index + 1, size: rest.length });
      });
    }

    // Nichts mehr zu tun: den Takt anhalten, statt den Spielserver dauerhaft
    // im Sekundentakt zu befragen.
    if (!anyWaiting) this.stop();
  }
}
