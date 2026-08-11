/**
 * Ob das Ereignisziel eine Texteingabe ist.
 *
 * Die Prüfung auf `Element` ist nicht überflüssig: Tastatur-Listener hängen an
 * `window`, und dort ist `event.target` das Window-Objekt — ein direkter
 * `target.closest(...)`-Aufruf wirft dann eine TypeError und verschluckt die
 * gesamte Tastenbehandlung.
 */
export function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const feld = target.closest('input, textarea, select, [contenteditable="true"]');
  if (!feld) return false;
  // Nur ECHTE Texteingaben blocken. Ein Schieberegler ist ein `input`, nimmt
  // aber keine Zeichen entgegen — bliebe er hier drin, verschluckte ein
  // angeklickter Regler im Entwicklermenü anschließend Ruder, Telegraf und
  // Feuertaste, bis man wieder auf die Karte klickt.
  if (feld instanceof HTMLInputElement && NICHT_TEXT.has(feld.type)) return false;
  return true;
}

/** Eingabearten, die keine Zeichen entgegennehmen. */
const NICHT_TEXT = new Set([
  'range',
  'checkbox',
  'radio',
  'button',
  'submit',
  'reset',
  'color',
  'file',
  'image',
]);
