/**
 * Google Identity Services — EIN Loader für Login-Screen und Einstellungen.
 *
 * Das Skript wird höchstens einmal eingehängt; wer den Button braucht, ruft
 * `ensureGis()` und initialisiert mit SEINEM Callback (GIS führt global genau
 * einen — die zuletzt initialisierende Ansicht gewinnt, was hier stimmt, weil
 * Login und Einstellungen nie gleichzeitig sichtbar sind).
 */

export interface GisId {
  initialize(config: { client_id: string; callback: (r: { credential: string }) => void }): void;
  renderButton(parent: HTMLElement, options: Record<string, unknown>): void;
}

let loading: Promise<GisId | null> | null = null;

function current(): GisId | null {
  return (window as { google?: { accounts?: { id?: GisId } } }).google?.accounts?.id ?? null;
}

export function ensureGis(): Promise<GisId | null> {
  const existing = current();
  if (existing) return Promise.resolve(existing);
  loading ??= new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.onload = () => resolve(current());
    // Blockiertes Skript (Adblocker, offline): dann eben kein Google-Button —
    // die Aufrufer behandeln null als „nicht verfügbar", nicht als Fehler.
    script.onerror = () => resolve(null);
    document.head.appendChild(script);
  });
  return loading;
}
