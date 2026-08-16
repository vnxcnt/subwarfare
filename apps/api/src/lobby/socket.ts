import type {
  ChatMessagePayload,
  ChatSendRequest,
  LoadoutEntryStack,
  LobbyClientToServerEvents,
  LobbyServerToClientEvents,
  LobbySocketData,
  PlayableModel,
} from '@subwarfare/shared';
import {
  AMMO_CATEGORIES,
  CHAT_MAX_LENGTH,
  WEAPON_FOR_CATEGORY,
  isItemId,
  isPlayableModel,
  progressionFromXp,
} from '@subwarfare/shared';
import type { Server, Socket } from 'socket.io';
import { signTicket, verifySession } from '../auth/jwt.js';
import { env } from '../env.js';
import { fetchGameServerStatus, type GameServerStatus } from '../gameserver/status.js';
import type { AccountStore } from '../accounts/store.js';
import type { InventoryStore } from '../economy/store.js';
import type { FleetStore } from '../fleet/store.js';
import { dmKey, type SocialStore } from '../social/store.js';
import type { WerftService } from '../werft/service.js';
import type { MatchQueue } from './queue.js';

type LobbySocket = Socket<
  LobbyClientToServerEvents,
  LobbyServerToClientEvents,
  Record<string, never>,
  LobbySocketData
>;

/**
 * Bespielbare Karten — die Schlüssel der Karten-Tabelle aus der Umgebung.
 * Eine Karte ist genau dann spielbar, wenn wir einen Spielserver für sie kennen.
 */
const KNOWN_MAPS = new Set(env.gameMaps.keys());

/** Wie oft geprüft wird, ob ein Platz frei geworden ist. */
const POLL_MS = 1000;

