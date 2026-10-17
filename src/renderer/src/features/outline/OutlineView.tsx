import {
  ArrowDown,
  ArrowUp,
  BookOpenCheck,
  ChevronDown,
  ChevronRight,
  Edit3,
  FilePlus2,
  GripVertical,
  Link2,
  ListFilter,
  Plus,
  Search,
  Trash2,
  Unlink
} from 'lucide-react'
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import type {
  CreateOutlineNodeInput,
  OutlineCardLink,
  OutlineNode,
  OutlinePlacement,
  ProjectCardView,
  UpdateOutlineNodeInput,
  WorkspaceSnapshot
} from '@shared/types'
import { CardEditDialog } from '../../components/CardEditDialog'
import { EmptyState } from '../../components/EmptyState'
import { ConfirmDialog, Modal } from '../../components/Modal'
import { api } from '../../lib/api'
import { CardText } from '../../components/CardText'
import { usePersistentSet, usePersistentState } from '../../lib/preferences'
import { flattenOutline } from '../../lib/outline'
import { buildOutlineWorkspaceIndexes, filterProjectCards } from '../../lib/workspaceCollections'
import type { RunMutation } from '../../types'

interface OutlineViewProps {
  snapshot: WorkspaceSnapshot
  runMutation: RunMutation
  onOpenSource: (documentId: string, page: number | null, locatorJson: string) => void
}

interface DropTarget {
  nodeId: string
  placement: OutlinePlacement
}

