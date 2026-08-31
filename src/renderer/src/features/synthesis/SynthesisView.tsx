import {
  ArchiveX,
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  ChevronsDown,
  ChevronsUp,
  Edit3,
  Layers3,
  Palette,
  Plus,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Trash2
} from 'lucide-react'
import { useDeferredValue, useEffect, useMemo, useState } from 'react'
import type {
  ProjectCardView,
  ResearchRole,
  SynthesisCategory,
  UpdateCardInput,
  WorkspaceSnapshot
} from '@shared/types'
import { BulkCardActions } from '../../components/BulkCardActions'
import { CardEditDialog } from '../../components/CardEditDialog'
import { EmptyState } from '../../components/EmptyState'
import { ConfirmDialog, Modal } from '../../components/Modal'
import { api } from '../../lib/api'
import { filterProjectCards, groupCardsByCategory } from '../../lib/workspaceCollections'
import type { RunMutation } from '../../types'

interface SynthesisViewProps {
  snapshot: WorkspaceSnapshot
  runMutation: RunMutation
  focusCardId: string | null
  initialMode: 'active' | 'excluded'
  onFocusHandled: () => void
  onOpenSource: (documentId: string, page: number | null, locatorJson: string) => void
}

const synthesisCardTransferType = 'application/x-inkstone-synthesis-card'
const collapsedCardPreviewCount = 6

