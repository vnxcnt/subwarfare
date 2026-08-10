/**
 * Rang-Icons, Dateiname = Level (`rank-1.png` … `rank-20.png`).
 *
 * Über `import.meta.glob` statt zwanzig Einzelimporten: Vite bündelt die
 * Dateien trotzdem einzeln mit Content-Hash, und ein neues Level braucht nur
 * eine neue Datei, keine Codeänderung.
 */
const modules = import.meta.glob('../assets/ranks/rank-*.png', {
  eager: true,
  import: 'default',
}) as Record<string, string>;

export function rankIconUrl(level: number): string | null {
  return modules[`../assets/ranks/rank-${level}.png`] ?? null;
}
