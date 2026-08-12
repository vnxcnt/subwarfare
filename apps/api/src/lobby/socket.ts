import type {
  LobbyClientToServerEvents,
  LobbyServerToClientEvents,
  LobbySocketData,
  PlayableModel,
} from '@subwarfare/shared';
import { SHIP_ACCESS, isPlayableModel, progressionFromXp } from '@subwarfare/shared';
import type { Server, Socket } from 'socket.io';
import { signTicket, verifySession } from '../auth/jwt.js';
import { env } from '../env.js';
import { fetchGameServerStatus, type GameServerStatus } from '../gameserver/status.js';
import type { AccountStore } from '../accounts/store.js';
import type { InventoryStore } from '../economy/store.js';
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

/** Platzreservierung eines ausgestellten Tickets — samt gezahlter Kosten. */
interface Reservation {
  expiresAt: number;
  /** Bezahlte Einsatzkosten — werden bei Verfall ohne Einlösung erstattet. */
  cost: number;
}

/** Ausgestelltes, noch nicht eingelöstes Ticket — für idempotente Zustellung. */
interface PendingTicket {
  mapId: string;
  ticket: string;
  /** Einmalkennung — daran erkennt free(), ob der Spielserver es verbraucht hat. */
  jti: string;
  expiresAt: number;
}