export function SynthesisView({
  snapshot,
  runMutation,
  focusCardId,
  initialMode,
  onFocusHandled,
  onOpenSource
}: SynthesisViewProps): React.JSX.Element {
  const [mode, setMode] = useState<'active' | 'excluded'>(initialMode)
  const [draggedCardId, setDraggedCardId] = useState<string | null>(null)
  const [dragOverCategory, setDragOverCategory] = useState<string | null>(null)
  const [collapsedCategoryIds, setCollapsedCategoryIds] = useState<Set<string>>(
    () => new Set()
  )
  const [expandedCategoryIds, setExpandedCategoryIds] = useState<Set<string>>(
    () => new Set()
  )
  const [editingCard, setEditingCard] = useState<ProjectCardView | null>(null)
  const [editingCategory, setEditingCategory] = useState<SynthesisCategory | 'new' | null>(null)
  const [showResearchRoleManager, setShowResearchRoleManager] = useState(false)
  const [query, setQuery] = useState('')
  const [selectedCardIds, setSelectedCardIds] = useState<Set<string>>(() => new Set())
  const deferredQuery = useDeferredValue(query.trim().toLocaleLowerCase())
  const activeCards = useMemo(
    () => snapshot.cards.filter((card) => card.synthesisState === 'active'),
    [snapshot.cards]
  )
  const excludedCards = useMemo(
    () => snapshot.cards.filter((card) => card.synthesisState === 'excluded'),
    [snapshot.cards]
  )
  const visibleActiveCards = useMemo(
    () => filterProjectCards(snapshot.cards, deferredQuery, 'active'),
    [deferredQuery, snapshot.cards]
  )
  const visibleExcludedCards = useMemo(
    () => filterProjectCards(snapshot.cards, deferredQuery, 'excluded'),
    [deferredQuery, snapshot.cards]
  )
  const cardsByCategory = useMemo(
    () => groupCardsByCategory(visibleActiveCards, snapshot.categories),
    [snapshot.categories, visibleActiveCards]
  )
  const categoryById = useMemo(
    () => new Map(snapshot.categories.map((category) => [category.id, category])),
    [snapshot.categories]
  )
  const currentVisibleCards = mode === 'active' ? visibleActiveCards : visibleExcludedCards
  const allVisibleSelected = currentVisibleCards.length > 0 && currentVisibleCards.every((card) => selectedCardIds.has(card.id))

  useEffect(() => {
    const availableIds = new Set(snapshot.cards.map((card) => card.id))
    setSelectedCardIds((current) => new Set([...current].filter((id) => availableIds.has(id))))
  }, [snapshot.cards])

  const toggleCardSelection = (cardId: string): void => {
    setSelectedCardIds((current) => {
      const next = new Set(current)
      if (next.has(cardId)) next.delete(cardId)
      else next.add(cardId)
      return next
    })
  }

  const toggleVisibleSelection = (): void => {
    setSelectedCardIds((current) => {
      const next = new Set(current)
      for (const card of currentVisibleCards) {
        if (allVisibleSelected) next.delete(card.id)
        else next.add(card.id)
      }
      return next
    })
  }

  useEffect(() => setMode(initialMode), [initialMode])

  useEffect(() => {
    if (!focusCardId) return
    if (query) setQuery('')
    if (deferredQuery) return
    const focusedCard = snapshot.cards.find((card) => card.id === focusCardId)
    if (focusedCard?.synthesisState === 'active') {
      const focusedCategoryId =
        focusedCard.categoryId ??
        snapshot.categories.find((category) => category.isDefault)?.id ??
        null
      if (focusedCategoryId) {
        setCollapsedCategoryIds((current) => {
          if (!current.has(focusedCategoryId)) return current
          const next = new Set(current)
          next.delete(focusedCategoryId)
          return next
        })
        setExpandedCategoryIds((current) => {
          if (current.has(focusedCategoryId)) return current
          const next = new Set(current)
          next.add(focusedCategoryId)
          return next
        })
      }
    }
    const timeout = window.setTimeout(() => {
      const element = document.querySelector<HTMLElement>(`[data-synthesis-card="${focusCardId}"]`)
      if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' })
        element.classList.add('focus-pulse')
        window.setTimeout(() => element.classList.remove('focus-pulse'), 1500)
      }
      onFocusHandled()
    }, 80)
    return () => window.clearTimeout(timeout)
  }, [deferredQuery, focusCardId, mode, onFocusHandled, query, snapshot.cards, snapshot.categories])

  const moveCard = async (categoryId: string, explicitCardId?: string): Promise<void> => {
    const cardId = explicitCardId || draggedCardId
    if (!cardId) return
    const card = snapshot.cards.find((candidate) => candidate.id === cardId)
    setDraggedCardId(null)
    setDragOverCategory(null)
    if (!card || card.categoryId === categoryId) return
    const succeeded = await runMutation(
      () => api.moveCard(card.id, categoryId),
      '卡片分类已更新。'
    )
    if (succeeded) {
      setCollapsedCategoryIds((current) => {
        if (!current.has(categoryId)) return current
        const next = new Set(current)
        next.delete(categoryId)
        return next
      })
      setExpandedCategoryIds((current) => {
        if (current.has(categoryId)) return current
        const next = new Set(current)
        next.add(categoryId)
        return next
      })
    }
  }

  const saveCard = async (input: UpdateCardInput): Promise<void> => {
    const succeeded = await runMutation(() => api.updateCard(input), '卡片内容已更新。')
    if (succeeded) setEditingCard(null)
  }

  const reorderCategory = async (categoryId: string, direction: -1 | 1): Promise<void> => {
    if (!snapshot.currentProjectId) return
    const ids = snapshot.categories.map((category) => category.id)
    const current = ids.indexOf(categoryId)
    const next = current + direction
    if (current < 0 || next < 0 || next >= ids.length) return
    ;[ids[current], ids[next]] = [ids[next] as string, ids[current] as string]
    await runMutation(
      () => api.reorderCategories(snapshot.currentProjectId as string, ids),
      '分类顺序已保存。'
    )
  }

  const toggleCategoryCollapsed = (categoryId: string): void => {
    setCollapsedCategoryIds((current) => {
      const next = new Set(current)
      if (next.has(categoryId)) next.delete(categoryId)
      else next.add(categoryId)
      return next
    })
  }

  const toggleCategoryExpanded = (categoryId: string): void => {
    setExpandedCategoryIds((current) => {
      const next = new Set(current)
      if (next.has(categoryId)) next.delete(categoryId)
      else next.add(categoryId)
      return next
    })
  }

  const boardColumnCount = Math.max(snapshot.categories.length, 1)
  const boardMinimumWidth = boardColumnCount * 280 + (boardColumnCount - 1) * 12

  return (
    <div className="workspace-view synthesis-view">
      <header className="view-heading synthesis-heading">
        <div>
          <span className="eyebrow">跨文献整理</span>
          <h1>二次整理</h1>
          <p>项目全部卡片进入此处；剔除只退出整理工作区，不删除卡片。</p>
        </div>
        <div className="heading-actions">
          <button className="button secondary" type="button" disabled={currentVisibleCards.length === 0} onClick={toggleVisibleSelection}>
            {allVisibleSelected ? '取消当前选择' : `选择当前 ${currentVisibleCards.length} 张`}
          </button>
          <label className="search-box synthesis-search-box">
            <Search size={15} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索摘录、评论、作者或标签"
            />
            <span>{mode === 'active' ? visibleActiveCards.length : visibleExcludedCards.length}</span>
          </label>
          <div className="segmented-control">
            <button
              className={mode === 'active' ? 'active' : ''}
              type="button"
              onClick={() => setMode('active')}
            >
              整理中 <span>{activeCards.length}</span>
            </button>
            <button
              className={mode === 'excluded' ? 'active' : ''}
              type="button"
              onClick={() => setMode('excluded')}
            >
              已剔除 <span>{excludedCards.length}</span>
            </button>
          </div>
          <button className="button secondary" type="button" onClick={() => setEditingCategory('new')}>
            <Plus size={15} /> 新建分类
          </button>
          <button className="button secondary" type="button" onClick={() => setShowResearchRoleManager(true)}>
            <SlidersHorizontal size={15} /> 研究作用
          </button>
        </div>
      </header>

      <BulkCardActions
        snapshot={snapshot}
        selectedIds={selectedCardIds}
        runMutation={runMutation}
        onClear={() => setSelectedCardIds(new Set())}
      />

      {mode === 'active' ? (
        <div className="board-scroll">
          <div
            className="synthesis-board"
            style={{
              gridTemplateColumns: `repeat(${boardColumnCount}, minmax(280px, 1fr))`,
              minWidth: `${boardMinimumWidth}px`
            }}
          >
            {snapshot.categories.map((category, categoryIndex) => {
              const categoryCards = cardsByCategory.get(category.id) ?? []
              const categoryCollapsed = !deferredQuery && collapsedCategoryIds.has(category.id)
              const categoryExpanded = Boolean(deferredQuery) || expandedCategoryIds.has(category.id)
              const visibleCategoryCards = categoryExpanded
                ? categoryCards
                : categoryCards.slice(0, collapsedCardPreviewCount)
              const hiddenCardCount = categoryCards.length - visibleCategoryCards.length
              return (
                <section
                  className={`board-column ${categoryCollapsed ? 'collapsed' : ''} ${dragOverCategory === category.id ? 'drag-over' : ''}`}
                  key={category.id}
                  onDragOver={(event) => {
                    event.preventDefault()
                    event.dataTransfer.dropEffect = 'move'
                    setDragOverCategory(category.id)
                  }}
                  onDragLeave={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                      setDragOverCategory(null)
                    }
                  }}
                  onDrop={(event) => {
                    event.preventDefault()
                    const droppedCardId =
                      event.dataTransfer.getData(synthesisCardTransferType) ||
                      event.dataTransfer.getData('text/plain')
                    void moveCard(category.id, droppedCardId)
                  }}
                >
                  <header className="column-header">
                    <span className="column-color" style={{ backgroundColor: category.color }} />
                    <div>
                      <h2>{category.name}</h2>
                      <span>{categoryCards.length} 张</span>
                    </div>
                    <div className="column-tools">
                      <button
                        type="button"
                        disabled={Boolean(deferredQuery)}
                        onClick={() => toggleCategoryCollapsed(category.id)}
                        aria-label={categoryCollapsed ? '展开分类' : '收起分类'}
                        aria-expanded={!categoryCollapsed}
                        title={
                          deferredQuery
                            ? '搜索时会自动展开匹配结果'
                            : categoryCollapsed
                              ? '展开分类'
                              : '收起分类'
                        }
                      >
                        {categoryCollapsed ? (
                          <ChevronRight size={14} />
                        ) : (
                          <ChevronDown size={14} />
                        )}
                      </button>
                      <button
                        type="button"
                        disabled={categoryIndex === 0}
                        onClick={() => void reorderCategory(category.id, -1)}
                        aria-label="分类左移"
                      >
                        <ArrowLeft size={13} />
                      </button>
                      <button
                        type="button"
                        disabled={categoryIndex === snapshot.categories.length - 1}
                        onClick={() => void reorderCategory(category.id, 1)}
                        aria-label="分类右移"
                      >
                        <ArrowRight size={13} />
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingCategory(category)}
                        aria-label="编辑分类"
                      >
                        <Palette size={13} />
                      </button>
                    </div>
                  </header>

                  {!categoryCollapsed ? (
                  <div className="column-cards">
                    {visibleCategoryCards.map((card) => (
                      <article
                        className={`synthesis-card ${selectedCardIds.has(card.id) ? 'selected' : ''} ${draggedCardId === card.id ? 'dragging' : ''}`}
                        key={card.id}
                        data-synthesis-card={card.id}
                        draggable
                        onDragStart={(event) => {
                          setDraggedCardId(card.id)
                          event.dataTransfer.effectAllowed = 'move'
                          event.dataTransfer.setData(synthesisCardTransferType, card.id)
                          event.dataTransfer.setData('text/plain', card.id)
                        }}
                        onDragEnd={() => {
                          setDraggedCardId(null)
                          setDragOverCategory(null)
                        }}
                      >
                        <label className="card-selection-checkbox" title="选择卡片进行批量操作" onPointerDown={(event) => event.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={selectedCardIds.has(card.id)}
                            onChange={() => toggleCardSelection(card.id)}
                            aria-label={`选择卡片：${card.displayText.slice(0, 40)}`}
                          />
                        </label>
                        <div className="synthesis-card-source">
                          <span>{card.documentAuthors || '未知作者'}</span>
                          <span>第 {card.printPage ?? card.pdfPage ?? '—'} 页</span>
                        </div>
                        <blockquote>{card.displayText}</blockquote>
                        {card.comment ? <p>{card.comment}</p> : null}
                        <div className="card-meta-row">
                          <div className="research-role-pills">
                            {card.researchRoles.length > 0 ? card.researchRoles.map((role) => (
                              <span
                                className="role-pill"
                                key={role.id}
                                style={{ '--role-color': role.color } as React.CSSProperties}
                              >
                                {role.name}
                              </span>
                            )) : <span className="soft-pill">未设置作用</span>}
                          </div>
                          <button type="button" onClick={() => setEditingCard(card)}>
                            <Edit3 size={13} /> 编辑
                          </button>
                        </div>
                        <label className="category-move-control">
                          <span>移动到分类</span>
                          <select
                            value={card.categoryId ?? category.id}
                            onChange={(event) => void moveCard(event.target.value, card.id)}
                            onPointerDown={(event) => event.stopPropagation()}
                            aria-label="移动到分类"
                          >
                            {snapshot.categories.map((candidate) => (
                              <option key={candidate.id} value={candidate.id}>
                                {candidate.name}
                              </option>
                            ))}
                          </select>
                        </label>
                        <button
                          className="exclude-button"
                          type="button"
                          onClick={() =>
                            void runMutation(
                              () => api.setCardExcluded(card.id, true),
                              '卡片已从二次整理剔除，仍保留在卡片库。'
                            )
                          }
                        >
                          <ArchiveX size={13} /> 从二次整理剔除（不删除）
                        </button>
                      </article>
                    ))}
                    {!deferredQuery && categoryCards.length > collapsedCardPreviewCount ? (
                      <button
                        className="category-card-overflow"
                        type="button"
                        onClick={() => toggleCategoryExpanded(category.id)}
                      >
                        {categoryExpanded ? (
                          <>
                            <ChevronsUp size={15} /> 收起，仅显示前 {collapsedCardPreviewCount} 张
                          </>
                        ) : (
                          <>
                            <ChevronsDown size={15} /> 展开其余 {hiddenCardCount} 张
                          </>
                        )}
                      </button>
                    ) : null}
                    {categoryCards.length === 0 ? (
                      <div className="column-empty">
                        {deferredQuery ? <Search size={18} /> : <SlidersHorizontal size={18} />}
                        <span>{deferredQuery ? '本分类没有匹配卡片' : '拖入卡片'}</span>
                      </div>
                    ) : null}
                  </div>
                  ) : null}
                </section>
              )
            })}
          </div>
        </div>
      ) : (
        <div className="excluded-list">
          {visibleExcludedCards.map((card) => {
            const previousCategory = card.categoryId ? categoryById.get(card.categoryId) : undefined
            return (
              <article
                className={`excluded-card ${selectedCardIds.has(card.id) ? 'selected' : ''}`}
                key={card.id}
                data-synthesis-card={card.id}
              >
                <label className="card-selection-checkbox" title="选择卡片进行批量操作">
                  <input
                    type="checkbox"
                    checked={selectedCardIds.has(card.id)}
                    onChange={() => toggleCardSelection(card.id)}
                    aria-label={`选择卡片：${card.displayText.slice(0, 40)}`}
                  />
                </label>
                <div className="excluded-icon">
                  <ArchiveX size={18} />
                </div>
                <div>
                  <span>
                    {card.documentAuthors || '未知作者'} · 第 {card.printPage ?? card.pdfPage ?? '—'} 页
                  </span>
                  <blockquote>{card.displayText}</blockquote>
                  <p>剔除前分类：{previousCategory?.name ?? '待归类'}</p>
                </div>
                <button
                  className="button secondary"
                  type="button"
                  onClick={() =>
                    void runMutation(
                      () => api.setCardExcluded(card.id, false),
                      `卡片已恢复到“${previousCategory?.name ?? '待归类'}”。`
                    )
                  }
                >
                  <RotateCcw size={14} /> 恢复到二次整理
                </button>
              </article>
            )
          })}
          {visibleExcludedCards.length === 0 ? (
            <EmptyState
              icon={Layers3}
              title={deferredQuery ? '没有匹配的已剔除卡片' : '没有已剔除卡片'}
              description={
                deferredQuery
                  ? '尝试缩短关键词，或清空搜索条件。'
                  : '从整理板剔除的卡片会保留在这里，并可随时恢复。'
              }
            />
          ) : null}
        </div>
      )}

      {editingCard ? (
        <CardEditDialog
          card={editingCard}
          researchRoles={snapshot.researchRoles}
          outlineUsages={snapshot.outlineLinks
            .filter((link) => link.projectCardId === editingCard.id)
            .map((link) => ({
              linkId: link.id,
              nodeTitle: snapshot.outlineNodes.find((node) => node.id === link.outlineNodeId)?.title ?? '未知章节',
              note: link.note
            }))}
          onSave={saveCard}
          onClose={() => setEditingCard(null)}
          onOpenSource={() => onOpenSource(editingCard.documentId, editingCard.pdfPage, editingCard.locatorJson)}
        />
      ) : null}
      {editingCategory ? (
        <CategoryDialog
          projectId={snapshot.currentProjectId}
          category={editingCategory === 'new' ? null : editingCategory}
          defaultCategoryName={
            snapshot.categories.find((category) => category.isDefault)?.name ?? '默认分类'
          }
          runMutation={runMutation}
          onClose={() => setEditingCategory(null)}
        />
      ) : null}
      {showResearchRoleManager && snapshot.currentProjectId ? (
        <ResearchRoleManager
          projectId={snapshot.currentProjectId}
          roles={snapshot.researchRoles}
          runMutation={runMutation}
          onClose={() => setShowResearchRoleManager(false)}
        />
      ) : null}
    </div>
  )
}

