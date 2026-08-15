import type { PlayableModel, ShipStats } from '@subwarfare/shared';
import {
  DEFAULT_SHIP_STATS,
  SHIP_PRICES,
  SHIP_SLOTS,
  repairCost,
  repairSeconds,
} from '@subwarfare/shared';
import type { AccountStore } from '../accounts/store.js';
import { fetchGameServerStatus } from '../gameserver/status.js';
import type { AccountShip, WerftStore } from './store.js';

/** Die beiden Starter-Schiffe — jedes neue (oder alte, leere) Konto bekommt sie. */
const STARTER_MODELS: readonly PlayableModel[] = ['fregatte01', 'submarine01'];

/**
 * Werft-Regeln über dem Store: Lazy-Seeding, Lazy-Reparaturabschluss, Kauf
 * und Reparatur — alles je Konto unter einem Promise-Lock, damit Doppelklick,
 * Zweittab und parallele interne Meldungen keine Slots überbuchen oder
 * Reparaturen doppelt starten. Ein api-Prozess, deshalb reicht das Lock.
 */
export class WerftService {
  private readonly maxHpByModel = new Map<string, number>();
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly store: WerftStore,
    private readonly accounts: AccountStore,
    shipStats: readonly ShipStats[],
  ) {
    // maxHp aus der beim Start geladenen ships-Tabelle — wie beim game-server
    // greifen DB-Änderungen erst mit Neustart. Fallback: Code-Katalog.
    for (const stats of shipStats) this.maxHpByModel.set(stats.model, stats.hp);
  }

  maxHp(model: PlayableModel): number {
    return this.maxHpByModel.get(model) ?? DEFAULT_SHIP_STATS[model].hp;
  }

  /**
   * Alle Schiffe des Kontos — nach Seeding, Reparatur-Abschluss und HP-Clamp.
   * Das ist der EINZIGE Leseweg; wer hier vorbeigeht, sieht rohe Zeilen.
   */
  list(accountId: string): Promise<AccountShip[]> {
    return this.withLock(accountId, () => this.listLocked(accountId));
  }

  async shipOf(accountId: string, shipId: string): Promise<AccountShip | null> {
    const ships = await this.list(accountId);
    return ships.find((ship) => ship.id === shipId) ?? null;
  }

  buy(accountId: string, model: PlayableModel): Promise<'ok' | 'poor' | 'full'> {
    return this.withLock(accountId, async () => {
      // Erst die Lazy-Pfade ziehen (Seeding zählt mit in die Slots!).
      const ships = await this.listLocked(accountId);
      if (ships.length >= SHIP_SLOTS) return 'full';

      const price = SHIP_PRICES[model];
      if (price > 0 && !(await this.accounts.spendCoins(accountId, price))) return 'poor';
      try {
        await this.store.add(accountId, model, this.maxHp(model));
      } catch (error) {
        // Abgebucht, aber kein Schiff — das Geld geht zurück (Rollback-Muster
        // wie bei der Ticketausgabe).
        if (price > 0) {
          await this.accounts.addCoins(accountId, price).catch((rollbackError) => {
            console.error(`[api] Kauf-Rollback für ${accountId} fehlgeschlagen:`, rollbackError);
          });
        }
        throw error;
      }
      return 'ok';
    });
  }

  repair(
    accountId: string,
    shipId: string,
  ): Promise<'ok' | 'poor' | 'busy' | 'intact' | 'atsea' | 'notfound'> {
    return this.withLock(accountId, async () => {
      const ships = await this.listLocked(accountId);
      const ship = ships.find((eintrag) => eintrag.id === shipId);
      if (!ship) return 'notfound';
      if (ship.repairUntil !== null) return 'busy';
      const maxHp = this.maxHp(ship.model);
      if (ship.hp >= maxHp) return 'intact';

      // Nicht reparieren, was gerade auf See ist — der Einsatz meldet seinen
      // Schaden erst am Ende. Ist der Spielserver nicht erreichbar, lassen
      // wir die Reparatur zu (Verfügbarkeit vor Perfektion).
      try {
        const status = await fetchGameServerStatus();
        if (status?.accounts.includes(accountId)) return 'atsea';
      } catch {
        // Status unerreichbar — zulassen.
      }

      const cost = repairCost(ship.model, ship.hp, maxHp);
      if (cost > 0 && !(await this.accounts.spendCoins(accountId, cost))) return 'poor';
      const seconds = repairSeconds(ship.model, ship.hp, maxHp);
      try {
        await this.store.setRepair(shipId, new Date(Date.now() + seconds * 1000));
      } catch (error) {
        if (cost > 0) {
          await this.accounts.addCoins(accountId, cost).catch((rollbackError) => {
            console.error(
              `[api] Reparatur-Rollback für ${accountId} fehlgeschlagen:`,
              rollbackError,
            );
          });
        }
        throw error;
      }
      return 'ok';
    });
  }

  setPerks(accountId: string, shipId: string, perks: string[]): Promise<'ok' | 'notfound'> {
    return this.withLock(accountId, async () => {
      const ships = await this.listLocked(accountId);
      const ship = ships.find((eintrag) => eintrag.id === shipId);
      if (!ship) return 'notfound';
      await this.store.setPerks(shipId, perks);
      return 'ok';
    });
  }

  /**
   * Schadensmeldung des Spielservers. Ownership-Prüfung ist Pflicht — der
   * interne Kanal ist vertrauenswürdig, aber ein Meldefehler drüben darf nie
   * ein fremdes Schiff treffen. Clamp 0..maxHp; laufende Reparaturen bleiben
   * unangetastet (die Instanz war dann ohnehin nicht auf See).
   */
  applyDamage(accountId: string, shipId: string, hp: number): Promise<boolean> {
    return this.withLock(accountId, async () => {
      const ship = await this.store.byId(shipId);
      if (!ship || ship.accountId !== accountId) return false;
      const maxHp = this.maxHp(ship.model);
      const wert = Math.max(0, Math.min(Math.floor(hp), maxHp));
      await this.store.setHp(shipId, wert);
      return true;
    });
  }

  /** Seeding + Reparatur-Abschluss + Clamp — nur unterm Lock aufrufen. */
  private async listLocked(accountId: string): Promise<AccountShip[]> {
    let ships = await this.store.list(accountId);

    // Lazy-Seeding: ein Konto ohne Schiffe bekommt die Starter — deckt neue
    // Konten UND Bestandskonten vor dem Umbau ab, ohne Daten-Migration.
    if (ships.length === 0) {
      for (const model of STARTER_MODELS) {
        await this.store.add(accountId, model, this.maxHp(model));
      }
      ships = await this.store.list(accountId);
    }

    const now = Date.now();
    for (const ship of ships) {
      const maxHp = this.maxHp(ship.model);
      if (ship.repairUntil !== null && ship.repairUntil.getTime() <= now) {
        await this.store.completeRepair(ship.id, maxHp);
        ship.hp = maxHp;
        ship.repairUntil = null;
      } else if (ship.hp > maxHp) {
        // Rebalance nach unten: nie mehr HP zeigen (oder signieren) als das
        // Modell heute hat. Persistiert erst mit der nächsten Meldung.
        ship.hp = maxHp;
      }
    }
    return ships;
  }

  /** Serialisiert alle Werft-Operationen eines Kontos (Promise-Kette). */
  private withLock<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(accountId) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    // Fehler nicht in der Kette halten — der Nächste startet frisch.
    this.locks.set(
      accountId,
      next.catch(() => {}),
    );
    return next;
  }
}
