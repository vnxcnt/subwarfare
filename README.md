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

### Darstellung

Die Ansicht ist „schräg von oben": die Welt wird ausschließlich vertikal
gestaucht (Faktor `VIEW.tilt`, aktuell 0,42), nicht gedreht. Nord bleibt oben.
Die Karte erscheint dadurch als liegendes Rechteck, Kreise werden zu Ellipsen.

`tilt` ist geometrisch `sin(Höhenwinkel der Kamera über dem Horizont)` — 0,42
entspricht 24,8°. Er lässt sich zur Laufzeit über `setTilt()` ändern, im
Dev-Build mit den Tasten `[` und `]`; alles andere zieht automatisch nach, weil
die Matrix in place geändert wird und Höhenversätze pro Frame daraus berechnet
werden. Untergrenze `VIEW.minTilt` 0,25: darunter kippt der Eindruck, weil ohne
Perspektive entfernte Dinge nicht kleiner werden und ein Rumpf querab bei
Zoom 1 nur noch 3 px hoch ist.

Das steckt in genau **einer affinen Matrix** in `game/Projection.ts`. Zwei
Konsequenzen, die den Rest der Architektur bestimmen:

- **Der Maßstab ist überall gleich.** Eine Sonarreichweite sieht am oberen
  Bildrand genauso groß aus wie am unteren. Bei echter Perspektive wäre das
  nicht so — für ein Spiel, in dem Distanzen die Kernmechanik sind, wäre das ein
  Lesbarkeitsproblem.
- **Die Umkehrung ist exakt.** Maus zu Weltkoordinate läuft über dieselbe
  Matrix. Zoom auf den Cursor und Ziehen sind dadurch pixelgenau.

Ein Wechsel der Darstellungsart ist ein Zahlentausch in dieser Matrix:
flach von oben `(1, 0, 0, 1)`, gekippt `(1, 0, 0, tilt)`, isometrisch 2:1
`(1, 0.5, -1, 0.5)`. Echte Perspektive ginge damit nicht — die ist nicht affin.

Gerendert wird in drei Ebenen: `groundLayer` und `hullLayer` bekommen die
Projektion (Wasser bzw. Rümpfe — alles, was flach auf dem Wasser liegt),
`entityLayer` bleibt unverzerrt für Text und starre Symbole.

**Grafikbedarf:** Für die Drehung reicht **eine** Grafik pro Schiffstyp. Weil die
Projektion affin ist und keinen Drehanteil hat, ist P·R für jeden Kurs exakt —
die 16/32 Winkelstufen klassischer Isometrie sind hier weder nötig noch
hilfreich (bei 8°/s Wenderate spränge eine 32-Stufen-Grafik nur alle 1,4 s um).

**Höhe** kommt stattdessen aus dem Szenengraph. Dabei gelten zwei
**verschiedene** Regeln, und sie zu verwechseln erzeugt einen Fehler, der wie
ein Kalibrierungsproblem aussieht:

| | Versatz pro Meter Höhe | warum |
| --- | --- | --- |
| Schatten | `(-0,733 , +1,107)` roh | liegt **in** der Wasserebene, der Layer staucht ihn selbst; hängt nur an der Sonne, nicht an `tilt` |
| Aufbauten | `(0 , -√(1-tilt²)/tilt)` lokal | stehen **senkrecht** darauf, müssen um `1/tilt` vorkompensiert werden; bei tilt 0,42 also −2,161 pro Meter |

Beide Versätze gehören an ein **nicht rotierendes** Elternobjekt — sitzt der
Versatz im gedrehten Kind, wandert der Turm mit dem Kurs im Kreis um den Rumpf.
Die Sonnenrichtung stammt aus `WATER.sun` und speist Wasser-Shader und Schatten
gemeinsam. Sichtbar wird fehlende Höhe erst ab `h > 0,659 × Rumpfbreite`.

### Steuerung und Fahrmodell

**Rechtsklick** setzt einen Wegpunkt, das Boot fährt ihn an. Mausrad zoomt,
Ziehen mit links verschiebt. Die Kamera folgt dem Boot, bis man selbst pant.

Das Fahrmodell liegt in `packages/shared/src/sim/` — als reine Funktionen über
flache Daten, ohne Modulzustand, `Date.now()` oder `Math.random()`. Der Grund:
sobald der Server autoritativ rechnet, fährt er **denselben Code**, und das
Fahrverhalten ändert sich dabei nicht. Das ist zugleich die Voraussetzung für
spätere Client-Prediction.

Die Trennung darin ist wichtig: `autopilot()` macht aus einem Wegpunkt einen
`Command` aus `throttle` und `rudder` — genau das, was der Client später als
`InputMessage` schickt. `stepVessel()` integriert diesen Command. Eine spätere
manuelle Ruderlage erzeugt denselben `Command` und läuft durch dieselbe
Integration; es gibt also nie zwei Bewegungssysteme.