interface ResearchRoleManagerProps {
  projectId: string
  roles: ResearchRole[]
  runMutation: RunMutation
  onClose: () => void
}

function ResearchRoleManager({
  projectId,
  roles,
  runMutation,
  onClose
}: ResearchRoleManagerProps): React.JSX.Element {
  const [editing, setEditing] = useState<ResearchRole | 'new' | null>(null)
  const [name, setName] = useState('')
  const [color, setColor] = useState('#8a6757')
  const [confirmingEditorDiscard, setConfirmingEditorDiscard] = useState(false)
  const editorHasUnsavedChanges = editing
    ? name !== (editing === 'new' ? '' : editing.name) ||
      color !== (editing === 'new' ? '#8a6757' : editing.color)
    : false

  const beginEditing = (role: ResearchRole | 'new'): void => {
    setEditing(role)
    setName(role === 'new' ? '' : role.name)
    setColor(role === 'new' ? '#8a6757' : role.color)
  }

  const saveRole = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (!editing) return
    const succeeded = editing === 'new'
      ? await runMutation(
          () => api.createResearchRole({ projectId, name, color }),
          '研究作用已创建。'
        )
      : await runMutation(
          () => api.updateResearchRole({ researchRoleId: editing.id, name, color }),
          '研究作用已更新。'
        )
    if (succeeded) setEditing(null)
  }

  const moveRole = async (roleId: string, direction: -1 | 1): Promise<void> => {
    const ids = roles.map((role) => role.id)
    const current = ids.indexOf(roleId)
    const next = current + direction
    if (current < 0 || next < 0 || next >= ids.length) return
    ;[ids[current], ids[next]] = [ids[next] as string, ids[current] as string]
    await runMutation(() => api.reorderResearchRoles(projectId, ids), '研究作用顺序已保存。')
  }

  return (
    <>
      <Modal
        title="管理研究作用"
        subtitle="研究作用属于当前项目；一张卡片可以同时选择多个。归档不会移除已有卡片关联。"
        onClose={onClose}
        width="large"
        hasUnsavedChanges={editorHasUnsavedChanges}
      >
        <div className="research-role-manager">
        <div className="research-role-manager-toolbar">
          <button className="button secondary" type="button" disabled={Boolean(editing)} onClick={() => beginEditing('new')}>
            <Plus size={14} /> 新建研究作用
          </button>
        </div>
        {editing ? (
          <form className="research-role-editor" onSubmit={(event) => void saveRole(event)}>
            <label className="field">
              <span>名称</span>
              <input autoFocus required maxLength={160} value={name} onChange={(event) => setName(event.target.value)} />
            </label>
            <label className="field color-field">
              <span>颜色</span>
              <input type="color" value={color} onChange={(event) => setColor(event.target.value)} />
              <code>{color}</code>
            </label>
            <div className="compact-actions">
              <button
                className="button ghost"
                type="button"
                onClick={() => {
                  if (editorHasUnsavedChanges) setConfirmingEditorDiscard(true)
                  else setEditing(null)
                }}
              >取消</button>
              <button className="button primary" type="submit">{editing === 'new' ? '创建' : '保存'}</button>
            </div>
          </form>
        ) : null}
        <div className="research-role-manager-list">
          {roles.map((role, index) => (
            <div className={role.isArchived ? 'archived' : ''} key={role.id}>
              <i style={{ backgroundColor: role.color }} />
              <span>
                <strong>{role.name}</strong>
                <small>{role.isArchived ? '已归档 · 已有关联继续保留' : role.isDefault ? '默认快捷项' : '自定义作用'}</small>
              </span>
              <button type="button" disabled={index === 0} onClick={() => void moveRole(role.id, -1)} title="上移">
                <ArrowLeft size={13} />
              </button>
              <button type="button" disabled={index === roles.length - 1} onClick={() => void moveRole(role.id, 1)} title="下移">
                <ArrowRight size={13} />
              </button>
              <button type="button" disabled={Boolean(editing)} onClick={() => beginEditing(role)} title="编辑">
                <Edit3 size={13} />
              </button>
              <button
                type="button"
                onClick={() => void runMutation(
                  () => api.setResearchRoleArchived(role.id, !role.isArchived),
                  role.isArchived ? '研究作用已重新启用。' : '研究作用已归档，已有卡片关联继续保留。'
                )}
              >
                {role.isArchived ? <RotateCcw size={13} /> : <ArchiveX size={13} />}
                {role.isArchived ? '启用' : '归档'}
              </button>
            </div>
          ))}
        </div>
        <div className="modal-actions">
          <button className="button primary" type="button" data-modal-close>完成</button>
        </div>
        </div>
      </Modal>
      {confirmingEditorDiscard ? (
        <ConfirmDialog
          title="放弃研究作用的修改？"
          description="名称或颜色尚未保存。可以继续编辑，或放弃这次修改。"
          confirmLabel="放弃修改"
          dangerous
          onConfirm={() => {
            setConfirmingEditorDiscard(false)
            setEditing(null)
          }}
          onCancel={() => setConfirmingEditorDiscard(false)}
        />
      ) : null}
    </>
  )
}

