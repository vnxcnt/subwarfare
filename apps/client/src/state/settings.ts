import { ref } from 'vue';

/**
 * Spieler-Einstellungen: Lautstärke und Tastenbelegung.
 *
 * Rein client-seitig und in `localStorage` — Einstellungen sind Darstellung
 * und Eingabe, kein Spielzustand: der Server braucht sie nie zu sehen.
 * Alle Leser (GameAudio, Tastatur-Handler) greifen auf die Refs zu und sehen
 * Änderungen sofort — kein Neustart, kein Event-Bus.
 */

const STORAGE_KEY = 'subwarfare:settings';

export interface VolumeSettings {
  /** Effekte: Abschüsse, Einschläge, Motor. 0..1. */
  effects: number;
  /** Kulisse: Wasser/Unterwasser-Loops und Menümusik. 0..1. */
  ambient: number;
}

/**
 * Belegbare Aktionen. Die Werte sind `KeyboardEvent.code` (Lagen-stabil:
 * „KeyA" ist die physische Taste, unabhängig vom Tastaturlayout beschriftet
 * über `keyLabel`).
 */
export interface KeyBindings {
  steerLeft: string;
  steerRight: string;
  telegraphUp: string;
  telegraphDown: string;
  telegraphStop: string;
  aimToggle: string;
  /** Feuert die GEWÄHLTE Waffe (früher fest der Torpedo). */
  fire: string;
  /** Alle leeren Rohre nachladen. */
  loadTubes: string;
  /** Alle geladenen Rohre scharf schalten bzw. entschärfen. */
  armTubes: string;
  /** Minimap ein-/ausblenden. */
  minimap: string;
}

export const DEFAULT_KEYS: KeyBindings = {
  steerLeft: 'KeyA',
  steerRight: 'KeyD',
  telegraphUp: 'KeyW',
  telegraphDown: 'KeyS',
  telegraphStop: 'KeyX',
  aimToggle: 'KeyQ',
  fire: 'Space',
  loadTubes: 'KeyR',
  armTubes: 'KeyT',
  minimap: 'KeyM',
};

/** Anzeige-Reihenfolge und Beschriftung im Einstellungs-Panel. */
export const KEY_ACTIONS: ReadonlyArray<{ id: keyof KeyBindings; label: string }> = [
  { id: 'steerLeft', label: 'Ruder Backbord' },
  { id: 'steerRight', label: 'Ruder Steuerbord' },
  { id: 'telegraphUp', label: 'Telegraf schneller' },
  { id: 'telegraphDown', label: 'Telegraf langsamer' },
  { id: 'telegraphStop', label: 'Maschinen stopp' },
  { id: 'aimToggle', label: 'Zielmodus an/aus' },
  { id: 'fire', label: 'Feuern' },
  { id: 'loadTubes', label: 'Rohre laden' },
  { id: 'armTubes', label: 'Rohre scharf' },
  { id: 'minimap', label: 'Minimap' },
];

export const volumes = ref<VolumeSettings>({ effects: 1, ambient: 1 });
export const keys = ref<KeyBindings>({ ...DEFAULT_KEYS });
/** Deckkraft der Minimap (persönliche Vorliebe), 0,2..1. */
export const minimapAlpha = ref(0.9);
/** Planquadrat-Gitter (A1..) über der See — abschaltbar für freie Sicht. */
export const gridEnabled = ref(true);

/**
 * Offen, solange das Einstellungs-Panel angezeigt wird. Die Spiel-Handler
 * (Ruder, Telegraf, Feuern) prüfen das Flag und schweigen — sonst würde die
 * Leertaste auf einem fokussierten Dialog-Knopf nebenbei einen echten Torpedo
 * abfeuern.
 */
export const settingsModalOpen = ref(false);

/**
 * Ziffern (auch Numpad) sind die FESTEN Slot-Tasten der Munitionsleiste und
 * Escape der Abbruch der Tastenerfassung — beides ist nicht belegbar, sonst
 * entstünde genau der stille Doppelkonflikt, den die Duplikatprüfung
 * verhindern soll.
 */
const RESERVED_CODES = /^(Digit|Numpad)[1-9]$/;

function isBindableCode(code: unknown): code is string {
  return (
    typeof code === 'string' && code.length > 0 && code !== 'Escape' && !RESERVED_CODES.test(code)
  );
}

