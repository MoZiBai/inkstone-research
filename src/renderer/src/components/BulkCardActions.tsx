import { ArchiveX, CheckSquare2, FolderInput, RotateCcw, Tags, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { BatchUpdateCardsInput, ProjectCardView, WorkspaceSnapshot } from '@shared/types'
import { api } from '../lib/api'
import { TagInput } from './TagInput'
import { parseTags } from '../lib/tags'
export { parseTags } from '../lib/tags'
import type { RunMutation } from '../types'

export type BulkCardContext = 'library' | 'synthesis-active' | 'synthesis-excluded'

interface BulkCardActionsProps {
  snapshot: WorkspaceSnapshot
  selectedIds: ReadonlySet<string>
  context: BulkCardContext
  runMutation: RunMutation
  onClear: () => void
}

export function BulkCardActions({
  snapshot,
  selectedIds,
  context,
  runMutation,
  onClear
}: BulkCardActionsProps): React.JSX.Element | null {
  const [tagMode, setTagMode] = useState<'add' | 'remove' | null>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const [tagDraft, setTagDraft] = useState('')
  const [removeTags, setRemoveTags] = useState<Set<string>>(() => new Set())
  const [categoryId, setCategoryId] = useState(
    snapshot.categories.find((category) => category.isDefault)?.id ?? snapshot.categories[0]?.id ?? ''
  )
  const validCategoryId = snapshot.categories.some((category) => category.id === categoryId)
    ? categoryId
    : snapshot.categories.find((category) => category.isDefault)?.id ?? snapshot.categories[0]?.id ?? ''
  useEffect(() => {
    setCategoryId(snapshot.categories.find((category) => category.isDefault)?.id ?? snapshot.categories[0]?.id ?? '')
    setTagMode(null)
    setTagDraft('')
    setRemoveTags(new Set())
  }, [snapshot.currentProjectId])
  useEffect(() => {
    if (selectedIds.size === 0) {
      setTagMode(null)
      setTagDraft('')
      setRemoveTags(new Set())
    }
  }, [selectedIds.size])
  const selectedCards = useMemo(
    () => snapshot.cards.filter((card) => selectedIds.has(card.id)),
    [selectedIds, snapshot.cards]
  )
  const activeCards = selectedCards.filter((card) => card.synthesisState === 'active')
  const excludedCards = selectedCards.filter((card) => card.synthesisState === 'excluded')
  const tagOccurrences = useMemo(() => collectTagOccurrences(selectedCards), [selectedCards])
  const allProjectTags = useMemo(
    () => Array.from(new Set(snapshot.cards.flatMap((card) => card.tags))).sort((a, b) => a.localeCompare(b, 'zh-CN')),
    [snapshot.cards]
  )
  const count = selectedCards.length
  useEffect(() => {
    if (!tagMode) return
    const close = (): void => { setTagMode(null); setTagDraft(''); setRemoveTags(new Set()) }
    const outside = (event: PointerEvent): void => {
      if (event.target instanceof Element && event.target.closest('[aria-label="关闭砚台"], [role="dialog"]')) return
      if (event.target instanceof Node && !popoverRef.current?.contains(event.target)) close()
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !document.querySelector('[aria-modal="true"]')) { event.stopPropagation(); close() }
    }
    window.addEventListener('pointerdown', outside, true)
    window.addEventListener('keydown', escape)
    return () => { window.removeEventListener('pointerdown', outside, true); window.removeEventListener('keydown', escape) }
  }, [tagMode])
  if (count === 0 || !snapshot.currentProjectId) return null

  const runBatch = async (
    change: Omit<BatchUpdateCardsInput, 'projectId' | 'cardIds'>,
    message: string,
    targetCards: ProjectCardView[] = selectedCards
  ): Promise<boolean> => {
    if (targetCards.length === 0) return false
    const succeeded = await runMutation(
      () => api.batchUpdateCards({
        projectId: snapshot.currentProjectId as string,
        cardIds: targetCards.map((card) => card.id),
        ...change
      }),
      message
    )
    if (succeeded) onClear()
    return succeeded
  }

  const closeTags = (): void => {
    setTagMode(null)
    setTagDraft('')
    setRemoveTags(new Set())
  }

  const openTags = (mode: 'add' | 'remove'): void => {
    setTagDraft('')
    setRemoveTags(new Set())
    setTagMode(mode)
  }

  const submitAddedTags = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    const tags = parseTags(tagDraft)
    if (tags.length === 0) return
    const succeeded = await runBatch(
      { addTags: tags },
      `已为 ${count} 张卡片添加 ${tags.length} 个标签。`
    )
    if (succeeded) closeTags()
  }

  const submitRemovedTags = async (): Promise<void> => {
    const tags = [...removeTags]
    if (tags.length === 0) return
    const succeeded = await runBatch(
      { removeTags: tags },
      `已从 ${count} 张卡片中移除所选标签（仅影响原本具有这些标签的卡片）。`
    )
    if (succeeded) closeTags()
  }

  const showMove = context !== 'synthesis-excluded' && activeCards.length > 0
  const showExclude = context !== 'synthesis-excluded' && activeCards.length > 0
  const showRestore = context !== 'synthesis-active' && excludedCards.length > 0
  const parsedDraftTags = parseTags(tagDraft)


  return (
    <div ref={popoverRef} className="bulk-card-actions" role="region" aria-label={`批量操作 ${count} 张卡片`}>
      <span className="bulk-selection-count"><CheckSquare2 size={16} /> 已选择 <strong>{count}</strong> 张</span>
      <button type="button" onClick={() => openTags('add')}><Tags size={14} /> 添加标签</button>
      <button type="button" disabled={tagOccurrences.length === 0} onClick={() => openTags('remove')}><Tags size={14} /> 移除已有标签</button>
      {showMove ? (
        <div className="bulk-category-action">
          <select value={validCategoryId} onChange={(event) => setCategoryId(event.target.value)} aria-label="批量移动到整理分类">
            {snapshot.categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
          </select>
          <button
            type="button"
            disabled={!validCategoryId}
            onClick={() => void runBatch(
              { categoryId: validCategoryId },
              `已将 ${activeCards.length} 张整理中卡片移动到所选分类。`,
              activeCards
            )}
          >
            <FolderInput size={14} /> 移动{context === 'library' ? ` ${activeCards.length} 张` : ''}
          </button>
        </div>
      ) : null}
      {showExclude ? (
        <button
          className="bulk-exclude"
          type="button"
          onClick={() => void runBatch(
            { synthesisState: 'excluded' },
            `已将 ${activeCards.length} 张卡片从二次整理剔除；卡片仍保留在卡片库。`,
            activeCards
          )}
        >
          <ArchiveX size={14} /> 剔除{context === 'library' ? ` ${activeCards.length} 张整理中卡片` : '所选'}
        </button>
      ) : null}
      {showRestore ? (
        <button
          type="button"
          onClick={() => void runBatch(
            { synthesisState: 'active' },
            `已将 ${excludedCards.length} 张卡片恢复到二次整理。`,
            excludedCards
          )}
        >
          <RotateCcw size={14} /> 恢复{context === 'library' ? ` ${excludedCards.length} 张已剔除卡片` : '所选'}
        </button>
      ) : null}
      <button className="bulk-clear-selection" type="button" onClick={onClear} aria-label="清除卡片选择"><X size={14} /></button>

      {tagMode === 'add' ? (
        <form data-unsaved={tagDraft.trim() ? 'true' : undefined} className="bulk-tag-popover" onSubmit={(event) => void submitAddedTags(event)}>
          <div>
            <strong>添加标签</strong>
            <small>以逗号分隔，将应用到所选 {count} 张卡片</small>
          </div>
          <TagInput value={tagDraft} onChange={setTagDraft} suggestions={allProjectTags} />
          <div className="bulk-tag-popover-actions">
            <button type="button" onClick={closeTags}>取消</button>
            <button className="primary" type="submit" disabled={parsedDraftTags.length === 0}>添加 {parsedDraftTags.length || ''}</button>
          </div>
        </form>
      ) : null}

      {tagMode === 'remove' ? (
        <div data-unsaved={removeTags.size > 0 ? 'true' : undefined} className="bulk-tag-popover remove-tags">
          <div>
            <strong>移除已有标签</strong>
            <small>勾选要移除的标签，不需要重新输入</small>
          </div>
          <div className="bulk-remove-tag-list">
            {tagOccurrences.map(({ tag, count: occurrenceCount }) => (
              <label key={tag}>
                <input
                  type="checkbox"
                  checked={removeTags.has(tag)}
                  onChange={() => setRemoveTags((current) => {
                    const next = new Set(current)
                    if (next.has(tag)) next.delete(tag)
                    else next.add(tag)
                    return next
                  })}
                />
                <span>{tag}</span>
                <small>{occurrenceCount}/{count} 张</small>
              </label>
            ))}
          </div>
          <div className="bulk-tag-popover-actions">
            <button type="button" onClick={closeTags}>取消</button>
            <button className="primary" type="button" disabled={removeTags.size === 0} onClick={() => void submitRemovedTags()}>移除 {removeTags.size || ''}</button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

export function collectTagOccurrences(cards: ProjectCardView[]): Array<{ tag: string; count: number }> {
  const occurrences = new Map<string, number>()
  for (const card of cards) {
    for (const tag of new Set(card.tags)) occurrences.set(tag, (occurrences.get(tag) ?? 0) + 1)
  }
  return [...occurrences.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((first, second) => second.count - first.count || first.tag.localeCompare(second.tag, 'zh-CN'))
}