interface CategoryDialogProps {
  projectId: string | null
  category: SynthesisCategory | null
  defaultCategoryName: string
  runMutation: RunMutation
  onClose: () => void
}

function CategoryDialog({
  projectId,
  category,
  defaultCategoryName,
  runMutation,
  onClose
}: CategoryDialogProps): React.JSX.Element {
  const [name, setName] = useState(category?.name ?? '')
  const [color, setColor] = useState(category?.color ?? '#8a6757')
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (!projectId) return
    const succeeded = category
      ? await runMutation(
          () => api.updateCategory({ categoryId: category.id, name, color }),
          '分类名称与颜色已更新。'
        )
      : await runMutation(
          () => api.createCategory({ projectId, name, color }),
          '新整理分类已创建。'
        )
    if (succeeded) onClose()
  }

  const deleteCategory = async (): Promise<void> => {
    if (!category || category.isDefault) return
    const succeeded = await runMutation(
      () => api.deleteCategory(category.id),
      `“${category.name}”已删除，其中的卡片已移回“${defaultCategoryName}”。`
    )
    if (succeeded) onClose()
  }

  return (
    <>
      <Modal
        title={category ? '编辑整理分类' : '新建整理分类'}
        subtitle="分类是当前项目的整理结构，可以随研究推进持续调整。"
        onClose={onClose}
        width="small"
        hasUnsavedChanges={name !== (category?.name ?? '') || color !== (category?.color ?? '#8a6757')}
      >
        <form onSubmit={submit}>
          <label className="field">
            <span>分类名称</span>
            <input
              autoFocus
              required
              maxLength={160}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="field color-field">
            <span>标识颜色</span>
            <input type="color" value={color} onChange={(event) => setColor(event.target.value)} />
            <code>{color}</code>
          </label>
          <div className="modal-actions">
            {category && !category.isDefault ? (
              <button
                className="button danger category-delete-action"
                type="button"
                onClick={() => setConfirmingDelete(true)}
              >
                <Trash2 size={14} /> 删除分类
              </button>
            ) : null}
            <button className="button ghost" type="button" data-modal-close>
              取消
            </button>
            <button className="button primary" type="submit">
              {category ? '保存修改' : '创建分类'}
            </button>
          </div>
        </form>
      </Modal>
      {confirmingDelete && category ? (
        <ConfirmDialog
          title={`删除“${category.name}”？`}
          description={`分类中的卡片不会被删除；它们会回到默认分类“${defaultCategoryName}”，剔除状态和提纲关联保持不变。`}
          confirmLabel="删除分类"
          dangerous
          onConfirm={() => void deleteCategory()}
          onCancel={() => setConfirmingDelete(false)}
        />
      ) : null}
    </>
  )
}