export function OutlineView({
  snapshot,
  runMutation,
  onOpenSource
}: OutlineViewProps): React.JSX.Element {
  const [collapsedNodeIds, setCollapsedNodeIds] = usePersistentSet<string>(`inkstone:outline-collapsed:${snapshot.currentProjectId}`)
  const flatNodes = useMemo(
    () => flattenOutline(snapshot.outlineNodes, collapsedNodeIds),
    [collapsedNodeIds, snapshot.outlineNodes]
  )
  const [selectedNodeId, setSelectedNodeId] = usePersistentState<string>(`inkstone:outline-selected:${snapshot.currentProjectId}`, flatNodes[0]?.node.id ?? '')
  const [nodeDialog, setNodeDialog] = useState<
    { mode: 'new'; parentId: string | null } | { mode: 'edit'; node: OutlineNode } | null
  >(null)
  const [deletingNode, setDeletingNode] = useState<OutlineNode | null>(null)
  const [draggedNodeId, setDraggedNodeId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null)
  const [viewingCard, setViewingCard] = useState<ProjectCardView | null>(null)
  const [editingLink, setEditingLink] = useState<OutlineCardLink | null>(null)
  const [cardQuery, setCardQuery] = usePersistentState(`inkstone:outline-query:${snapshot.currentProjectId}`, '')
  const [poolCategory, setPoolCategory] = usePersistentState(`inkstone:outline-category:${snapshot.currentProjectId}`, '')
  const [poolDocument, setPoolDocument] = usePersistentState(`inkstone:outline-document:${snapshot.currentProjectId}`, '')
  const [poolLimit, setPoolLimit] = useState(50)
  const [poolWidth, setPoolWidth] = usePersistentState(`inkstone:outline-pool-width:${snapshot.currentProjectId}`, 320)
  const [resizing, setResizing] = useState(false)
  const layoutRef = useRef<HTMLDivElement>(null)
  useEffect(() => setPoolLimit(50), [cardQuery, poolCategory, poolDocument])
  useEffect(() => {
    if (poolCategory && !snapshot.categories.some((category) => category.id === poolCategory)) setPoolCategory('')
    if (poolDocument && !snapshot.documents.some((document) => document.id === poolDocument)) setPoolDocument('')
  }, [poolCategory, poolDocument, snapshot.categories, snapshot.documents, setPoolCategory, setPoolDocument])
  useEffect(() => {
    if (!resizing) return
    const move = (event: PointerEvent): void => {
      const bounds = layoutRef.current?.getBoundingClientRect()
      if (bounds) setPoolWidth(Math.max(240, Math.min(500, bounds.width - 320, bounds.right - event.clientX)))
    }
    const stop = (): void => setResizing(false)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop, { once: true })
    window.addEventListener('pointercancel', stop, { once: true })
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop); window.removeEventListener('pointercancel', stop) }
  }, [resizing, setPoolWidth])
  const [hideLinkedToSelected, setHideLinkedToSelected] = useState(false)
  const deferredCardQuery = useDeferredValue(cardQuery.trim().toLocaleLowerCase())

  const indexes = useMemo(
    () => buildOutlineWorkspaceIndexes(snapshot.outlineNodes, snapshot.cards, snapshot.outlineLinks),
    [snapshot.cards, snapshot.outlineLinks, snapshot.outlineNodes]
  )
  const childCountByNodeId = useMemo(() => {
    const counts = new Map<string, number>()
    for (const node of snapshot.outlineNodes) {
      if (!node.parentId) continue
      counts.set(node.parentId, (counts.get(node.parentId) ?? 0) + 1)
    }
    return counts
  }, [snapshot.outlineNodes])
  const selectedLinkedCardIds = selectedNodeId
    ? indexes.linkedCardIdsByNodeId.get(selectedNodeId) ?? new Set<string>()
    : new Set<string>()

  useEffect(() => {
    if (selectedNodeId && flatNodes.some(({ node }) => node.id === selectedNodeId)) return
    setSelectedNodeId(flatNodes[0]?.node.id ?? '')
  }, [flatNodes, selectedNodeId])

  const activeCards = useMemo(() => {
    const matching = filterProjectCards(snapshot.cards, deferredCardQuery, 'active').filter((card) => (!poolCategory || card.categoryId === poolCategory) && (!poolDocument || card.documentId === poolDocument))
    if (!hideLinkedToSelected || !selectedNodeId) return matching
    const linkedIds = indexes.linkedCardIdsByNodeId.get(selectedNodeId) ?? new Set<string>()
    return matching.filter((card) => !linkedIds.has(card.id))
  }, [deferredCardQuery, poolCategory, poolDocument, hideLinkedToSelected, indexes.linkedCardIdsByNodeId, selectedNodeId, snapshot.cards])

  const toggleNodeCollapsed = (nodeId: string): void => {
    setSelectedNodeId(nodeId)
    setCollapsedNodeIds((current) => {
      const next = new Set(current)
      if (next.has(nodeId)) next.delete(nodeId)
      else next.add(nodeId)
      return next
    })
  }

  const moveNode = async (): Promise<void> => {
    if (!draggedNodeId || !dropTarget) return
    const input = {
      nodeId: draggedNodeId,
      targetNodeId: dropTarget.nodeId,
      placement: dropTarget.placement
    }
    setDraggedNodeId(null)
    setDropTarget(null)
    await runMutation(() => api.moveOutlineNode(input), '提纲层级与顺序已保存。')
  }

  const deleteNode = async (): Promise<void> => {
    if (!deletingNode) return
    const succeeded = await runMutation(
      () => api.deleteOutlineNode(deletingNode.id),
      '章节已删除；关联卡片仍保留在卡片库。'
    )
    if (succeeded) setDeletingNode(null)
  }

  const saveViewingCard = async (
    input: Parameters<typeof api.updateCard>[0]
  ): Promise<void> => {
    const succeeded = await runMutation(
      () => api.updateCard(input),
      '卡片评论与标签已更新。'
    )
    if (succeeded) setViewingCard(null)
  }

  return (
    <div className="workspace-view outline-view">
      <header className="view-heading">
        <div>
          <span className="eyebrow">用户自建结构</span>
          <h1>写作提纲</h1>
          <p>章节结构由你创建；卡片进入章节时只建立关联，不移动原卡片。</p>
        </div>
        <button
          className="button primary"
          type="button"
          onClick={() => setNodeDialog({ mode: 'new', parentId: null })}
        >
          <FilePlus2 size={15} /> 新建一级章节
        </button>
      </header>

      <div className={`outline-layout ${resizing ? 'resizing' : ''}`} ref={layoutRef} style={{ '--outline-pool-width': `${poolWidth}px` } as React.CSSProperties}>
        <section className="outline-paper">
          <div className="paper-title-row">
            <div>
              <span className="eyebrow">结构草稿</span>
              <h2>章节与卡片</h2>
            </div>
            <span>{snapshot.outlineNodes.length} 个章节节点</span>
          </div>

          {flatNodes.map(({ node, depth, number }) => {
            const links = indexes.linksByNodeId.get(node.id) ?? []
            const childCount = childCountByNodeId.get(node.id) ?? 0
            const canCollapse = childCount > 0 || links.length > 0
            const collapsed = canCollapse && collapsedNodeIds.has(node.id)
            const isSelected = node.id === selectedNodeId
            const targetPlacement = dropTarget?.nodeId === node.id ? dropTarget.placement : null
            return (
              <article
                className={`outline-node ${isSelected ? 'selected' : ''} ${collapsed ? 'collapsed' : ''} ${
                  targetPlacement ? `drop-${targetPlacement}` : ''
                }`}
                key={node.id}
                style={{ '--outline-depth': depth } as React.CSSProperties}
                onDragStart={(event) => {
                  if (!(event.target instanceof Element) || !event.target.closest('.outline-grip')) { event.preventDefault(); return }
                  setDraggedNodeId(node.id)
                  event.dataTransfer.effectAllowed = 'move'
                  event.dataTransfer.setData('text/plain', node.id)
                }}
                onDragEnd={() => {
                  setDraggedNodeId(null)
                  setDropTarget(null)
                }}
                onDragOver={(event) => {
                  event.preventDefault()
                  if (!draggedNodeId || draggedNodeId === node.id) return
                  const rect = (event.currentTarget.querySelector('.outline-node-main') ?? event.currentTarget).getBoundingClientRect()
                  const ratio = (event.clientY - rect.top) / rect.height
                  const placement: OutlinePlacement =
                    ratio < 0.26 ? 'before' : ratio > 0.74 ? 'after' : 'inside'
                  setDropTarget({ nodeId: node.id, placement })
                }}
                onDrop={(event) => {
                  event.preventDefault()
                  void moveNode()
                }}
              >
                <div className="outline-node-main" onClick={() => setSelectedNodeId(node.id)}>
                  <span className="outline-grip" draggable title="拖动调整顺序和层级">
                    <GripVertical size={14} />
                  </span>
                  <button
                    className="outline-collapse-toggle"
                    type="button"
                    disabled={!canCollapse}
                    aria-label={collapsed ? '展开章节' : '收起章节'}
                    aria-expanded={!collapsed}
                    title={canCollapse ? (collapsed ? '展开章节内容和子章节' : '收起章节内容和子章节') : '没有可收起的内容'}
                    onClick={(event) => {
                      event.stopPropagation()
                      if (canCollapse) toggleNodeCollapsed(node.id)
                    }}
                  >
                    {canCollapse ? (collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />) : null}
                  </button>
                  <span className="outline-index" style={{ borderColor: isSelected ? '#a35f43' : undefined }}>
                    {number}
                  </span>
                  <div className="outline-copy">
                    <div className="outline-title-line">
                      <h3>{node.title}</h3>
                      <span>{links.length} 张卡片</span>
                    </div>
                    {collapsed ? (
                      <p className="outline-collapsed-summary">已收起 · {childCount} 个子章节 · {links.length} 张卡片</p>
                    ) : (
                      <>
                        {node.coreArgument ? <p className="core-argument">{node.coreArgument}</p> : null}
                        {node.notes ? <p>{node.notes}</p> : null}
                        {node.openQuestions ? (
                          <p className="open-question">待解决：{node.openQuestions}</p>
                        ) : null}
                      </>
                    )}
                  </div>
                  <div className="outline-node-actions">
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation()
                        setNodeDialog({ mode: 'new', parentId: node.id })
                      }}
                      title="新建子章节"
                    >
                      <Plus size={14} />
                    </button>
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation()
                        setNodeDialog({ mode: 'edit', node })
                      }}
                      title="编辑章节"
                    >
                      <Edit3 size={14} />
                    </button>
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation()
                        setDeletingNode(node)
                      }}
                      title="删除章节"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>

                {!collapsed && links.length > 0 ? (
                  <div className="outline-evidence-list">
                    {links.map((link, linkIndex) => {
                      const card = indexes.cardsById.get(link.projectCardId)
                      if (!card) return null
                      return (
                        <div className="outline-evidence" key={link.id}>
                          <span className="evidence-dot" />
                          <button
                            className="outline-evidence-open"
                            type="button"
                            onClick={() => setViewingCard(card)}
                            title="打开卡片详情"
                          >
                            <CardText card={card} compact />
                            <small>
                              {card.documentAuthors || '未知作者'} · 第{' '}
                              {card.printPage ?? card.pdfPage ?? '—'} 页
                            </small>
                            {link.note ? <em>{link.note}</em> : null}
                          </button>
                          <div className="evidence-actions">
                            <button
                              type="button"
                              onClick={() => setEditingLink(link)}
                              title="编辑章节内使用说明"
                            >
                              <Edit3 size={12} />
                            </button>
                            <button
                              type="button"
                              disabled={linkIndex === 0}
                              onClick={() =>
                                void runMutation(
                                  () => api.moveOutlineCard(link.id, -1),
                                  '章节内卡片顺序已更新。'
                                )
                              }
                              title="上移"
                            >
                              <ArrowUp size={12} />
                            </button>
                            <button
                              type="button"
                              disabled={linkIndex === links.length - 1}
                              onClick={() =>
                                void runMutation(
                                  () => api.moveOutlineCard(link.id, 1),
                                  '章节内卡片顺序已更新。'
                                )
                              }
                              title="下移"
                            >
                              <ArrowDown size={12} />
                            </button>
                            <button
                              className="danger-text"
                              type="button"
                              onClick={() =>
                                void runMutation(
                                  () => api.removeOutlineLink(link.id),
                                  '已从本章节移除；原卡片未被删除。'
                                )
                              }
                              title="只移除章节关联"
                            >
                              <Unlink size={12} />
                            </button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                ) : null}
              </article>
            )
          })}

          {flatNodes.length === 0 ? (
            <EmptyState
              icon={BookOpenCheck}
              title="从第一章开始搭建结构"
              description="系统不会预设固定章节。你可以创建自己的章、节和小节。"
              action={
                <button
                  className="button primary"
                  type="button"
                  onClick={() => setNodeDialog({ mode: 'new', parentId: null })}
                >
                  新建一级章节
                </button>
              }
            />
          ) : null}
        </section>

        <div className="outline-resize-handle" role="separator" aria-label="调整提纲卡片栏宽度" aria-orientation="vertical" aria-valuemin={240} aria-valuemax={500} aria-valuenow={poolWidth} tabIndex={0} onPointerDown={(event) => { event.preventDefault(); setResizing(true) }} onKeyDown={(event) => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setPoolWidth((width) => Math.max(240, Math.min(500, width + (event.key === 'ArrowLeft' ? 20 : -20)))) } }} />
        <aside className="outline-card-pool">
          <div className="pool-heading">
            <div>
              <span className="eyebrow">二次整理卡片</span>
              <h2>选择卡片</h2>
            </div>
            <span>{activeCards.length}</span>
          </div>
          <label className="search-box compact-search">
            <Search size={14} />
            <input
              value={cardQuery}
              onChange={(event) => setCardQuery(event.target.value)}
              placeholder="筛选卡片"
            />
          </label>
          <div className="pool-filters">
            <select aria-label="按整理分类筛选候选卡片" value={poolCategory} onChange={(event) => setPoolCategory(event.target.value)}><option value="">全部分类</option>{snapshot.categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select>
            <select aria-label="按文献筛选候选卡片" value={poolDocument} onChange={(event) => setPoolDocument(event.target.value)}><option value="">全部文献</option>{snapshot.documents.map((document) => <option key={document.id} value={document.id}>{document.title}</option>)}</select>
          </div>
          {selectedNodeId ? (
            <div className="selected-chapter-note">
              <ChevronRight size={14} />
              <span>
                将卡片关联到
                <strong>
                  {indexes.nodesById.get(selectedNodeId)?.title}
                </strong>
              </span>
            </div>
          ) : (
            <div className="selected-chapter-note muted">请先选择一个章节。</div>
          )}
          <label className="outline-pool-filter">
            <input
              type="checkbox"
              checked={hideLinkedToSelected}
              disabled={!selectedNodeId}
              onChange={(event) => setHideLinkedToSelected(event.target.checked)}
            />
            <ListFilter size={13} />
            <span>隐藏已关联到本章的卡片</span>
            <small>{selectedLinkedCardIds.size}</small>
          </label>
          <div className="pool-card-list">
            {activeCards.slice(0, poolLimit).map((card) => {
              const linkedToSelected = selectedLinkedCardIds.has(card.id)
              const usageTitles = indexes.usageTitlesByCardId.get(card.id) ?? []
              const usageLabel =
                usageTitles.length > 0 ? `已用于：${usageTitles.join('、')}` : '尚未进入提纲'
              return (
                <article className="pool-card" key={card.id}>
                  <span>
                    {card.documentTitle} · {card.documentAuthors || '未知作者'} · {card.printPage ?? card.pdfPage ?? '—'}
                  </span>
                  <button className="pool-card-preview" type="button" onClick={() => setViewingCard(card)} title="查看卡片详情"><CardText card={card} compact /></button>
                  <div>
                    <small title={usageLabel}>{usageLabel}</small>
                    <button
                      type="button"
                      disabled={!selectedNodeId || linkedToSelected}
                      onClick={() =>
                        selectedNodeId
                          ? void runMutation(
                              () => api.linkCardToOutline(selectedNodeId, card.id),
                              '卡片已关联到章节；原卡片位置未改变。'
                            )
                          : undefined
                      }
                    >
                      <Link2 size={12} /> {linkedToSelected ? '已关联' : '加入章节'}
                    </button>
                  </div>
                </article>
              )
            })}
            {activeCards.length > poolLimit ? <button className="button ghost" type="button" onClick={() => setPoolLimit((count) => count + 50)}>再显示 50 张 · 剩余 {activeCards.length - poolLimit} 张</button> : null}
            {activeCards.length === 0 ? (
              <div className="pool-card-empty">
                {deferredCardQuery
                  ? '没有匹配的整理中卡片。'
                  : hideLinkedToSelected
                  ? '整理中卡片都已关联到当前章节。'
                  : '二次整理中暂无可用卡片。'}
              </div>
            ) : null}
          </div>
        </aside>
      </div>

      {viewingCard ? (
        <CardEditDialog
          card={viewingCard}
          researchRoles={snapshot.researchRoles}
          availableTags={[...new Set(snapshot.cards.flatMap((card) => card.tags))]}
          outlineUsages={snapshot.outlineLinks
            .filter((link) => link.projectCardId === viewingCard.id)
            .map((link) => ({
              linkId: link.id,
              nodeTitle: snapshot.outlineNodes.find((node) => node.id === link.outlineNodeId)?.title ?? '未知章节',
              note: link.note
            }))}
          onSave={saveViewingCard}
          onClose={() => setViewingCard(null)}
          onOpenSource={() => { setViewingCard(null); onOpenSource(viewingCard.documentId, viewingCard.pdfPage, viewingCard.locatorJson) }}
        />
      ) : null}
      {nodeDialog ? (
        <OutlineNodeDialog
          projectId={snapshot.currentProjectId}
          state={nodeDialog}
          runMutation={runMutation}
          onClose={() => setNodeDialog(null)}
        />
      ) : null}
      {editingLink ? (
        <OutlineLinkNoteDialog
          link={editingLink}
          chapterTitle={indexes.nodesById.get(editingLink.outlineNodeId)?.title ?? '当前章节'}
          runMutation={runMutation}
          onClose={() => setEditingLink(null)}
        />
      ) : null}
      {deletingNode ? (
        <ConfirmDialog
          title="删除这个章节？"
          description="该章节及其子章节会被删除，章节中的卡片关联也会移除；卡片本身仍保留在卡片库和二次整理中。"
          confirmLabel="删除章节"
          dangerous
          onConfirm={() => void deleteNode()}
          onCancel={() => setDeletingNode(null)}
        />
      ) : null}
    </div>
  )
}

