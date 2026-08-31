import { ArchiveX, CheckSquare2, FolderInput, RotateCcw, Tags, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { BatchUpdateCardsInput, WorkspaceSnapshot } from '@shared/types'
import { api } from '../lib/api'
import type { RunMutation } from '../types'
import { Modal } from './Modal'

interface BulkCardActionsProps {
  snapshot: WorkspaceSnapshot
  selectedIds: ReadonlySet<string>
  runMutation: RunMutation
  onClear: () => void
}

export function BulkCardActions({
  snapshot,
  selectedIds,
  runMutation,
  onClear
}: BulkCardActionsProps): React.JSX.Element | null {
  const [tagMode, setTagMode] = useState<'add' | 'remove' | null>(null)
  const [tagDraft, setTagDraft] = useState('')
  const [categoryId, setCategoryId] = useState(
    snapshot.categories.find((category) => category.isDefault)?.id ?? snapshot.categories[0]?.id ?? ''
  )
  const selectedCards = useMemo(
    () => snapshot.cards.filter((card) => selectedIds.has(card.id)),
    [selectedIds, snapshot.cards]
  )
  const count = selectedCards.length
  if (count === 0 || !snapshot.currentProjectId) return null

  const runBatch = async (
    change: Omit<BatchUpdateCardsInput, 'projectId' | 'cardIds'>,
    message: string
  ): Promise<boolean> => {
    const succeeded = await runMutation(
      () => api.batchUpdateCards({
        projectId: snapshot.currentProjectId as string,
        cardIds: selectedCards.map((card) => card.id),
        ...change
      }),
      message
    )
    if (succeeded) onClear()
    return succeeded
  }

  const submitTags = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (!tagMode) return
    const tags = parseTags(tagDraft)
    if (tags.length === 0) return
    const succeeded = await runBatch(
      tagMode === 'add' ? { addTags: tags } : { removeTags: tags },
      `已为 ${count} 张卡片${tagMode === 'add' ? '添加' : '移除'} ${tags.length} 个标签。`
    )
    if (succeeded) {
      setTagMode(null)
      setTagDraft('')
    }
  }

  return (
    <>
      <div className="bulk-card-actions" role="region" aria-label={`批量操作 ${count} 张卡片`}>
        <span className="bulk-selection-count"><CheckSquare2 size={16} /> 已选择 <strong>{count}</strong> 张</span>
        <button type="button" onClick={() => setTagMode('add')}><Tags size={14} /> 添加标签</button>
        <button type="button" onClick={() => setTagMode('remove')}><Tags size={14} /> 移除标签</button>
        <div className="bulk-category-action">
          <select value={categoryId} onChange={(event) => setCategoryId(event.target.value)} aria-label="批量移动到分类">
            {snapshot.categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
          </select>
          <button
            type="button"
            disabled={!categoryId}
            onClick={() => void runBatch({ categoryId }, `已将 ${count} 张卡片移动到所选整理分类。`)}
          >
            <FolderInput size={14} /> 移动
          </button>
        </div>
        <button
          className="bulk-exclude"
          type="button"
          onClick={() => void runBatch({ synthesisState: 'excluded' }, `已将 ${count} 张卡片从二次整理剔除；卡片仍保留在卡片库。`)}
        >
          <ArchiveX size={14} /> 剔除所选
        </button>
        <button
          type="button"
          onClick={() => void runBatch({ synthesisState: 'active' }, `已将 ${count} 张卡片恢复到二次整理。`)}
        >
          <RotateCcw size={14} /> 恢复所选
        </button>
        <button className="bulk-clear-selection" type="button" onClick={onClear} aria-label="清除卡片选择"><X size={14} /></button>
      </div>

      {tagMode ? (
        <Modal
          title={`${tagMode === 'add' ? '添加' : '移除'}标签 · ${count} 张卡片`}
          subtitle={`本次操作会影响当前选中的 ${count} 张卡片；每行或使用逗号输入一个标签。`}
          onClose={() => setTagMode(null)}
          hasUnsavedChanges={Boolean(tagDraft.trim())}
        >
          <form onSubmit={(event) => void submitTags(event)}>
            <label className="field">
              <span>标签</span>
              <textarea
                autoFocus
                rows={5}
                value={tagDraft}
                onChange={(event) => setTagDraft(event.target.value)}
                placeholder="例如：\n墓葬形制\n年代问题"
              />
            </label>
            <p className="bulk-tag-preview">将{tagMode === 'add' ? '添加' : '移除'} {parseTags(tagDraft).length} 个标签，影响 {count} 张卡片。</p>
            <div className="modal-actions">
              <button className="button ghost" type="button" data-modal-close>取消</button>
              <button className="button primary" type="submit" disabled={parseTags(tagDraft).length === 0}>
                确认影响 {count} 张卡片
              </button>
            </div>
          </form>
        </Modal>
      ) : null}
    </>
  )
}

function parseTags(value: string): string[] {
  return Array.from(new Set(value.split(/[\n,，]/).map((tag) => tag.trim()).filter(Boolean)))
}