/** Platzreservierung eines ausgestellten Tickets. */
interface Reservation {
  /**
   * Karte, deren Platz reserviert ist. Ohne sie ließe sich die Reservierung
   * weder der richtigen Kapazität zuordnen noch am richtigen Spielserver
   * prüfen — jede Karte ist ein eigener Prozess mit eigenem Status.
   */
  mapId: string;
  expiresAt: number;
  /**
   * Abgebuchte Munition dieses Tickets. Verfällt es ungenutzt, geht sie
   * zurück — sonst fräße ein Client-Absturz zwischen Ticketausgabe und
   * Anmeldung den ganzen Vorrat. (Einsatzkosten gibt es seit dem Werft-Umbau
   * nicht mehr — die Schiffs-Ökonomie sind Kauf und Reparatur.)
   */
  loadout: LoadoutEntryStack[];
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
   *
   * Der Schlüssel bleibt auch bei mehreren Karten das KONTO, nicht das Paar aus
   * Konto und Karte: ein Konto fährt einen Einsatz, nicht zwei. Genau deshalb
   * steht die Karte IM Eintrag — wer sie ignoriert, misst eine Reservierung für
   * ocean04 am Status von ocean01 und lässt sie dort verfallen.
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
    /** Flottillen-Mitgliedschaft — Zustellung und Gate des Flottillen-Kanals. */
    private readonly fleets: FleetStore,
    /** Freundschaften und Verlauf — Gate und Speicher für Privat/Flottille. */
    private readonly social: SocialStore,
    /** Schiffs-Instanzen — Zustands-Gate und Ticket-Inhalt (Perks, Rest-HP). */
    private readonly werft: WerftService,
  ) {}

  /** Ist das Konto gerade im Hafen (mindestens eine Lobby-Verbindung)? */
  isOnline(accountId: string): boolean {
    return (this.io.of('/lobby').adapter.rooms.get(`account:${accountId}`)?.size ?? 0) > 0;
  }

  /** Stößt beim Konto ein Neuladen der Freundesliste an (Social-Routen). */
  notifySocial(accountId: string): void {
    this.io.of('/lobby').to(`account:${accountId}`).emit('social:update');
  }

  /** Moderation: alle Clients werfen die Zeilen dieses Kontos weg. */
  broadcastChatPurge(accountId: string): void {
    this.io.of('/lobby').emit('chat:purge', { accountId });
  }

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
      // Nur die Karten abfragen, für die überhaupt eine Reservierung offen ist
      // — und jede einzeln: der Status der einen Karte sagt über die Tickets
      // der anderen nichts aus.
      const offeneKarten = new Set<string>();
      for (const reservation of this.reservations.values()) offeneKarten.add(reservation.mapId);
      for (const mapId of offeneKarten) {
        fetchGameServerStatus(mapId)
          .then((status) => {
            if (status) this.free(mapId, status);
          })
          .catch((error) =>
            console.error(`[api] Reservierungs-Sweep für ${mapId} fehlgeschlagen:`, error),
          );
      }
    }, 5_000);
  }

  /**
   * Öffentliche Adresse einer Karte für das Ticket. Die Kennung ist zu diesem
   * Zeitpunkt geprüft (KNOWN_MAPS stammt aus derselben Tabelle) — der leere
   * Ersatzwert bedeutet „gleiche Herkunft" und kann hier nicht auftreten.
   */
  private publicUrl(mapId: string): string {
    return env.gameMaps.get(mapId)?.publicUrl ?? '';
  }

  private async authorize(socket: LobbySocket, next: (error?: Error) => void): Promise<void> {
    const token = socket.handshake.auth?.['token'];
    const claims = typeof token === 'string' ? await verifySession(token) : null;
    if (!claims) {
      next(new Error('Nicht angemeldet.'));
      return;
    }
    // Gesperrte Konten kommen auch nicht in die Lobby — dieselbe Regel wie
    // an der REST-Auth. Eine DB-Störung lässt durch (Verfügbarkeit).
    try {
      const konto = await this.accounts.byId(claims.sub);
      if (konto?.bannedReason != null) {
        next(new Error('Konto gesperrt.'));
        return;
      }
    } catch {
      // Standard: durchlassen.
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
      this.handleJoin(socket, payload?.mapId, payload?.shipId).catch((error) => {
        console.error('[api] queue:join fehlgeschlagen:', error);
        socket.emit('queue:error', { message: 'Serverfehler — bitte erneut versuchen.' });
      });
    });

    socket.on('queue:leave', () => {
      // Das Ereignis trägt keine Karte (Protokoll), und ein Konto steht ohnehin
      // in höchstens einer Schlange — also aus allen austragen, wie beim Trennen.
      for (const mapId of KNOWN_MAPS) void this.queue.leave(mapId, socket.data.accountId);
    });

    /*
     * Funkraum: drei Kanäle über EIN Ereignis. Der Hafen bleibt reines
     * Durchreichen an alle Verbundenen ohne Speicherung; Flottille und Privat
     * werden gespeichert und gezielt zugestellt. Der Absendername kommt aus
     * dem geprüften Token (socket.data), nie aus dem Ereignis. Ein einfaches
     * Rate-Limit je Verbindung (eine Nachricht pro Sekunde) hält Flutversuche
     * fern; überzählige und unberechtigte fallen still weg.
     */
    let letzteNachricht = 0;
    socket.on('chat:send', (payload) => {
      const text = typeof payload?.text === 'string' ? payload.text.trim() : '';
      if (text.length === 0) return;
      const jetzt = Date.now();
      if (jetzt - letzteNachricht < 1000) return;
      letzteNachricht = jetzt;
      this.handleChat(socket, text.slice(0, CHAT_MAX_LENGTH), payload).catch((error) => {
        console.error('[api] chat:send fehlgeschlagen:', error);
      });
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

  /**
   * Stellt eine Chat-Zeile zu — je nach Kanal an alle (Hafen), an die
   * Flottille (gespeichert) oder an genau einen Freund (gespeichert).
   * Unberechtigte Versuche (keine Flottille, kein Freund) fallen still weg:
   * der ehrliche Client bietet diese Wege gar nicht erst an.
   */
  private async handleChat(
    socket: LobbySocket,
    text: string,
    payload: ChatSendRequest,
  ): Promise<void> {
    // Rolle und Level FRISCH vom Konto — beides kann sich seit dem Login
    // ändern, und der Session-Token trägt sie bewusst nicht. Eine DB-Störung
    // schluckt die Werte, nicht die Nachricht.
    let konto = null;
    try {
      konto = await this.accounts.byId(socket.data.accountId);
    } catch {
      // Standardwerte unten.
    }
    // Chatsperre und Kontosperre: die Zeile fällt still weg — der Rest der
    // Verbindung (Warteschlange, Mitlesen) bleibt bei der Chatsperre nutzbar.
    if (konto?.chatMuted || konto?.bannedReason != null) return;
    const zeile: ChatMessagePayload = {
      channel: 'hafen',
      senderId: socket.data.accountId,
      name: socket.data.name,
      text,
      level: progressionFromXp(konto?.xp ?? 0).level,
      role: konto?.role ?? 0,
      to: null,
      at: new Date().toISOString(),
    };

    const channel = payload.channel ?? 'hafen';
    if (channel === 'flottille') {
      const membership = await this.fleets.membership(socket.data.accountId);
      if (!membership) return;
      await this.social.saveMessage('flottille', membership.fleetId, socket.data.accountId, text);
      // Zustellung über die Konto-Räume der Mitglieder — wer nicht verbunden
      // ist, liest die Zeile später aus dem Verlauf.
      const mine = await this.fleets.mine(socket.data.accountId);
      zeile.channel = 'flottille';
      for (const mitglied of mine?.members ?? []) {
        this.io.of('/lobby').to(`account:${mitglied.accountId}`).emit('chat:message', zeile);
      }
      return;
    }

    if (channel === 'privat') {
      const to = payload.to;
      if (typeof to !== 'string' || to.length === 0 || to === socket.data.accountId) return;
      // Das Freundschafts-Gate IST der Spam-Schutz: Privatnachrichten gibt es
      // nur zwischen bestätigten Freunden.
      if (!(await this.social.areFriends(socket.data.accountId, to))) return;
      await this.social.saveMessage(
        'privat',
        dmKey(socket.data.accountId, to),
        socket.data.accountId,
        text,
      );
      zeile.channel = 'privat';
      zeile.to = to;
      this.io.of('/lobby').to(`account:${to}`).emit('chat:message', zeile);
      // Auch an den Absender selbst (alle seine Reiter) — die eigene Zeile
      // kommt wie bei den anderen Kanälen vom Server zurück, nie lokal.
      this.io.of('/lobby').to(`account:${socket.data.accountId}`).emit('chat:message', zeile);
      return;
    }

    this.io.of('/lobby').emit('chat:message', zeile);
  }

  private async handleJoin(socket: LobbySocket, mapId: unknown, shipId: unknown): Promise<void> {
    if (typeof mapId !== 'string' || !KNOWN_MAPS.has(mapId)) {
      socket.emit('queue:error', { message: 'Unbekannte Karte.' });
      return;
    }

    // Seit dem Werft-Umbau fährt man eine INSTANZ, kein Modell. Ein fehlendes
    // Feld heißt: alter Client — Fehler statt Fallback, sonst erfänden wir
    // ein Instanz-Recht, das es nicht gibt.
    if (typeof shipId !== 'string' || shipId.length === 0) {
      socket.emit('queue:error', {
        message: 'Veralteter Client — bitte Seite neu laden (Strg+F5).',
      });
      return;
    }

    const account = await this.accounts.byId(socket.data.accountId);
    if (!account) {
      socket.emit('queue:error', { message: 'Konto nicht gefunden.' });
      return;
    }

    // Zustand SOFORT prüfen — wer nicht auslaufen kann, soll das beim Klick
    // erfahren, nicht nach Minuten in der Schlange. Verbindlich wird die
    // Prüfung erst bei der Ticketausgabe (issueTicket), gegen den DANN
    // aktuellen Stand.
    const ship = await this.werft.shipOf(socket.data.accountId, shipId);
    if (!ship) {
      socket.emit('queue:error', { message: 'Schiff nicht gefunden.' });
      return;
    }
    if (ship.repairUntil !== null) {
      socket.emit('queue:error', { message: 'Schiff ist in Reparatur.' });
      return;
    }
    if (ship.hp <= 0) {
      socket.emit('queue:error', { message: 'Schiff ist schwer beschädigt — erst reparieren.' });
      return;
    }

    /*
     * Der Status ALLER Karten in einer Momentaufnahme, parallel geholt — die
     * Wartezeit ist damit die der langsamsten Karte und nicht ihre Summe. Drei
     * Fragen hängen daran, und alle drei wollen denselben Zeitpunkt sehen: die
     * Kapazität der gewählten Karte, ob dieses Konto anderswo schon auf See
     * ist, und was aus einer offenen Reservierung auf einer anderen Karte wird.
     * Bei EINER Karte bleibt es die eine Abfrage von früher.
     */
    const karten = [...KNOWN_MAPS];
    const antworten = await Promise.all(karten.map((id) => fetchGameServerStatus(id)));
    const statusVon = new Map(karten.map((id, index) => [id, antworten[index] ?? null] as const));

    /*
     * Fährt das Konto gerade auf einer ANDEREN Karte, gibt es hier kein Ticket.
     *
     * Mit nur einer Karte konnte dieser Fall nicht entstehen: der Spielserver
     * verdrängt die zweite Anmeldung desselben Kontos und bucht den alten
     * Einsatz als versenkt ab. Zwei Prozesse wissen nichts voneinander — ohne
     * diese Sperre führe dieselbe Schiffs-INSTANZ auf beiden Karten zugleich,
     * mit doppelter Beute und zwei Schadensmeldungen auf denselben Rumpf. Die
     * Reservierung deckt das nicht ab: sobald der Spieler drüben verbunden ist,
     * räumt free() sie weg — genau ab da stünde der Weg hier offen.
     *
     * Schweigt eine Karte, lassen wir durch (Verfügbarkeit vor Perfektion, wie
     * in der Werft): ein toter ocean04-Prozess darf ocean01 nicht dichtmachen.
     */
    for (const [andereKarte, andererStatus] of statusVon) {
      if (andereKarte === mapId) continue;
      if (andererStatus?.accounts.includes(socket.data.accountId)) {
        socket.emit('queue:error', {
          message: `Dieses Konto ist gerade auf ${andereKarte} im Einsatz — erst dort aussteigen.`,
        });
        return;
      }
    }

    /*
     * Eine offene Reservierung auf einer ANDEREN Karte zuerst klären — vor dem
     * synchronen Abschnitt unten. Ihr Schicksal steht ausschließlich im Status
     * ihrer eigenen Karte: eingelöst (der Spieler ist dort im Einsatz) oder
     * ungenutzt verfallen (die Munition kommt zurück). Ohne diesen Schritt
     * bliebe sie liegen, bis ihre Karte selbst wieder gefragt wird — und die
     * Ticketausgabe unten überschriebe sie samt Lieferschein, die abgebuchte
     * Munition wäre für immer weg.
     */
    const fremd = this.reservations.get(socket.data.accountId);
    if (fremd && fremd.mapId !== mapId) {
      const fremdStatus = statusVon.get(fremd.mapId) ?? null;
      if (!fremdStatus) {
        // Schweigt die andere Karte, wissen wir nicht, ob ihr Ticket noch lebt.
        // Dann lieber hier abweisen als drüben doppelt buchen.
        socket.emit('queue:error', {
          message: `Karte ${fremd.mapId} ist nicht erreichbar — dort steht noch ein Ticket offen.`,
        });
        return;
      }
      this.free(fremd.mapId, fremdStatus);
    }

    const status = statusVon.get(mapId) ?? null;
    if (!status) {
      socket.emit('queue:error', { message: 'Spielserver ist nicht erreichbar.' });
      return;
    }

    /*
     * Aus den Schlangen der anderen Karten austragen: ein Konto steht in
     * höchstens EINER. Der Takt jener Karte fragt handleJoin nicht — bliebe der
     * alte Eintrag stehen, stellte er später ein zweites Ticket zu, während der
     * Spieler hier längst auf See ist (die Sperre oben greift nur beim Klick,
     * nicht im Takt). `queue:leave` trägt aus demselben Grund aus allen aus.
     */
    for (const andereKarte of KNOWN_MAPS) {
      if (andereKarte !== mapId) await this.queue.leave(andereKarte, socket.data.accountId);
    }

    const waiting = await this.queue.size(mapId);

    // Ab hier bis zur Reservierung in issueTicket kein await mehr: free()
    // (räumt nebenbei eingelöste und verfallene Reservierungen), das
    // Ticket-Gate und das Setzen der neuen Reservierung liegen in EINEM
    // synchronen Abschnitt — zwei gleichzeitige Joins können so weder den
    // letzten Platz noch dasselbe Konto doppelt belegen.
    const freeSlots = this.free(mapId, status);

    // Steht noch ein offenes Ticket aus, wird es erneut zugestellt statt
    // erneut kassiert — Doppelklick und zweiter Reiter sind damit idempotent.
    const reservation = this.reservations.get(socket.data.accountId);
    if (reservation && reservation.expiresAt > Date.now()) {
      const pending = this.pendingTickets.get(socket.data.accountId);
      if (pending && pending.expiresAt > Date.now()) {
        if (pending.mapId !== mapId) {
          // Das offene Ticket gehört einer anderen Karte. Es hier erneut
          // zuzustellen schickte den Spieler heimlich dorthin, ein zweites
          // auszustellen buchte seine Munition ein zweites Mal ab — also
          // beides nicht, sondern eine Ansage.
          socket.emit('queue:error', {
            message: `Es steht noch ein Ticket für ${pending.mapId} offen — erst nutzen oder ablaufen lassen.`,
          });
          return;
        }
        socket.emit('queue:ticket', {
          mapId: pending.mapId,
          ticket: pending.ticket,
          gameUrl: this.publicUrl(pending.mapId),
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
      await this.issueTicket(socket.data.accountId, socket.data.name, mapId, shipId);
      return;
    }

    const position = await this.queue.join(mapId, {
      accountId: socket.data.accountId,
      name: socket.data.name,
      shipId,
      joinedAt: Date.now(),
    });
    socket.emit('queue:update', { mapId, position, size: await this.queue.size(mapId) });
    this.ensureTimer();
  }

  /**
   * Freie Plätze DIESER Karte, abzüglich der für sie vergebenen, noch offenen
   * Tickets — und räumt dabei ihre erledigten Reservierungen.
   *
   * `status` beschreibt genau EINEN Spielserver, deshalb bleiben Reservierungen
   * fremder Karten hier unangetastet — auch die längst abgelaufenen. Denn
   * „abgelaufen" heißt für sich genommen nicht „ungenutzt": ob ein Ticket
   * eingelöst wurde, steht ALLEIN in `accounts`/`redeemed` seiner eigenen
   * Karte. Wer alle Reservierungen über einen Kamm schöre, erstattete einem
   * Spieler auf ocean04 die Munition, während er sie gerade verschießt — und
   * rechnete sie obendrein gegen die Kapazität von ocean01. Jede Reservierung
   * wird darum ausschließlich am Status ihrer Karte gemessen; wer sie sonst
   * anfassen will, holt sich vorher deren Status (siehe handleJoin, Sweeper).
   */
  private free(mapId: string, status: GameServerStatus): number {
    const now = Date.now();
    const eingeloest = new Set(status.redeemed);
    let vergeben = 0;
    for (const [accountId, reservation] of this.reservations) {
      if (reservation.mapId !== mapId) continue;
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
        // Verfallen ohne Einlösung: Platz wieder frei und die abgebuchte
        // Munition zurück — sie ist nie an Bord gegangen. Fire-and-forget,
        // damit free() synchron bleibt. (Das Schiff bleibt unversehrt: ohne
        // Einlösung gab es keinen Einsatz und damit keine Schadensmeldung.)
        this.reservations.delete(accountId);
        this.pendingTickets.delete(accountId);
        this.returnAmmo(accountId, reservation.loadout);
      } else {
        vergeben += 1;
      }
    }
    return status.capacity - status.players - vergeben;
  }

  /**
   * Schreibt Munition zurück aufs Konto.
   *
   * Zwei Wege führen hierher: ein Ticket ist ungenutzt verfallen (dann kommt
   * alles zurück), oder ein Einsatz ist zu Ende und der Spielserver meldet,
   * was übrig ist. Fire-and-forget mit Protokoll im Fehlerfall — der Aufrufer
   * (Sweep bzw. HTTP-Handler) soll daran nicht hängen.
   */
  returnAmmo(accountId: string, loadout: readonly LoadoutEntryStack[]): void {
    for (const posten of loadout) {
      if (posten.count <= 0 || !isItemId(posten.itemId)) continue;
      this.inventory.credit(accountId, posten.itemId, posten.count).catch((error) => {
        console.error(
          `[api] Rückgabe von ${posten.count}× ${posten.itemId} an ${accountId} fehlgeschlagen:`,
          error,
        );
      });
    }
  }

  /**
   * Stellt das Ticket aus — nach FRISCHER Prüfung der Schiffs-Instanz.
   *
   * Liefert false, wenn das Schiff nicht (mehr) auslaufen kann — der Aufrufer
   * im Schlangen-Takt darf den freien Platz dann an den Nächsten geben.
   */
  private async issueTicket(
    accountId: string,
    name: string,
    mapId: string,
    shipId: string,
  ): Promise<boolean> {
    /*
     * Hält das Konto schon einen Platz auf einer ANDEREN Karte, gibt es hier
     * kein Ticket. Der Schlangen-Takt kommt sonst an handleJoin vorbei in diese
     * Lage: wer auf ocean04 wartet und im Zweittab ocean01 sofort betritt, steht
     * weiter in der Schlange von ocean04 — deren nächster Takt überschriebe die
     * frische ocean01-Reservierung samt Lieferschein, und die abgebuchte
     * Munition käme nie zurück. Ausgereiht wird er trotzdem, sonst scheiterte er
     * als Kopf der Schlange in jedem Takt aufs Neue und hielte alle dahinter auf.
     *
     * Auch eine ABGELAUFENE fremde Reservierung blockt: ob ihr Ticket eingelöst
     * wurde, weiß nur der Spielserver ihrer Karte. Der Sweeper klärt das
     * innerhalb von 5 Sekunden, danach ist der Weg frei.
     */
    const fremd = this.reservations.get(accountId);
    if (fremd && fremd.mapId !== mapId) {
      await this.queue.leave(mapId, accountId);
      this.io
        .of('/lobby')
        .to(`account:${accountId}`)
        .emit('queue:error', {
          message: `Es steht noch ein Ticket für ${fremd.mapId} offen — erst nutzen oder ablaufen lassen.`,
        });
      return false;
    }

    // Reservierung SOFORT, vor dem ersten await: ab jetzt zählt free() diesen
    // Platz als vergeben, und das Gate in handleJoin blockt weitere Tickets
    // für dasselbe Konto. Würde sie erst nach Prüfung und Signatur gesetzt,
    // sähen zwei parallele Joins beide den letzten freien Platz.
    const expiresAt = Date.now() + env.ticketTtl * 1000;
    const reservation: Reservation = { mapId, expiresAt, loadout: [] };
    this.reservations.set(accountId, reservation);
    this.ensureSweeper();

    // Aus der Schlange — auch bei gescheiterter Prüfung. Bliebe der Eintrag
    // stehen, würde er als Kopf der Schlange jeden Takt erneut scheitern und
    // alle dahinter blockieren.
    await this.queue.leave(mapId, accountId);

    // Die Instanz FRISCH prüfen, nicht den Stand vom Einreihen: im Zweittab
    // kann inzwischen eine Reparatur gestartet oder das Schiff bereits in
    // einem anderen Einsatz beschädigt worden sein.
    const ship = await this.werft.shipOf(accountId, shipId);
    if (!ship || ship.repairUntil !== null || ship.hp <= 0) {
      this.reservations.delete(accountId);
      this.io
        .of('/lobby')
        .to(`account:${accountId}`)
        .emit('queue:error', {
          message: !ship
            ? 'Schiff nicht gefunden.'
            : ship.repairUntil !== null
              ? 'Schiff ist in Reparatur.'
              : 'Schiff ist schwer beschädigt — erst reparieren.',
        });
      return false;
    }
    const shipModel = ship.model;

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
    const loadout: LoadoutEntryStack[] = [];
    try {
      const loadouts = await this.inventory.loadouts(accountId);
      const belegt = (slot: string) =>
        loadouts.find((l) => l.model === shipModel && l.slot === slot) ?? null;

      armorItem = belegt('panzerung')?.itemId ?? null;

      /*
       * Munition an Bord nehmen. Für jeden belegten Waffen-Slot geht die in
       * der Werft gewählte WUNSCHMENGE des Items mit (`null` = alles, was da
       * ist) — und wird dabei abgebucht. Das Ticket ist damit zugleich der
       * Lieferschein; mehr als der Bestand geht nie, take() deckelt.
       *
       * Abgebucht wird VOR dem Einsatz, nicht danach: sonst könnte man alles
       * verschießen und vor der Abrechnung die Verbindung kappen. So kostet
       * genau dieser Griff die gewählte Menge — der Anreiz zeigt in die
       * richtige Richtung. Was übrig bleibt, meldet der Spielserver am Ende
       * zurück.
       */
      for (const kategorie of AMMO_CATEGORIES) {
        const eintrag = belegt(kategorie);
        const itemId = eintrag?.itemId;
        if (!itemId || !isItemId(itemId)) continue;
        const weapon = WEAPON_FOR_CATEGORY[kategorie];
        if (!weapon) continue;
        const count = await this.inventory.take(accountId, itemId, eintrag.count);
        if (count <= 0) continue;
        loadout.push({ weapon, itemId, count });
        // Sofort in die Reservierung: verfällt das Ticket ungenutzt, weiß
        // free() dadurch, was zurückzugeben ist — auch wenn die Schleife
        // gleich darauf abbricht.
        reservation.loadout.push({ weapon, itemId, count });
      }
    } catch (error) {
      // Ohne lesbares Inventar läuft der Einsatz unbewaffnet statt gar nicht:
      // die Ausrüstung ist Ausstattung, kein Zugangsrecht. Verlorene Munition
      // kann es dabei nicht geben — abgebucht wird erst beim erfolgreichen
      // take, und dessen Ergebnis steht dann auch im Ticket.
      console.warn('[api] Ausrüstung für das Ticket nicht lesbar:', error);
    }

    const { ticket, jti } = await signTicket({
      sub: accountId,
      name,
      mapId,
      role: account.role,
      shipModel,
      armorItem,
      loadout,
      // Momentaufnahme wie die Rolle: das Level zum Zeitpunkt der Ausgabe —
      // fremde Spieler sehen es beim Anklicken als Rang auf dem Namensschild.
      level: progressionFromXp(account.xp).level,
      // Die Instanz selbst: Ziel der Schadensmeldung, Perks für die Wirkung,
      // Rest-HP als Start-HP — alles api-signiert, nichts davon fälschbar.
      shipId: ship.id,
      // Auf die Slot-Zahl des Katalogs gekappt: senkt ein Entwickler
      // ships.perk_slots unter eine Bestands-Beladung, fährt der Überhang
      // NICHT mit — die Werft zeigt ihn als Überzahl zum Ausbauen an.
      perks: isPlayableModel(ship.model)
        ? ship.perks.slice(0, this.werft.perkSlots(ship.model))
        : ship.perks,
      startHp: ship.hp,
    });

    // Fürs idempotente Wieder-Zustellen aufheben (Doppelklick, Reconnect
    // innerhalb der Gültigkeit) — geräumt wird in free(), sobald das Ticket
    // eingelöst wurde oder verfallen ist.
    this.pendingTickets.set(accountId, { mapId, ticket, jti, expiresAt });

    // Die öffentliche Adresse GENAU DIESER Karte — sie entscheidet, mit welchem
    // Spielserver-Prozess sich der Client gleich verbindet.
    this.io.of('/lobby').to(`account:${accountId}`).emit('queue:ticket', {
      mapId,
      ticket,
      gameUrl: this.publicUrl(mapId),
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
   * gibt so viele Tickets aus, wie Plätze frei sind. Jede Karte hat ihren
   * eigenen Prozess: Kapazität, Status und Warteschlange bleiben getrennt,
   * eine unerreichbare Karte hält die anderen nicht auf.
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

      const status = await fetchGameServerStatus(mapId);
      if (!status) continue;

      let free = this.free(mapId, status);
      while (free > 0) {
        const next = await this.queue.peek(mapId);
        if (!next) break;
        // Nur ein AUSGESTELLTES Ticket belegt einen Platz — wessen Schiff
        // inzwischen nicht mehr auslaufen kann, fliegt raus (issueTicket
        // räumt ihn aus der Schlange) und der Platz geht an den Nächsten.
        if (await this.issueTicket(next.accountId, next.name, mapId, next.shipId)) free -= 1;
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
