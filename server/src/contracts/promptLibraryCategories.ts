export const PROMPT_LIBRARY_CATEGORIES = [
  { id: 'general', label: '通用' },
  { id: 'office', label: '办公协作' },
  { id: 'finance', label: '财务会计' },
  { id: 'legal', label: '法律合规' },
  { id: 'investment', label: '投资分析' },
  { id: 'research', label: '研究检索' },
  { id: 'technology', label: '科技技术' },
  { id: 'biomed', label: '生物医药' },
] as const

export type PromptLibraryCategory = typeof PROMPT_LIBRARY_CATEGORIES[number]['id']
export type PromptLibraryCategoryFilter = PromptLibraryCategory | 'all'

export function promptCategoryLabel(category: PromptLibraryCategory): string {
  return PROMPT_LIBRARY_CATEGORIES.find(item => item.id === category)?.label ?? '通用'
}

export function filterPromptLibraryItems<T extends { category: PromptLibraryCategory; name: string; description: string }>(
  items: readonly T[], category: PromptLibraryCategoryFilter, search: string,
): T[] {
  const query = search.trim().toLocaleLowerCase()
  return items.filter(item =>
    (category === 'all' || item.category === category)
    && (!query || `${item.name} ${item.description}`.toLocaleLowerCase().includes(query)),
  )
}
