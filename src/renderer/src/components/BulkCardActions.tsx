import { ArchiveX, CheckSquare2, FolderInput, RotateCcw, Tags, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { BatchUpdateCardsInput, ProjectCardView, WorkspaceSnapshot } from '@shared/types'
import { api } from '../lib/api'
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
  const [tagDraft, setTagDraft] = useState('')
  const [removeTags, setRemoveTags] = useState<Set<string>>(() => new Set())
  const [categoryId, setCategoryId] = useState(
    snapshot.categories.find((category) => category.isDefault)?.id ?? snapshot.categories[0]?.id ?? ''
  )
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
  const currentTagQuery = tagDraft.split(/[\n,，]/).at(-1)?.trim().toLocaleLowerCase() ?? ''
  const addSuggestions = allProjectTags
    .filter((tag) => !parsedDraftTags.includes(tag))
    .filter((tag) => !currentTagQuery || tag.toLocaleLowerCase().includes(currentTagQuery))
    .slice(0, 8)

  return (
    <div className="bulk-card-actions" role="region" aria-label={`批量操作 ${count} 张卡片`}>
      <span className="bulk-selection-count"><CheckSquare2 size={16} /> 已选择 <strong>{count}</strong> 张</span>
      <button type="button" onClick={() => openTags('add')}><Tags size={14} /> 添加标签</button>
      <button type="button" disabled={tagOccurrences.length === 0} onClick={() => openTags('remove')}><Tags size={14} /> 移除已有标签</button>
      {showMove ? (
        <div className="bulk-category-action">
          <select value={categoryId} onChange={(event) => setCategoryId(event.target.value)} aria-label="批量移动到整理分类">
            {snapshot.categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
          </select>
          <button
            type="button"
            disabled={!categoryId}
            onClick={() => void runBatch(
              { categoryId },
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
        <form className="bulk-tag-popover" onSubmit={(event) => void submitAddedTags(event)}>
          <div>
            <strong>添加标签</strong>
            <small>以逗号分隔，将应用到所选 {count} 张卡片</small>
          </div>
          <input
            autoFocus
            value={tagDraft}
            onChange={(event) => setTagDraft(event.target.value)}
            placeholder="输入新标签或选择已有标签"
          />
          {addSuggestions.length > 0 ? (
            <div className="bulk-tag-suggestions">
              {addSuggestions.map((tag) => (
                <button key={tag} type="button" onClick={() => setTagDraft((current) => `${current.trim().replace(/[,，]$/, '')}${current.trim() ? '，' : ''}${tag}，`)}>{tag}</button>
              ))}
            </div>
          ) : null}
          <div className="bulk-tag-popover-actions">
            <button type="button" onClick={closeTags}>取消</button>
            <button className="primary" type="submit" disabled={parsedDraftTags.length === 0}>添加 {parsedDraftTags.length || ''}</button>
          </div>
        </form>
      ) : null}

      {tagMode === 'remove' ? (
        <div className="bulk-tag-popover remove-tags">
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

export function parseTags(value: string): string[] {
  return Array.from(new Set(value.split(/[\n,，]/).map((tag) => tag.trim()).filter(Boolean)))
}