Zwei Details, die nicht nach Geschmack sind:

- Integriert wird mit **festem Zeitschritt** (`SIM.fixedDt`, 20 Hz, passend zum
  Server-Tick) über einen Akkumulator. Das Modell ist nichtlinear — die Drehrate
  hängt von der Fahrt ab, die Bremskurve von einer Wurzel — und mit variablem
  `dt` schlicht nicht reproduzierbar.
- Der Autopilot drosselt die Fahrt auf `d² / (2·Querabstand)`. Ohne diese
  geometrische Grenze umkreist ein Boot mit 220 m Wendekreis ein nahes Querziel
  endlos, statt es zu erreichen.

⚠️ Die Physik läuft derzeit **client-seitig** (`Vessel.simulate()`) — ein
Demo-Zustand, der der Regel „der Server ist die einzige Quelle der Wahrheit"
widerspricht. `Vessel.applyState()` ist der vorgesehene Ersatz.

`VESSEL_DEMO.maxForward` in der Client-Config ist eine Design-Entscheidung, keine
technische: 30 m/s (58 kn) gegenüber realistischen ~17 m/s. Bei realistischer
Fahrt dauert eine Kartenkante 9,8 Minuten.

### Bedienoberfläche

Vollbild-Overlay aus vier Panels: Auftragsbuch oben links, Sonar unten links,
Munitionsslots unten mittig, Maschinentelegraf unten rechts. Als Grid, nicht
absolut positioniert — Grid-Kinder können sich strukturell nicht überlagern.

**DOM/Vue statt `@pixi/ui`.** Drei der vier Panels bestehen fast nur aus Text,
Listen und Rasterlayout, und das kann CSS besser. Der entscheidende Nebeneffekt
ist die Eingabetrennung: Kamera- und Fahrbefehl-Listener hängen am
Canvas-Element, ein DOM-Panel ist dessen Geschwister und fängt Rad, Klick und
Rechtsklick geschenkt ab. Ein Panel im selben Canvas bräuchte in beiden
Controllern einen Hit-Test-Guard. `@pixi/ui` wäre erst für **In-Welt**-Elemente
sinnvoll, wo die Kameramatrix gelten muss.

Das Sonar ist ein eigenes 2D-`<canvas>` in seiner Vue-Komponente. Es rechnet in
Weltkoordinaten, aber seine Abbildung ist **kreisrund, nicht die gekippte
Weltprojektion** — ein Rundsichtgerät ist rund, nicht elliptisch. Nordstabilisiert,
ohne Beschriftung.

Es arbeitet als **PPI mit Nachleuchten**: der Strahl streicht in 8 Sekunden
einmal im Uhrzeigersinn um und malt die Echos beim Überstreichen frisch auf
(kurz rot, danach bernsteinfarben abklingend). Dazwischen steht das Bild still —
ein Kontakt zeigt die Position seines **letzten** Überstreichens. Bei 30 m/s
Zielfahrt kann ein Echo dadurch bis zu 240 m veraltet sein; gemessen wurden
108 m nach sieben Sekunden.

Eingefroren wird die **absolute** Weltposition, nicht die relative: das eigene
Boot fährt weiter, und das Echo soll dabei an seinem Platz auf der See bleiben
statt mitzuwandern. Der eigene Kurs steht als kurze Kerbe am Rand — ein voller
Strich würde mit dem Strahl verwechselt.

Gezeichnet wird über `onFrame()` aus `state/hud.ts`, also **jeden** Frame. Vues
Weckung ist auf 20 Hz gedrosselt, was für Text reicht, bei einem drehenden
Strahl aber sichtbar ruckelte. Taktquelle bleibt derselbe Pixi-Ticker — es kommt
keine zweite Uhr dazu.

Der Rahmen (`assets/ui/sonar-frame.png`) liegt als `::after` **vor** der Scheibe,
nicht dahinter. Als Hintergrundbild des Panels würde ihn die Leinwand überdecken,
denn Kinder werden über dem Hintergrund ihres Elternteils gezeichnet. Die
Leinwand nimmt 88 % ein und läuft absichtlich unter das Rahmenband, damit
nirgends eine Lücke bleibt — der Rahmen maskiert ihre Kanten wie eine Blende vor
einem Schirm. Seine Innenöffnung liegt bei 7,11 % der Breite und 6,00 % der Höhe.

Bildmaterial liegt zweifach: die Laufzeitfassung unter `apps/client/src/assets/`,
das unskalierte Original unter `assets-master/`. Der Rahmen etwa wäre bei
774 px rund sechsmal so groß wie nötig — das Panel misst höchstens 264 CSS-Pixel.

