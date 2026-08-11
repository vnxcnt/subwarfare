export interface QueueEntry {
  accountId: string;
  name: string;
  /** Gewähltes Schiff — bereits gegen Level geprüft; bezahlt wird beim Ticket. */
  shipModel: string;
  /** Millisekunden-Zeitstempel des Einreihens. */
  joinedAt: number;
}

/**
 * Warteschlange je Karte.
 *
 * Durchgehend `async` und mit Ablaufzeit, damit der spätere Umstieg auf Redis
 * nur den Aufbau der Klasse betrifft und keinen Aufrufer: Redis-Listen
 * antworten über das Netz, und Einträge dort brauchen ohnehin eine TTL.
 *
 * Rückgaben sind Kopien. Ein Aufrufer, der einen Eintrag ändert, darf damit
 * nicht den Zustand der Schlange verändern — bei Redis wäre das ohnehin
 * unmöglich, und der Speicher soll sich nicht anders verhalten.
 */
export interface MatchQueue {
  join(mapId: string, entry: QueueEntry): Promise<number>;
  leave(mapId: string, accountId: string): Promise<void>;
  /** Nächster Wartender, ohne ihn zu entfernen. */
  peek(mapId: string): Promise<QueueEntry | null>;
  /** 1-basiert; 0 bedeutet „steht nicht in der Schlange". */
  position(mapId: string, accountId: string): Promise<number>;
  size(mapId: string): Promise<number>;
  /** Alle Wartenden einer Karte in Reihenfolge. */
  list(mapId: string): Promise<QueueEntry[]>;
  /**
   * Lebenszeichen: setzt die Ablauffrist des Eintrags zurück. Der Lobby-Takt
   * ruft das für alle Wartenden mit offener Verbindung — die TTL trifft damit
   * nur noch echte Karteileichen, keine geduldig Wartenden.
   */
  touch(mapId: string, accountId: string): Promise<void>;
}

/** Wartende verfallen nach dieser Zeit — sonst blockieren Karteileichen. */
const ENTRY_TTL_MS = 5 * 60 * 1000;

export class MemoryQueue implements MatchQueue {
  private readonly queues = new Map<string, QueueEntry[]>();

  async join(mapId: string, entry: QueueEntry): Promise<number> {
    const queue = this.queueFor(mapId);
    // Doppeltes Einreihen darf den Platz nicht verbessern — sonst wäre
    // wiederholtes Klicken ein Vordrängeln.
    const existing = queue.findIndex((item) => item.accountId === entry.accountId);
    if (existing >= 0) return existing + 1;

    queue.push({ ...entry });
    return queue.length;
  }

  async leave(mapId: string, accountId: string): Promise<void> {
    const queue = this.queueFor(mapId);
    const index = queue.findIndex((item) => item.accountId === accountId);
    if (index >= 0) queue.splice(index, 1);
  }

  async peek(mapId: string): Promise<QueueEntry | null> {
    const first = this.queueFor(mapId)[0];
    return first ? { ...first } : null;
  }

  async position(mapId: string, accountId: string): Promise<number> {
    return this.queueFor(mapId).findIndex((item) => item.accountId === accountId) + 1;
  }

  async size(mapId: string): Promise<number> {
    return this.queueFor(mapId).length;
  }

  async list(mapId: string): Promise<QueueEntry[]> {
    return this.queueFor(mapId).map((entry) => ({ ...entry }));
  }

  async touch(mapId: string, accountId: string): Promise<void> {
    const entry = this.queueFor(mapId).find((item) => item.accountId === accountId);
    if (entry) entry.joinedAt = Date.now();
  }

  /** Holt die Schlange und wirft dabei Abgelaufene raus. */
  private queueFor(mapId: string): QueueEntry[] {
    let queue = this.queues.get(mapId);
    if (!queue) {
      queue = [];
      this.queues.set(mapId, queue);
    }

    const deadline = Date.now() - ENTRY_TTL_MS;
    // In-place filtern: der Aufrufer arbeitet auf genau diesem Array weiter.
    for (let i = queue.length - 1; i >= 0; i -= 1) {
      if (queue[i]!.joinedAt < deadline) queue.splice(i, 1);
    }
    return queue;
  }
}