interface OutlineLinkNoteDialogProps {
  link: OutlineCardLink
  chapterTitle: string
  runMutation: RunMutation
  onClose: () => void
}

function OutlineLinkNoteDialog({
  link,
  chapterTitle,
  runMutation,
  onClose
}: OutlineLinkNoteDialogProps): React.JSX.Element {
  const [note, setNote] = useState(link.note)

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    const succeeded = await runMutation(
      () => api.updateOutlineCardLink({ linkId: link.id, note }),
      '章节内使用说明已保存。'
    )
    if (succeeded) onClose()
  }

  return (
    <Modal
      title="章节内使用说明"
      subtitle={chapterTitle}
      onClose={onClose}
      width="large"
      hasUnsavedChanges={note !== link.note}
    >
      <form onSubmit={(event) => void submit(event)}>
        <label className="field">
          <span>这张卡片在本节如何使用</span>
          <textarea
            autoFocus
            rows={7}
            maxLength={20_000}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="可以记录它与本节论点的关系、使用方式，或仍需核查的问题……"
          />
        </label>
        <div className="modal-actions">
          <button className="button ghost" type="button" data-modal-close>取消</button>
          <button className="button primary" type="submit">保存说明</button>
        </div>
      </form>
    </Modal>
  )
}

interface OutlineNodeDialogProps {
  projectId: string | null
  state: { mode: 'new'; parentId: string | null } | { mode: 'edit'; node: OutlineNode }
  runMutation: RunMutation
  onClose: () => void
}