/** Gespeicherte Einstellungen laden — fehlende/kaputte Felder fallen auf Defaults. */
function load(): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
  } catch {
    return;
  }
  if (typeof parsed !== 'object' || parsed === null) return;
  const data = parsed as {
    volumes?: Partial<VolumeSettings>;
    keys?: Partial<KeyBindings>;
    minimapAlpha?: unknown;
    gridEnabled?: unknown;
  };

  const clamp = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : fallback;
  volumes.value = {
    effects: clamp(data.volumes?.effects, 1),
    ambient: clamp(data.volumes?.ambient, 1),
  };
  minimapAlpha.value = Math.max(clamp(data.minimapAlpha, 0.9), 0.2);
  if (typeof data.gridEnabled === 'boolean') gridEnabled.value = data.gridEnabled;

  const next = { ...DEFAULT_KEYS };
  for (const action of Object.keys(DEFAULT_KEYS) as Array<keyof KeyBindings>) {
    const code = data.keys?.[action];
    if (isBindableCode(code)) next[action] = code;
  }
  // Dieselbe Invariante wie setKey: jede Taste höchstens einmal. Ein
  // handeditierter/fremder Storage mit Doppelbelegung würde sonst z. B.
  // steerLeft UND steerRight auf dieselbe Taste legen — im Gefecht gewinnt
  // dann stumm immer nur eine Aktion. Bei Konflikt: kompletter Rückfall.
  const unique = new Set(Object.values(next)).size === Object.keys(next).length;
  keys.value = unique ? next : { ...DEFAULT_KEYS };
}

function save(): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        volumes: volumes.value,
        keys: keys.value,
        minimapAlpha: minimapAlpha.value,
        gridEnabled: gridEnabled.value,
      }),
    );
  } catch {
    // Gesperrter Storage (privater Modus) — dann gelten sie eben nur für
    // diese Sitzung.
  }
}

load();

// Cross-Tab: `storage` feuert nur in den ANDEREN Tabs. Ohne den Abgleich
// würde ein Tab mit veraltetem Stand beim nächsten save() (z. B. bloßes
// Reglerziehen) die Umbelegungen des anderen Tabs zurücküberschreiben —
// save() schreibt immer den kompletten Blob.
window.addEventListener('storage', (event) => {
  if (event.key === STORAGE_KEY) load();
});

export function setVolume(kind: keyof VolumeSettings, value: number): void {
  volumes.value = { ...volumes.value, [kind]: Math.min(Math.max(value, 0), 1) };
  save();
}

/** Minimap-Deckkraft setzen — geklemmt auf 0,2..1, damit sie nie „weg" ist. */
export function setMinimapAlpha(value: number): void {
  minimapAlpha.value = Math.min(Math.max(value, 0.2), 1);
  save();
}

export function setGridEnabled(value: boolean): void {
  gridEnabled.value = value;
  save();
}

/**
 * Belegt eine Aktion neu. `false`, wenn die Taste schon eine ANDERE Aktion
 * trägt oder reserviert ist (Ziffern-Slots, Escape) — Doppelbelegung wäre im
 * Gefecht ein stiller Konflikt, der Aufrufer zeigt die Meldung.
 */
export function setKey(action: keyof KeyBindings, code: string): boolean {
  if (!isBindableCode(code)) return false;
  const taken = (Object.entries(keys.value) as Array<[keyof KeyBindings, string]>).find(
    ([other, bound]) => bound === code && other !== action,
  );
  if (taken) return false;
  keys.value = { ...keys.value, [action]: code };
  save();
  return true;
}

export function resetKeys(): void {
  keys.value = { ...DEFAULT_KEYS };
  save();
}

/** Menschlich lesbare Beschriftung eines `KeyboardEvent.code`. */
export function keyLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  const names: Record<string, string> = {
    Space: 'Leertaste',
    ShiftLeft: 'Shift links',
    ShiftRight: 'Shift rechts',
    ControlLeft: 'Strg links',
    ControlRight: 'Strg rechts',
    AltLeft: 'Alt',
    AltRight: 'Alt Gr',
    ArrowUp: '↑',
    ArrowDown: '↓',
    ArrowLeft: '←',
    ArrowRight: '→',
    Tab: 'Tab',
    Backspace: 'Rücktaste',
    Enter: 'Enter',
    Comma: ',',
    Period: '.',
    Minus: '-',
    Slash: '#',
    Semicolon: 'Ö',
    Quote: 'Ä',
    BracketLeft: 'Ü',
    Backquote: '^',
  };
  return names[code] ?? code;
}
