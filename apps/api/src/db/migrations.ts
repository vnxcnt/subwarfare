/**
 * Schema-Migrationen.
 *
 * Als TypeScript-Modul und nicht als `.sql`-Dateien: `tsc` kopiert keine
 * Fremddateien nach `dist`, das Deploy auf dem VPS startet aber genau von
 * dort. Eingebettet gibt es keine Pfadauflösung zur Laufzeit und damit auch
 * keinen Fall, in dem die Migration erst auf dem Server fehlt.
 *
 * Regeln: aufsteigende `id`, niemals eine bestehende Migration ändern —
 * angewandte Migrationen sind in `schema_migrations` festgehalten und werden
 * nicht erneut ausgeführt.
 */
export interface Migration {
  id: number;
  name: string;
  /** Einzeln ausgeführt: mysql2 führt pro Aufruf nur eine Anweisung aus. */
  statements: string[];
}

export const MIGRATIONS: readonly Migration[] = [
  {
    id: 1,
    name: 'accounts',
    statements: [
      `CREATE TABLE IF NOT EXISTS accounts (
         id CHAR(36) NOT NULL PRIMARY KEY,
         google_sub VARCHAR(64) NULL,
         email VARCHAR(255) NULL,
         display_name VARCHAR(24) NOT NULL,
         avatar_url VARCHAR(512) NULL,
         is_dev TINYINT(1) NOT NULL DEFAULT 0,
         created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
         last_login_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
         UNIQUE KEY uq_accounts_google_sub (google_sub),
         KEY idx_accounts_last_login (last_login_at)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      // Entwickler-Konten hängen am Namen. Der Unique-Index steht nur auf
      // dieser Teilmenge, damit ein Google-Nutzer denselben Anzeigenamen
      // trotzdem führen darf.
      `CREATE TABLE IF NOT EXISTS dev_accounts (
         display_name_key VARCHAR(24) NOT NULL PRIMARY KEY,
         account_id CHAR(36) NOT NULL,
         CONSTRAINT fk_dev_accounts_account FOREIGN KEY (account_id)
           REFERENCES accounts (id) ON DELETE CASCADE
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    ],
  },
  {
    id: 2,
    name: 'discord-login',
    statements: [
      // Discords Snowflake-ID ist die unveränderliche Nutzerkennung — analog
      // zu google_sub. Nutzername und Anzeigename können sich jederzeit ändern.
      `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS discord_id VARCHAR(32) NULL AFTER google_sub`,
      `ALTER TABLE accounts ADD UNIQUE KEY IF NOT EXISTS uq_accounts_discord_id (discord_id)`,
    ],
  },
  {
    id: 3,
    name: 'coins-und-xp',
    statements: [
      // Guthaben in der Spielwährung. Vergabe und Abzug laufen ausschließlich
      // server-seitig — der Client zeigt nur an.
      `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS coins INT UNSIGNED NOT NULL DEFAULT 0`,
      // Nur der XP-GESAMTSTAND. Level und Rang werden mit progressionFromXp
      // aus @subwarfare/shared abgeleitet — ein gespeichertes Level könnte dem
      // XP-Stand widersprechen und müsste bei jeder Kurvenänderung migriert
      // werden.
      `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS xp INT UNSIGNED NOT NULL DEFAULT 0`,
    ],
  },
  {
    id: 4,
    name: 'kontorollen',
    statements: [
      // 0 = normaler Spieler (Default), 1 = Moderator, 2 = Gamemaster,
      // 3 = Entwickler. Vergeben wird ausschliesslich per Hand in der DB —
      // es gibt bewusst keinen API-Endpunkt dafuer.
      `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS role TINYINT UNSIGNED NOT NULL DEFAULT 0`,
    ],
  },
  {
    id: 5,
    name: 'schiffe',
    statements: [
      // Basiswerte der Schiffe. Gepflegt per Hand (phpMyAdmin); der Seed
      // unten spiegelt DEFAULT_SHIP_STATS aus @subwarfare/shared — beide
      // Quellen muessen beim Anlegen uebereinstimmen, danach fuehrt die DB.
      // type: 1 = NPC, 2 = Submarine, 3 = Vessel.
      // speed: Faktor relativ zum Basiswert 1 (= Fregatte, 30 m/s).
      `CREATE TABLE IF NOT EXISTS ships (
         model VARCHAR(32) NOT NULL PRIMARY KEY,
         hp INT UNSIGNED NOT NULL,
         type TINYINT UNSIGNED NOT NULL,
         armament JSON NOT NULL,
         speed DECIMAL(4,2) NOT NULL DEFAULT 1.00
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `INSERT INTO ships (model, hp, type, armament, speed) VALUES
         ('fregatte01', 500, 3, '["torpedo","wasserbombe","taeuschkoerper","geschuetz"]', 1.00),
         ('submarine01', 350, 2, '["torpedo","taeuschkoerper"]', 0.70),
         ('speedster01', 150, 1, '["geschuetz"]', 1.30),
         ('yachtgun01', 200, 1, '["geschuetz"]', 1.30)
       ON DUPLICATE KEY UPDATE model = model`,
    ],
  },
  {
    id: 6,
    name: 'schiffe-welle-zwei',
    statements: [
      // Zweite Modellwelle. Werte wie in DEFAULT_SHIP_STATS — danach führt
      // wie immer die Tabelle (Anpassungen per phpMyAdmin).
      `INSERT INTO ships (model, hp, type, armament, speed) VALUES
         ('tanker01', 800, 1, '[]', 0.50),
         ('fregatte02', 550, 3, '["torpedo","wasserbombe","taeuschkoerper","geschuetz"]', 0.95),
         ('submarine02', 450, 2, '["torpedo","taeuschkoerper"]', 0.65),
         ('destroyer01', 650, 3, '["torpedo","wasserbombe","taeuschkoerper","geschuetz"]', 1.10)
       ON DUPLICATE KEY UPDATE model = model`,
    ],
  },
  {
    id: 7,
    name: 'inventar-und-werft',
    statements: [
      // Item-BESITZ je Konto. Der Katalog (Namen, Preise, Kategorien) lebt im
      // Code (`@subwarfare/shared`, ITEMS) — hier steht nur, wer wie viele
      // wovon hat. Kein Fremdschlüssel auf einen Item-Katalog: den gibt es als
      // Tabelle bewusst nicht.
      `CREATE TABLE IF NOT EXISTS account_items (
         account_id CHAR(36) NOT NULL,
         item_id VARCHAR(32) NOT NULL,
         quantity INT UNSIGNED NOT NULL DEFAULT 0,
         PRIMARY KEY (account_id, item_id),
         CONSTRAINT fk_account_items_account FOREIGN KEY (account_id)
           REFERENCES accounts (id) ON DELETE CASCADE
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      // Ausrüstungs-Zuordnung je Konto und Schiff: welcher Slot (Kategorie)
      // trägt welches Item. Ein Slot, ein Item — der Primärschlüssel erzwingt
      // das. Leere Slots stehen nicht in der Tabelle.
      `CREATE TABLE IF NOT EXISTS ship_loadouts (
         account_id CHAR(36) NOT NULL,
         model VARCHAR(32) NOT NULL,
         slot VARCHAR(16) NOT NULL,
         item_id VARCHAR(32) NOT NULL,
         PRIMARY KEY (account_id, model, slot),
         CONSTRAINT fk_ship_loadouts_account FOREIGN KEY (account_id)
           REFERENCES accounts (id) ON DELETE CASCADE
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      // Dritte Modellwelle: der Endgame-Zerstörer.
      `INSERT INTO ships (model, hp, type, armament, speed) VALUES
         ('destroyer02', 750, 3, '["torpedo","wasserbombe","taeuschkoerper","geschuetz"]', 1.15)
       ON DUPLICATE KEY UPDATE model = model`,
    ],
  },
  {
    id: 8,
    name: 'fregatten-ohne-torpedos',
    statements: [
      // Rollenschärfung: Fregatten sind Geleitschiffe (Geschütz +
      // Wasserbomben), Torpedo und Täuschkörper bleiben den Zerstörern.
      // Bewusst ein gezieltes UPDATE statt eines Seeds — die Spalte trägt hier
      // Spielregeln, keine Feinabstimmung, und muss deshalb wirklich umziehen.
      `UPDATE ships SET armament = '["wasserbombe","geschuetz"]'
        WHERE model IN ('fregatte01', 'fregatte02')`,
    ],
  },
  {
    id: 9,
    name: 'panzerung',
    statements: [
      // Panzerungswerte. Gepflegt per Hand (phpMyAdmin) wie die ships-Tabelle;
      // der Seed spiegelt DEFAULT_ARMOR_STATS aus @subwarfare/shared — beide
      // Quellen muessen beim Anlegen uebereinstimmen, danach fuehrt die DB.
      //
      // absorb ist der ANTEIL des Schadens, den die Panzerung schluckt (0..1),
      // NICHT ihre Haltbarkeit. Die Haltbarkeit (Integritaet) laeuft je Einsatz
      // im Spielserver und steht nicht in der Datenbank.
      //
      // level ist reine Dokumentation der Reihenfolge: gerechnet wird mit
      // absorb. Wer eine Stufe anders auslegen will, aendert absorb direkt und
      // ist nicht an die 25-%-plus-10-Regel gebunden.
      `CREATE TABLE IF NOT EXISTS armor (
         item_id VARCHAR(32) NOT NULL PRIMARY KEY,
         level TINYINT UNSIGNED NOT NULL,
         absorb DECIMAL(4,3) NOT NULL
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `INSERT INTO armor (item_id, level, absorb) VALUES
         ('panzerung_mk1', 1, 0.250),
         ('panzerung_mk2', 2, 0.350),
         ('panzerung_mk3', 3, 0.450),
         ('panzerung_mk4', 4, 0.550),
         ('panzerung_mk5', 5, 0.650)
       ON DUPLICATE KEY UPDATE item_id = item_id`,
    ],
  },
  {
    id: 10,
    name: 'munition',
    statements: [
      // Kampfwerte der Munitionssorten. Gepflegt per Hand wie ships und armor;
      // der Seed spiegelt DEFAULT_AMMO_STATS aus @subwarfare/shared.
      //
      // `weapon` sagt, welche Waffe das Item speist — der Slot `munition` heisst
      // nach dem Kaliber, geschossen wird damit aus dem Geschuetz.
      //
      // Die STUECKZAHL steht bewusst NICHT hier: die kommt aus dem Inventar des
      // Kontos (account_items.quantity). Diese Tabelle beantwortet nur, wie hart
      // ein Treffer dieser Sorte zuschlaegt.
      `CREATE TABLE IF NOT EXISTS weapon_items (
         item_id VARCHAR(32) NOT NULL PRIMARY KEY,
         weapon VARCHAR(16) NOT NULL,
         damage SMALLINT UNSIGNED NOT NULL
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `INSERT INTO weapon_items (item_id, weapon, damage) VALUES
         ('torpedo_mk1', 'torpedo', 150),
         ('torpedo_mk2', 'torpedo', 175),
         ('torpedo_mk3', 'torpedo', 205),
         ('torpedo_mk4', 'torpedo', 235),
         ('torpedo_mk5', 'torpedo', 270),
         ('wasserbombe', 'wasserbombe', 140),
         ('taeuschkoerper', 'taeuschkoerper', 0),
         ('munition_mk1', 'geschuetz', 40),
         ('munition_mk2', 'geschuetz', 46),
         ('munition_mk3', 'geschuetz', 53)
       ON DUPLICATE KEY UPDATE item_id = item_id`,
    ],
  },
  {
    id: 11,
    name: 'loadout-menge',
    statements: [
      // Wunschmenge je Slot-Belegung: wie viel Munition in den Einsatz
      // mitgehen soll. NULL heisst "alles, was da ist" - das bisherige
      // Verhalten und der Stand aller bestehenden Zeilen. Abgebucht wird beim
      // Auslaufen hoechstens der tatsaechliche Bestand (take() deckelt).
      `ALTER TABLE ship_loadouts ADD COLUMN wish_count INT UNSIGNED NULL`,
    ],
  },
  {
    id: 12,
    name: 'dev-accounts-nachziehen',
    statements: [
      // Reparatur: dev_accounts wurde seinerzeit NACHTRÄGLICH in die längst
      // angewandte Migration 1 geschrieben (Verstoß gegen die Regel oben) —
      // auf Datenbanken, die Migration 1 vorher ausgeführt hatten, fehlt die
      // Tabelle deshalb bis heute. IF NOT EXISTS macht das Nachziehen überall
      // gefahrlos, auch wo sie schon existiert.
      `CREATE TABLE IF NOT EXISTS dev_accounts (
         display_name_key VARCHAR(24) NOT NULL PRIMARY KEY,
         account_id CHAR(36) NOT NULL,
         CONSTRAINT fk_dev_accounts_account FOREIGN KEY (account_id)
           REFERENCES accounts (id) ON DELETE CASCADE
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    ],
  },
  {
    id: 13,
    name: 'flottillen',
    statements: [
      // name_key = kleingeschriebener Name als Unique-Schluessel — zwei
      // Flottillen, die sich nur in Gross-/Kleinschreibung unterscheiden,
      // waeren im Spiel nicht auseinanderzuhalten.
      `CREATE TABLE IF NOT EXISTS fleets (
         id CHAR(36) NOT NULL PRIMARY KEY,
         name VARCHAR(30) NOT NULL,
         name_key VARCHAR(30) NOT NULL,
         description VARCHAR(200) NULL,
         treasury INT UNSIGNED NOT NULL DEFAULT 0,
         created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
         UNIQUE KEY uq_fleets_name_key (name_key)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      // account_id als PRIMARY KEY erzwingt: hoechstens EINE Flottille je
      // Konto. Spalte heisst rang, nicht rank — RANK ist in MariaDB ein
      // Schluesselwort (Window-Funktion) und braeuchte ueberall Backticks.
      `CREATE TABLE IF NOT EXISTS fleet_members (
         account_id CHAR(36) NOT NULL PRIMARY KEY,
         fleet_id CHAR(36) NOT NULL,
         rang TINYINT UNSIGNED NOT NULL DEFAULT 5,
         joined_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
         KEY idx_fleet_members_fleet (fleet_id),
         CONSTRAINT fk_fleet_members_fleet FOREIGN KEY (fleet_id)
           REFERENCES fleets (id) ON DELETE CASCADE,
         CONSTRAINT fk_fleet_members_account FOREIGN KEY (account_id)
           REFERENCES accounts (id) ON DELETE CASCADE
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    ],
  },
  {
    id: 14,
    name: 'statistik',
    statements: [
      // PvP-Zaehler. NUR Spieler-gegen-Spieler — NPC-Abschuesse zaehlen hier
      // nicht (die geben nur XP). Das Level wird weiterhin NIE gespeichert,
      // es leitet sich aus dem xp-Stand ab (siehe meta/progression.ts).
      `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS kills INT UNSIGNED NOT NULL DEFAULT 0`,
      `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS deaths INT UNSIGNED NOT NULL DEFAULT 0`,
    ],
  },
  {
    id: 15,
    name: 'social',
    statements: [
      // Freundschaften: EINE Zeile je Paar, gerichtet (wer hat angefragt).
      // status 0 = angefragt, 1 = angenommen. Der Primary Key verhindert
      // Doppel-Anfragen derselben Richtung; die Gegenrichtung faengt die
      // request-Logik ab (sie nimmt stattdessen an).
      `CREATE TABLE IF NOT EXISTS friendships (
         requester_id CHAR(36) NOT NULL,
         addressee_id CHAR(36) NOT NULL,
         status TINYINT UNSIGNED NOT NULL DEFAULT 0,
         created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
         PRIMARY KEY (requester_id, addressee_id),
         KEY idx_friendships_addressee (addressee_id),
         CONSTRAINT fk_friendships_requester FOREIGN KEY (requester_id)
           REFERENCES accounts (id) ON DELETE CASCADE,
         CONSTRAINT fk_friendships_addressee FOREIGN KEY (addressee_id)
           REFERENCES accounts (id) ON DELETE CASCADE
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      // Gespeicherte Chat-Zeilen (Flottille und Privat; der Hafen bleibt
      // fluechtig). context_id: die fleet_id bzw. der sortierte Paar-Schluessel
      // beider Konten ("a:b"). Loeschung eines Kontos raeumt seine Zeilen mit
      // (CASCADE) — Namen werden beim Lesen aufgeloest, nie gespeichert.
      `CREATE TABLE IF NOT EXISTS chat_messages (
         id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
         channel VARCHAR(16) NOT NULL,
         context_id VARCHAR(80) NOT NULL,
         sender_id CHAR(36) NOT NULL,
         text VARCHAR(200) NOT NULL,
         created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
         KEY idx_chat_context (channel, context_id, id),
         CONSTRAINT fk_chat_sender FOREIGN KEY (sender_id)
           REFERENCES accounts (id) ON DELETE CASCADE
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    ],
  },
  {
    id: 16,
    name: 'werft-schiffe',
    statements: [
      // Schiffs-INSTANZEN je Konto (die 6 Werft-Slots). hp ist die AKTUELLE
      // Rest-HP — das Maximum kommt zur Laufzeit aus der ships-Tabelle und
      // wird bewusst nicht dupliziert. repair_until laeuft lazy aus: beim
      // Lesen nach Ablauf wird hp auf das Maximum gesetzt und die Spalte
      // geleert. perks = verbaute Perk-Item-Ids als JSON-Array. Kein Seed:
      // Bestandskonten bekommen ihre Gratis-Schiffe beim ersten Werft-Abruf
      // (Lazy-Seeding in der Service-Schicht).
      `CREATE TABLE IF NOT EXISTS account_ships (
         id CHAR(36) NOT NULL PRIMARY KEY,
         account_id CHAR(36) NOT NULL,
         model VARCHAR(32) NOT NULL,
         hp INT UNSIGNED NOT NULL,
         repair_until DATETIME NULL,
         perks JSON NOT NULL,
         created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
         KEY idx_account_ships_account (account_id),
         CONSTRAINT fk_account_ships_account FOREIGN KEY (account_id)
           REFERENCES accounts (id) ON DELETE CASCADE
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    ],
  },
  {
    id: 17,
    name: 'moderation',
    statements: [
      // Chatsperre (Moderation): 1 = darf nicht mehr funken. Rein additiv,
      // der Rest des Kontos bleibt nutzbar.
      `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS chat_muted TINYINT UNSIGNED NOT NULL DEFAULT 0`,
      // Kontosperre (BAN): NULL = nicht gesperrt. Ein gesperrtes Konto faellt
      // an JEDEM Auth-Punkt durch (REST, Lobby, Login) — die Begruendung
      // bleibt fuer die Moderation nachlesbar.
      `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS banned_reason VARCHAR(200) NULL`,
      `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS banned_at DATETIME NULL`,
    ],
  },
  {
    id: 18,
    name: 'werft-katalog',
    statements: [
      // Kaufpreis und Perk-Slots ziehen aus dem Code (SHIP_PRICES,
      // PERK_SLOTS_BY_MODEL) in die ships-Tabelle — damit sind sie im
      // Admin-DB-Editor stellbar. Der Seed spiegelt die Code-Werte beim
      // Anlegen; danach fuehrt wie immer die DB (Aenderungen greifen mit dem
      // naechsten Dienst-Neustart). NPC-Modelle bleiben 0/0 — kaufbar ist
      // ohnehin nur, was isPlayableModel kennt.
      `ALTER TABLE ships ADD COLUMN IF NOT EXISTS price INT UNSIGNED NOT NULL DEFAULT 0`,
      `ALTER TABLE ships ADD COLUMN IF NOT EXISTS perk_slots TINYINT UNSIGNED NOT NULL DEFAULT 0`,
      `UPDATE ships SET price = 0,     perk_slots = 1 WHERE model = 'fregatte01'`,
      `UPDATE ships SET price = 2750,  perk_slots = 2 WHERE model = 'fregatte02'`,
      `UPDATE ships SET price = 0,     perk_slots = 1 WHERE model = 'submarine01'`,
      `UPDATE ships SET price = 5650,  perk_slots = 3 WHERE model = 'submarine02'`,
      `UPDATE ships SET price = 12550, perk_slots = 3 WHERE model = 'destroyer01'`,
      `UPDATE ships SET price = 37500, perk_slots = 5 WHERE model = 'destroyer02'`,
    ],
  },
  {
    id: 19,
    name: 'destroyer03',
    statements: [
      // Zwischenstufe der Zerstoerer — traegt die Grafik, die bis Protokoll 19
      // faelschlich als fregatte02 fuhr (fregatte02 hat seither ihren echten
      // Atlas; ihre Werte hier bleiben unveraendert). Seed wie immer =
      // Code-Katalog beim Anlegen, danach fuehrt die DB.
      `INSERT INTO ships (model, hp, type, armament, speed, price, perk_slots) VALUES
         ('destroyer03', 700, 3, '["torpedo","wasserbombe","taeuschkoerper","geschuetz"]', 1.12, 22500, 4)
       ON DUPLICATE KEY UPDATE model = model`,
    ],
  },
  {
    id: 20,
    name: 'uboote-drei-vier',
    statements: [
      // submarine03 = Endgame-Boot (zaeh, teuer, traege), submarine04 =
      // Flinker Jaeger (schnellstes U-Boot, duennhaeutig, guenstig). Seed =
      // Code-Katalog beim Anlegen, danach fuehrt die DB.
      `INSERT INTO ships (model, hp, type, armament, speed, price, perk_slots) VALUES
         ('submarine03', 600, 2, '["torpedo","taeuschkoerper"]', 0.60, 28000, 4),
         ('submarine04', 380, 2, '["torpedo","taeuschkoerper"]', 0.75, 8500, 3)
       ON DUPLICATE KEY UPDATE model = model`,
    ],
  },
  {
    id: 21,
    name: 'schiffsgroesse',
    statements: [
      // Groessenfaktor relativ zur KLASSEN-Basis (fregatte01 bzw. submarine01
      // = 1; Ueberwasser-Basis 140/25 m, U-Boot-Basis 110/13 m). Skaliert
      // Kollision UND Darstellung (scaledHull in shared). Seed = Code-Default
      // (DEFAULT_SHIP_SIZES); danach fuehrt die DB. NPC-Modelle bleiben 1 und
      // behalten ihre eigenen Basis-Masse.
      `ALTER TABLE ships ADD COLUMN IF NOT EXISTS size DECIMAL(3,2) NOT NULL DEFAULT 1.00`,
      `UPDATE ships SET size = 1.10 WHERE model = 'fregatte02'`,
      `UPDATE ships SET size = 1.30 WHERE model = 'submarine02'`,
      `UPDATE ships SET size = 1.40 WHERE model = 'submarine03'`,
      `UPDATE ships SET size = 1.60 WHERE model = 'submarine04'`,
      `UPDATE ships SET size = 1.30 WHERE model = 'destroyer01'`,
      `UPDATE ships SET size = 1.90 WHERE model = 'destroyer02'`,
      `UPDATE ships SET size = 1.50 WHERE model = 'destroyer03'`,
    ],
  },
];