function OutlineNodeDialog({
  projectId,
  state,
  runMutation,
  onClose
}: OutlineNodeDialogProps): React.JSX.Element {
  const editingNode = state.mode === 'edit' ? state.node : null
  const [title, setTitle] = useState(editingNode?.title ?? '')
  const [notes, setNotes] = useState(editingNode?.notes ?? '')
  const [coreArgument, setCoreArgument] = useState(editingNode?.coreArgument ?? '')
  const [openQuestions, setOpenQuestions] = useState(editingNode?.openQuestions ?? '')
  const hasUnsavedChanges = editingNode
    ? title !== editingNode.title ||
      notes !== editingNode.notes ||
      coreArgument !== editingNode.coreArgument ||
      openQuestions !== editingNode.openQuestions
    : title.trim().length > 0

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (!projectId) return
    let succeeded = false
    if (state.mode === 'new') {
      const input: CreateOutlineNodeInput = {
        projectId,
        parentId: state.parentId,
        title
      }
      succeeded = await runMutation(
        () => api.createOutlineNode(input),
        state.parentId ? '子章节已创建。' : '一级章节已创建。'
      )
    } else {
      const input: UpdateOutlineNodeInput = {
        nodeId: state.node.id,
        title,
        notes,
        coreArgument,
        openQuestions
      }
      succeeded = await runMutation(() => api.updateOutlineNode(input), '章节内容已更新。')
    }
    if (succeeded) onClose()
  }

  return (
    <Modal
      title={state.mode === 'new' ? (state.parentId ? '新建子章节' : '新建一级章节') : '编辑章节'}
      subtitle="自行创建章节层级，记录写作说明、核心观点与待解决问题。"
      onClose={onClose}
      width="large"
      hasUnsavedChanges={hasUnsavedChanges}
    >
      <form onSubmit={submit}>
        <label className="field">
          <span>章节标题</span>
          <input
            autoFocus
            required
            maxLength={160}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        {state.mode === 'edit' ? (
          <>
            <label className="field">
              <span>核心论点</span>
              <textarea
                rows={3}
                value={coreArgument}
                onChange={(event) => setCoreArgument(event.target.value)}
              />
            </label>
            <div className="form-grid two-columns">
              <label className="field">
                <span>写作说明</span>
                <textarea rows={4} value={notes} onChange={(event) => setNotes(event.target.value)} />
              </label>
              <label className="field">
                <span>待解决问题</span>
                <textarea
                  rows={4}
                  value={openQuestions}
                  onChange={(event) => setOpenQuestions(event.target.value)}
                />
              </label>
            </div>
          </>
        ) : null}
        <div className="modal-actions">
          <button className="button ghost" type="button" data-modal-close>
            取消
          </button>
          <button className="button primary" type="submit">
            {state.mode === 'new' ? '创建章节' : '保存章节'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
