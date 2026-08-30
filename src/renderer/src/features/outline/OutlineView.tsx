import {
  ArrowDown,
  ArrowUp,
  BookOpenCheck,
  ChevronRight,
  Edit3,
  FilePlus2,
  GripVertical,
  Link2,
  Plus,
  Search,
  Trash2,
  Unlink
} from 'lucide-react'
import { useDeferredValue, useEffect, useMemo, useState } from 'react'
import type {
  CreateOutlineNodeInput,
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
import { flattenOutline } from '../../lib/outline'
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
  const flatNodes = useMemo(() => flattenOutline(snapshot.outlineNodes), [snapshot.outlineNodes])
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(
    flatNodes[0]?.node.id ?? null
  )
  const [nodeDialog, setNodeDialog] = useState<
    { mode: 'new'; parentId: string | null } | { mode: 'edit'; node: OutlineNode } | null
  >(null)
  const [deletingNode, setDeletingNode] = useState<OutlineNode | null>(null)
  const [draggedNodeId, setDraggedNodeId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null)
  const [viewingCard, setViewingCard] = useState<ProjectCardView | null>(null)
  const [cardQuery, setCardQuery] = useState('')
  const deferredCardQuery = useDeferredValue(cardQuery.trim().toLocaleLowerCase())

  useEffect(() => {
    if (selectedNodeId && snapshot.outlineNodes.some((node) => node.id === selectedNodeId)) return
    setSelectedNodeId(flatNodes[0]?.node.id ?? null)
  }, [flatNodes, selectedNodeId, snapshot.outlineNodes])

  const activeCards = useMemo(
    () =>
      snapshot.cards.filter((card) => {
        if (card.synthesisState !== 'active') return false
        if (!deferredCardQuery) return true
        return [card.displayText, card.comment, card.documentTitle, card.documentAuthors, ...card.tags]
          .join('\n')
          .toLocaleLowerCase()
          .includes(deferredCardQuery)
      }),
    [deferredCardQuery, snapshot.cards]
  )

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
          <h1>论文提纲</h1>
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

      <div className="outline-layout">
        <section className="outline-paper">
          <div className="paper-title-row">
            <div>
              <span className="eyebrow">结构草稿</span>
              <h2>章节与证据</h2>
            </div>
            <span>{snapshot.outlineNodes.length} 个章节节点</span>
          </div>

          {flatNodes.map(({ node, depth }) => {
            const links = snapshot.outlineLinks.filter((link) => link.outlineNodeId === node.id)
            const isSelected = node.id === selectedNodeId
            const targetPlacement = dropTarget?.nodeId === node.id ? dropTarget.placement : null
            return (
              <article
                className={`outline-node ${isSelected ? 'selected' : ''} ${
                  targetPlacement ? `drop-${targetPlacement}` : ''
                }`}
                key={node.id}
                style={{ '--outline-depth': depth } as React.CSSProperties}
                draggable
                onDragStart={(event) => {
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
                  const rect = event.currentTarget.getBoundingClientRect()
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
                  <span className="outline-grip">
                    <GripVertical size={14} />
                  </span>
                  <span className="outline-index" style={{ borderColor: isSelected ? '#a35f43' : undefined }}>
                    {depth + 1}
                  </span>
                  <div className="outline-copy">
                    <div className="outline-title-line">
                      <h3>{node.title}</h3>
                      <span>{links.length} 张卡片</span>
                    </div>
                    {node.coreArgument ? <p className="core-argument">{node.coreArgument}</p> : null}
                    {node.notes ? <p>{node.notes}</p> : null}
                    {node.openQuestions ? (
                      <p className="open-question">待解决：{node.openQuestions}</p>
                    ) : null}
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

                {links.length > 0 ? (
                  <div className="outline-evidence-list">
                    {links.map((link, linkIndex) => {
                      const card = snapshot.cards.find((candidate) => candidate.id === link.projectCardId)
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
                            <strong>{card.displayText}</strong>
                            <small>
                              {card.documentAuthors || '未知作者'} · 第{' '}
                              {card.printPage ?? card.pdfPage ?? '—'} 页
                            </small>
                          </button>
                          <div className="evidence-actions">
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

        <aside className="outline-card-pool">
          <div className="pool-heading">
            <div>
              <span className="eyebrow">二次整理卡片</span>
              <h2>选择证据</h2>
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
          {selectedNodeId ? (
            <div className="selected-chapter-note">
              <ChevronRight size={14} />
              <span>
                将卡片关联到
                <strong>
                  {snapshot.outlineNodes.find((node) => node.id === selectedNodeId)?.title}
                </strong>
              </span>
            </div>
          ) : (
            <div className="selected-chapter-note muted">请先选择一个章节。</div>
          )}
          <div className="pool-card-list">
            {activeCards.map((card) => {
              const linkedToSelected = snapshot.outlineLinks.some(
                (link) =>
                  link.outlineNodeId === selectedNodeId && link.projectCardId === card.id
              )
              const usageTitles = snapshot.outlineLinks
                .filter((link) => link.projectCardId === card.id)
                .map((link) =>
                  snapshot.outlineNodes.find((node) => node.id === link.outlineNodeId)
                )
                .filter((node): node is OutlineNode => Boolean(node))
                .map((node) => node.title)
              const usageLabel =
                usageTitles.length > 0 ? `已用于：${usageTitles.join('、')}` : '尚未进入提纲'
              return (
                <article className="pool-card" key={card.id}>
                  <span>
                    {card.documentAuthors || '未知作者'} · {card.printPage ?? card.pdfPage ?? '—'}
                  </span>
                  <p>{card.displayText}</p>
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
          </div>
        </aside>
      </div>

      {viewingCard ? (
        <CardEditDialog
          card={viewingCard}
          onSave={saveViewingCard}
          onClose={() => setViewingCard(null)}
          onOpenSource={() => onOpenSource(viewingCard.documentId, viewingCard.pdfPage, viewingCard.locatorJson)}
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
      subtitle="章节结构和内容说明由研究者自行维护。"
      onClose={onClose}
      width="large"
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
          <button className="button ghost" type="button" onClick={onClose}>
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
