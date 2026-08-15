/**
 * Perk-Icons, über den Bundler eingesammelt — Dateiname = Perk-Id (die
 * zugleich die Item-Id ist). Wie bei den Item-Icons: ein neuer Perk braucht
 * nur seine Datei, keine Codeänderung.
 */
const modules = import.meta.glob('../assets/perks/*.webp', {
  eager: true,
  import: 'default',
}) as Record<string, string>;

export function perkIconUrl(perkId: string): string | null {
  return modules[`../assets/perks/${perkId}.webp`] ?? null;
}