**Datenfluss:** `state/hud.ts` hält einen Snapshot, den der Pixi-Ticker am
Frame-Ende schreibt und gedrosselt (20 Hz) über `triggerRef` weckt. Kein
`setInterval` — das wäre eine zweite Uhr, die im Hintergrund-Tab gegen ein
eingefrorenes Bild weiterläuft.

⚠️ Zwei Fallstricke, die dabei zwingend sind:

- Der Snapshot behält seine **Objektidentität**. Er darf deshalb **nicht** als
  Prop durchgereicht werden — Vue vergleicht Props mit `===`, fände sie
  unverändert und überspränge das Update. Jedes Panel importiert `hud` selbst.
- Tastatur-Listener hängen an `window`, dort ist `event.target` das
  Window-Objekt. Der Eingabefeld-Schutz muss über `isTextEntry()` laufen; ein
  direktes `target.closest(...)` wirft und verschluckt die Tastenbehandlung.

Munitionsslots und Auftragsbuch sind **Platzhalter** — es gibt weder ein
Waffensystem noch ein Questsystem. Das Auftragsbuch führt stattdessen den einen
echten Auftrag, den der Client kennt: den Fahrbefehl, Fortschritt aus der
Restdistanz abgeleitet.

### Maschinentelegraf

Neun Rasten (`sim/telegraph.ts`), von „Volle Kraft zurück" bis „Äußerste Kraft".
Bedienung per Klick, `W`/`S` eine Stufe, `X` Stopp, Mausrad über dem Panel.

Die Stufe setzt `orderedSpeed` im Autopiloten — sie ist eine **Obergrenze, keine
Vorgabe**: bremst der Autopilot vor dem Ziel oder wegen eines engen Kurses
stärker, gewinnt er. Daraus folgt die Zustandslogik in `helmCommand()`:

| Lage | Verhalten |
| --- | --- |
| ohne Ziel | befohlene Fahrt geradeaus, Ruder mittschiffs |
| Ziel + voraus | Autopilot, gedeckelt auf die Stufe |
| Ziel + Stopp | Fahrt geht auf null, Ruder hält aufs Ziel, Wegpunkt bleibt |
| Ziel + zurück | Wegpunkt gilt als widerrufen, reines Handmanöver |

Ein Fahrbefehl bei stehender Maschine hebt den Telegrafen auf Marschfahrt,
Ankunft setzt ihn auf Stopp — sonst führe das Boot nach dem Ziel einfach weiter.

### Wasser

Die Fläche ist ein einziges Rechteck in Weltkoordinaten mit einem prozeduralen
Shader — kein Kachelraster, keine Textur, keine Assets. Die Kosten hängen an der
Bildschirmfläche, nicht an der Kartengröße.

Wellenlängen stehen in Weltunits (~Meter): Dünung 900 m, Windwellen 140 bis 8 m.
Jede Lage wird ausgeblendet, sobald ein Wellenzug auf zu wenige Bildschirmpixel
fällt (`layerFade`) — ohne das entsteht beim Rauszoomen ein Moiré-Gewebe statt
Wasser. `WATER.seaState` skaliert den Seegang von 0 bis 1.

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

Der Client verbindet sich noch **nicht** automatisch und rendert bis dahin die
`FALLBACK_MAP` aus der Config. Die Server-URL lässt sich über
`VITE_GAME_SERVER_URL` überschreiben, der Server-Port über `PORT` bzw. `HOST`.

Steuerung: Mausrad zoomt auf den Cursor, Ziehen verschiebt. Im Dev-Build liegen
Renderer und Welt unter `window.__game` für die Browser-Konsole.

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
│   │       ├── App.vue             Vollbild-Stage + HUD (Position, Zoom)
│   │       ├── config/             Server-URL, Renderer, Ansicht, Wasser
│   │       ├── game/
│   │       │   ├── Game.ts         PixiJS-Application, Ticker, Resize
│   │       │   ├── World.ts        drei Render-Ebenen, Kamera, Nachführung
│   │       │   ├── Projection.ts   Welt -> Bildschirm als eine Matrix
│   │       │   ├── Ocean.ts        Wasserfläche, prozeduraler Shader
│   │       │   ├── CameraController.ts  Zoom per Rad, Pan per Ziehen
│   │       │   ├── OrderController.ts   Fahrbefehl per Rechtsklick
│   │       │   └── entities/
│   │       │       ├── Vessel.ts       Fahrzeugmodell, kein PixiJS
│   │       │       ├── VesselView.ts   Rumpf, Zielmarker, Kurslinie
│   │       │       └── EntityLayer.ts  Registry aus Modell und Ansicht
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
│           ├── sim/                Fahrmodell: angles, VesselProfile, movement
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