export class LobbyGateway {
  /**
   * Platzreservierungen ausgestellter Tickets — Konto → Ablauf und Kosten.
   *
   * Ohne diese Reservierung würden wir überbuchen: zwischen Ticketausgabe und
   * tatsächlicher Anmeldung am Spielserver vergehen bis zu 60 Sekunden, in
   * denen dessen Spielerzahl den Platz noch nicht zeigt. Eine Reservierung
   * verfällt auf zwei Wegen: das Konto taucht unter den Verbundenen auf (das
   * Ticket ist eingelöst, ab jetzt zählt es in `players`) oder die
   * Ticket-Gültigkeit läuft ab, ohne dass es eingelöst wurde — dann gibt es
   * die Einsatzkosten zurück.
   *
   * Die Reservierung ist zugleich das Gate gegen Doppel-Abbuchung: solange
   * sie steht, stellt `handleJoin` kein zweites Ticket aus, sondern liefert
   * das offene erneut zu (Doppelklick, zweiter Reiter).
   */
  private readonly reservations = new Map<string, Reservation>();
  private readonly pendingTickets = new Map<string, PendingTicket>();
  private timer: NodeJS.Timeout | null = null;
  /**
   * Sweeper für Reservierungen — läuft nur, solange welche offen sind.
   *
   * Ohne ihn liefe free() nur bei Queue-Aktivität: ein Spieler, der einlöst
   * und wieder geht, BEVOR je ein Sweep ihn verbunden sah, würde bei Ablauf
   * fälschlich erstattet. Der 5-s-Takt hält das Fenster praktisch geschlossen
   * — wer je als verbunden gesehen wurde, hat seine Reservierung eingelöst
   * und bekommt nichts zurück.
   */
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly io: Server,
    private readonly queue: MatchQueue,
    private readonly accounts: AccountStore,
    /** Nur zum Nachschlagen der getragenen Panzerung bei der Ticketausgabe. */
    private readonly inventory: InventoryStore,
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
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  private ensureSweeper(): void {
    this.sweepTimer ??= setInterval(() => {
      if (this.reservations.size === 0) {
        if (this.sweepTimer) clearInterval(this.sweepTimer);
        this.sweepTimer = null;
        return;
      }
      fetchGameServerStatus()
        .then((status) => {
          if (status) this.free(status);
        })
        .catch((error) => console.error('[api] Reservierungs-Sweep fehlgeschlagen:', error));
    }, 5_000);
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
      // Explizit fangen: eine DB-Störung in den Konto-Abfragen darf eine
      // Fehlermeldung an den Spieler werden, kein unbehandelter Prozess-Crash.
      this.handleJoin(socket, payload?.mapId, payload?.shipModel).catch((error) => {
        console.error('[api] queue:join fehlgeschlagen:', error);
        socket.emit('queue:error', { message: 'Serverfehler — bitte erneut versuchen.' });
      });
    });

    socket.on('queue:leave', () => {
      void this.queue.leave('ocean01', socket.data.accountId);
    });

    socket.on('disconnect', () => {
      // Beim Trennen ausreihen — sonst hält ein geschlossener Reiter den Platz.
      // Aber nur, wenn das die LETZTE Verbindung des Kontos war: der Raum je
      // Konto existiert gerade, damit ein zweiter Reiter mitlesen kann — dessen
      // Schließen darf den Wartenden im ersten nicht ausreihen. Beim
      // disconnect-Ereignis hat dieser Socket seine Räume bereits verlassen,
      // die Raumgröße zählt also nur die verbliebenen Verbindungen.
      const room = this.io.of('/lobby').adapter.rooms.get(`account:${socket.data.accountId}`);
      if ((room?.size ?? 0) > 0) return;
      for (const mapId of KNOWN_MAPS) void this.queue.leave(mapId, socket.data.accountId);
    });
  }

  private async handleJoin(
    socket: LobbySocket,
    mapId: unknown,
    shipModel: unknown,
  ): Promise<void> {
    if (typeof mapId !== 'string' || !KNOWN_MAPS.has(mapId)) {
      socket.emit('queue:error', { message: 'Unbekannte Karte.' });
      return;
    }

    // Fehlendes Feld = alter Client: der fährt die kostenlose Fregatte.
    const model = shipModel ?? 'fregatte01';
    if (!isPlayableModel(model)) {
      socket.emit('queue:error', { message: 'Unbekanntes Schiff.' });
      return;
    }

    // Freischaltung und Deckung SOFORT prüfen — wer die Kosten nicht tragen
    // kann, soll das beim Klick erfahren, nicht nach Minuten in der Schlange.
    // Bezahlt wird trotzdem erst bei der Ticketausgabe (issueTicket): dort
    // läuft der Abzug bedingt, gegen den DANN aktuellen Kontostand.
    const account = await this.accounts.byId(socket.data.accountId);
    if (!account) {
      socket.emit('queue:error', { message: 'Konto nicht gefunden.' });
      return;
    }
    const access = SHIP_ACCESS[model];
    if (progressionFromXp(account.xp).level < access.minLevel) {
      socket.emit('queue:error', { message: `Erst ab Level ${access.minLevel}.` });
      return;
    }
    if (account.coins < access.sortieCost) {
      socket.emit('queue:error', { message: 'Nicht genug Coins für diesen Einsatz.' });
      return;
    }

    const status = await fetchGameServerStatus();
    if (!status) {
      socket.emit('queue:error', { message: 'Spielserver ist nicht erreichbar.' });
      return;
    }

    const waiting = await this.queue.size(mapId);

    // Ab hier bis zur Reservierung in issueTicket kein await mehr: free()
    // (räumt nebenbei eingelöste und verfallene Reservierungen), das
    // Ticket-Gate und das Setzen der neuen Reservierung liegen in EINEM
    // synchronen Abschnitt — zwei gleichzeitige Joins können so weder den
    // letzten Platz noch dasselbe Konto doppelt belegen.
    const freeSlots = this.free(status);

    // Steht noch ein offenes Ticket aus, wird es erneut zugestellt statt
    // erneut kassiert — Doppelklick und zweiter Reiter sind damit idempotent.
    const reservation = this.reservations.get(socket.data.accountId);
    if (reservation && reservation.expiresAt > Date.now()) {
      const pending = this.pendingTickets.get(socket.data.accountId);
      if (pending && pending.expiresAt > Date.now()) {
        socket.emit('queue:ticket', {
          mapId: pending.mapId,
          ticket: pending.ticket,
          gameUrl: env.gamePublicUrl,
          expiresIn: Math.max(1, Math.ceil((pending.expiresAt - Date.now()) / 1000)),
        });
      } else {
        // Die Ausgabe läuft gerade (zwischen Reservierung und Signatur).
        socket.emit('queue:error', { message: 'Ticket wird bereits ausgestellt — einen Moment.' });
      }
      return;
    }

    // Nur direkt durchlassen, wenn niemand wartet — sonst würde ein neu
    // Eintreffender an den Wartenden vorbeiziehen.
    if (waiting === 0 && freeSlots > 0) {
      await this.issueTicket(socket.data.accountId, socket.data.name, mapId, model);
      return;
    }

    const position = await this.queue.join(mapId, {
      accountId: socket.data.accountId,
      name: socket.data.name,
      shipModel: model,
      joinedAt: Date.now(),
    });
    socket.emit('queue:update', { mapId, position, size: await this.queue.size(mapId) });
    this.ensureTimer();
  }

  /** Freie Plätze abzüglich der bereits vergebenen, noch offenen Tickets. */
  private free(status: GameServerStatus): number {
    const now = Date.now();
    const eingeloest = new Set(status.redeemed);
    for (const [accountId, reservation] of this.reservations) {
      const pending = this.pendingTickets.get(accountId);
      // Zwei Wege, dieselbe Feststellung: das Konto ist gerade verbunden ODER
      // seine Ticketkennung steht in der Verbrauchsliste. Der zweite Weg ist
      // der wichtigere — wer beitritt und gleich wieder aussteigt, ist beim
      // nächsten Sweep nicht mehr verbunden, sein Ticket bleibt aber verbrannt.
      // Ohne ihn bekäme er bis zum Ablauf immer wieder dasselbe tote Ticket
      // („Ticket wurde bereits eingelöst") und obendrein bei Verfall seine
      // Einsatzkosten zurück, obwohl er gespielt hat.
      if (status.accounts.includes(accountId) || (pending && eingeloest.has(pending.jti))) {
        this.reservations.delete(accountId);
        this.pendingTickets.delete(accountId);
      } else if (reservation.expiresAt <= now) {
        // Verfallen ohne Einlösung: Platz wieder frei UND Einsatzkosten
        // zurück — sonst verbrennte ein Client-Absturz zwischen Ticketausgabe
        // und Anmeldung die Coins. Fire-and-forget, damit free() synchron
        // bleibt; ein Fehlschlag wird geloggt statt verschluckt.
        this.reservations.delete(accountId);
        this.pendingTickets.delete(accountId);
        if (reservation.cost > 0) {
          this.accounts.addCoins(accountId, reservation.cost).catch((error) => {
            console.error(`[api] Erstattung an ${accountId} fehlgeschlagen:`, error);
          });
        }
      }
    }
    return status.capacity - status.players - this.reservations.size;
  }

  /**
   * Stellt das Ticket aus und zieht dabei die Einsatzkosten ein.
   *
   * Liefert false, wenn nicht bezahlt werden konnte — der Aufrufer im
   * Schlangen-Takt darf den freien Platz dann an den Nächsten geben.
   */
  private async issueTicket(
    accountId: string,
    name: string,
    mapId: string,
    shipModel: PlayableModel,
  ): Promise<boolean> {
    // Reservierung SOFORT, vor dem ersten await: ab jetzt zählt free() diesen
    // Platz als vergeben, und das Gate in handleJoin blockt weitere Tickets
    // für dasselbe Konto. Würde sie erst nach Zahlung und Signatur gesetzt,
    // sähen zwei parallele Joins beide den letzten freien Platz.
    const cost = SHIP_ACCESS[shipModel].sortieCost;
    const expiresAt = Date.now() + env.ticketTtl * 1000;
    this.reservations.set(accountId, { expiresAt, cost });
    this.ensureSweeper();

    // Aus der Schlange — auch bei gescheiterter Zahlung. Bliebe der Eintrag
    // stehen, würde er als Kopf der Schlange jeden Takt erneut scheitern und
    // alle dahinter blockieren.
    await this.queue.leave(mapId, accountId);

    // Bezahlt wird JETZT, gegen den aktuellen Kontostand: `spendCoins` prüft
    // und bucht in einem Schritt. Die Vorprüfung beim Einreihen war nur
    // schnelles Feedback — zwischendurch kann ein Shop-Kauf gelaufen sein.
    if (cost > 0 && !(await this.accounts.spendCoins(accountId, cost))) {
      // Nichts bezahlt — Reservierung sofort wieder freigeben.
      this.reservations.delete(accountId);
      this.io
        .of('/lobby')
        .to(`account:${accountId}`)
        .emit('queue:error', { message: 'Nicht genug Coins für diesen Einsatz.' });
      return false;
    }

    // Rolle FRISCH aus dem Konto, nicht aus der Session — ein Entzug wirkt
    // damit spaetestens beim naechsten Ticket. Fehlt das Konto ganz (zwischen
    // Einreihen und Ticket gelöscht), gibt es KEIN Ticket: sonst spielte ein
    // gelöschtes Konto mit dem Gratis-Schiff einfach weiter.
    const account = await this.accounts.byId(accountId);
    if (!account) {
      this.reservations.delete(accountId);
      this.io
        .of('/lobby')
        .to(`account:${accountId}`)
        .emit('queue:error', { message: 'Konto nicht gefunden.' });
      return false;
    }
    /*
     * Getragene Panzerung nachschlagen und MITSIGNIEREN. Der Spielserver hat
     * bewusst keine Datenbankverbindung, die Ausrüstung liegt aber in
     * `ship_loadouts` — also reist sie im Ticket mit, genau wie das Schiff.
     *
     * Ein Fehlschlag hier darf den Einsatz NICHT verhindern: die Panzerung ist
     * ein Bonus, kein Zugangsrecht. Ohne Eintrag fährt man ungepanzert.
     */
    let armorItem: string | null = null;
    try {
      const loadouts = await this.inventory.loadouts(accountId);
      const eintrag = loadouts.find((l) => l.model === shipModel && l.slot === 'panzerung');
      armorItem = eintrag?.itemId ?? null;
    } catch (error) {
      console.warn('[api] Panzerung für das Ticket nicht lesbar — ungepanzert:', error);
    }

    const { ticket, jti } = await signTicket({
      sub: accountId,
      name,
      mapId,
      role: account.role,
      shipModel,
      armorItem,
    });

    // Fürs idempotente Wieder-Zustellen aufheben (Doppelklick, Reconnect
    // innerhalb der Gültigkeit) — geräumt wird in free(), sobald das Ticket
    // eingelöst wurde oder verfallen ist.
    this.pendingTickets.set(accountId, { mapId, ticket, jti, expiresAt });

    this.io.of('/lobby').to(`account:${accountId}`).emit('queue:ticket', {
      mapId,
      ticket,
      gameUrl: env.gamePublicUrl,
      expiresIn: env.ticketTtl,
    });
    return true;
  }

  private ensureTimer(): void {
    this.timer ??= setInterval(() => {
      // Fangen statt crashen: eine DB-Störung im Takt darf den Prozess nicht
      // über eine unbehandelte Rejection beenden.
      this.tick().catch((error) => console.error('[api] Warteschlangen-Takt fehlgeschlagen:', error));
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

      // Lebenszeichen für alle Wartenden mit offener Verbindung — die TTL der
      // Schlange soll Karteileichen treffen, nicht geduldig Wartende.
      for (const entry of waiting) {
        const room = this.io.of('/lobby').adapter.rooms.get(`account:${entry.accountId}`);
        if ((room?.size ?? 0) > 0) await this.queue.touch(mapId, entry.accountId);
      }

      const status = await fetchGameServerStatus();
      if (!status) continue;

      let free = this.free(status);
      while (free > 0) {
        const next = await this.queue.peek(mapId);
        if (!next) break;
        const model = isPlayableModel(next.shipModel) ? next.shipModel : 'fregatte01';
        // Nur ein AUSGESTELLTES Ticket belegt einen Platz — wer die Kosten
        // inzwischen nicht mehr decken kann, fliegt raus (issueTicket räumt
        // ihn aus der Schlange) und der Platz geht an den Nächsten.
        if (await this.issueTicket(next.accountId, next.name, mapId, model)) free -= 1;
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
