# Sub Warfare

Persistentes Multiplayer-Browsergame auf einer großen Live-Karte. Spieler betreten
einen Server über **Spawnpunkte**, bewegen sich dort mit ihrem Schiff/U-Boot und
verlassen ihn wieder über definierte **Extraction-/Exit-Zonen**.

> **Stand:** Grundgerüst. Struktur, TypeScript-Setup und Dev-Umgebung stehen —
> Spiellogik gibt es noch nicht.

## Architektur

Monorepo aus zwei Anwendungen und einem gemeinsamen Package:

| Paket                    | Rolle                                                           |
| ------------------------ | --------------------------------------------------------------- |
| `@subwarfare/client`     | Browser-Client: Vue 3 + Vite, Rendering über PixiJS (WebGL)      |
| `@subwarfare/game-server` | Autoritativer Node.js-Server, WebSocket-Listener                |
| `@subwarfare/shared`     | Typen, Interfaces und Netzwerkprotokoll für beide Seiten         |

Grundprinzipien:

- **Der Server ist die einzige Quelle der Wahrheit.** Der Client schickt nur
  Eingabe*absichten* (`throttle`, `rudder`), die Bewegung rechnet der Server.
- **Ein Protokoll, eine Definition.** Alle Nachrichtentypen liegen in
  `@subwarfare/shared` und werden von Client und Server importiert. Bei
  inkompatiblen Änderungen die `PROTOCOL_VERSION` hochzählen.
- **Maps sind Daten, kein Code.** Eine Map ist eine deklarative Definition
  (`width`, `height`, `spawnPoints`, `exitPoints`) — siehe `ocean01`.

Weltkoordinaten: Ursprung (0,0) oben links, x wächst nach Osten, y nach Süden.
Rotationen in Grad, 0 = Norden, im Uhrzeigersinn.

## Voraussetzungen

- **Node.js ≥ 20** (entwickelt mit 24)
- **pnpm** — z. B. `npm install -g pnpm` oder via `corepack enable pnpm`

## Installation

```bash
pnpm install
```

## Development starten

```bash
pnpm dev
```

Startet parallel:

| Prozess             | Adresse                 |
| ------------------- | ----------------------- |
| Client (Vite)       | http://localhost:5173   |
| Game-Server (ws)    | ws://localhost:8080     |
| Shared (tsc --watch) | rebuildet bei Änderung |

Der Client verbindet sich noch **nicht** automatisch. Die Server-URL lässt sich
über `VITE_GAME_SERVER_URL` überschreiben, der Server-Port über `PORT` bzw. `HOST`.

## Build

```bash
pnpm build       # shared -> game-server -> client
pnpm typecheck   # Typprüfung über alle Pakete
pnpm start       # gebauten Game-Server starten
pnpm clean       # dist/-Verzeichnisse entfernen
```

`shared` muss vor den Apps gebaut sein — die Root-Scripts erledigen das
automatisch.

## Ordnerstruktur

```
.
├── apps/
│   ├── client/                     Vue 3 + Vite + PixiJS
│   │   └── src/
│   │       ├── main.ts             Einstiegspunkt, mountet die Vue-App
│   │       ├── App.vue             Vollbild-Stage + minimales HUD
│   │       ├── config/             Server-URL, Renderer-Defaults
│   │       ├── game/
│   │       │   ├── Game.ts         PixiJS-Application, Ticker
│   │       │   ├── World.ts        Wurzel-Container + Kamera
│   │       │   └── entities/       (noch leer)
│   │       └── network/
│   │           └── NetworkClient.ts  typisierter WebSocket-Wrapper
│   │
│   └── game-server/                Node.js + ws
│       └── src/
│           ├── index.ts            Start, Shutdown-Handling
│           ├── server/GameServer.ts  Listener, Verbindungen, Tick-Loop
│           ├── world/World.ts      laufende Map-Instanz
│           ├── entities/Player.ts  Spielerzustand
│           ├── maps/
│           │   ├── MapDefinition.ts  defineMap() inkl. Plausibilitätsprüfung
│           │   └── ocean01.ts        Testkarte 10.000 × 10.000
│           └── network/ClientConnection.ts  ein WebSocket, JSON-Rahmen
│
├── packages/
│   └── shared/
│       └── src/
│           ├── protocol/           ClientMessages.ts, ServerMessages.ts
│           ├── types/              Player, Map, SpawnPoint, ExitPoint
│           └── index.ts            Barrel-Export + PROTOCOL_VERSION
│
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── package.json                    Root-Scripts
```

## Testkarte `ocean01`

10.000 × 10.000 Units offenes Wasser.

| Typ   | ID            | Position       | Sonstiges     |
| ----- | ------------- | -------------- | ------------- |
| Spawn | `spawn-north` | 5.000 / 1.000  | Rotation 180° |
| Spawn | `spawn-south` | 5.000 / 9.000  | Rotation 0°   |
| Exit  | `exit-west`   | 800 / 5.000    | Radius 400    |
| Exit  | `exit-east`   | 9.200 / 5.000  | Radius 400    |

## Noch nicht enthalten

Datenbank (PostgreSQL), Redis, Docker, Authentifizierung, Benutzerverwaltung,
Inventare, Shops, Combat, Torpedos, NPCs, Assets. Kommt schrittweise dazu.
