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
  return target.closest('input, textarea, select, [contenteditable="true"]') !== null;
}
