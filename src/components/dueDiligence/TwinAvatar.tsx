const PRESETS = ['fox', 'owl', 'panda', 'otter', 'cat', 'penguin'] as const
const ICONS: Record<string, string> = { fox: '🦊', owl: '🦉', panda: '🐼', otter: '🦦', cat: '🐱', penguin: '🐧' }
const COLORS = ['from-amber-100 to-orange-200', 'from-sky-100 to-blue-200', 'from-emerald-100 to-teal-200', 'from-violet-100 to-fuchsia-200', 'from-rose-100 to-pink-200', 'from-cyan-100 to-indigo-200']
export const twinAvatarPresets = PRESETS
export function defaultTwinAvatar(value: string) { return PRESETS[Math.abs([...value].reduce((sum, char) => sum * 31 + char.charCodeAt(0), 7)) % PRESETS.length] }
export function TwinAvatar({ id, name, preset, kind, size = 'md' }: { id: string; name: string; preset?: string | null; kind?: string | null; size?: 'sm' | 'md' | 'lg' }) {
  const selected = preset || defaultTwinAvatar(id || name); const index = Math.max(0, PRESETS.indexOf(selected as typeof PRESETS[number])); const dimension = size === 'sm' ? 'h-8 w-8 text-base' : size === 'lg' ? 'h-16 w-16 text-3xl' : 'h-11 w-11 text-xl'
  if (kind === 'upload') return <img className={`${dimension} shrink-0 rounded-full object-cover ring-2 ring-white`} src={`/api/due-diligence/twins/${id}/avatar`} alt={`${name}头像`} />
  return <span aria-label={`${name}头像`} className={`${dimension} inline-flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br ${COLORS[index]} ring-2 ring-white`}>{ICONS[selected] || '🤖'}</span>
}
