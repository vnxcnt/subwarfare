# Werkzeuge

## Neues Schiffsmodell einbauen (`atlas-build.py`)

```
python tools/atlas-build.py <modellname> "<Quellordner>"
```

Erwartet im Quellordner die 64 Meshy-Turntable-Renders (`*_S_spritesheet.png`
plus `*_View_<x>°___<y>°_spritesheet.png`). Erzeugt
`apps/client/src/assets/vessels/<modell>/atlas.webp + atlas.json`
(gecroppt, Shelf-gepackt, WebP q92, Pixi-Spritesheet-Format mit Ankern).

**Mit Meshy-`*_metadata.json` im Ordner** (beste Qualität): Azimut und
Pivot-Anker kommen exakt aus den Metadaten — beim Export in Meshy mitnehmen,
wenn möglich.

**Ohne Metadaten**: Winkel über `winkel-lookup.json` (Kalibrierung aus dem
Fregatten-Export — die Dateinamen-Winkel sind NICHT der Azimut!), Anker über
`anker-muster.json` (Fregatten-Pivots, indexweise übertragen — sehr gute
Näherung, da alle Sets dieselbe Kamera fahren).

Die Packer-Dateien des Sheet-Tools (`spritesheet.json`/`.png`) werden bewusst
NICHT benutzt: das JSON ist eine Editor-Projektdatei mit Base64-Kopien aller
Bilder (Megabytes, von Pixi nicht lesbar, ohne Pivots).

### Nach dem Bau — Checkliste

1. **Kardinal-Sichtprüfung** (Pflicht!): `dir-00/16/32/48` aus dem Atlas
   ansehen — Bug muss oben/rechts/unten/links zeigen. Index-Mathe allein
   beweist nichts (Lehre aus dem gespiegelten Fregatten-Bau).
2. `packages/shared/src/types/Player.ts` → `VESSEL_MODELS` ergänzen.
3. `apps/client/src/game/textures.ts` → `DEFINITIONS`-Eintrag
   (Weltlänge in Metern + `sideProfilePx` aus der Skript-Ausgabe).
4. `packages/shared/src/meta/ships.ts` → `DEFAULT_SHIP_STATS` ergänzen
   (hp, type, armament, speedFactor) — UND dieselbe Zeile in die
   `ships`-Tabelle (phpMyAdmin oder Migration).
5. Optional: Eintrag im Dev-Menü-Label (`MODEL_LABELS` in DevMenu.vue).

Kurs-Formel für alle Sets: **Kurs = (Azimut − 90°) mod 360**.
