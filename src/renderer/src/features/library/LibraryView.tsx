import {
  ArrowUpRight,
  BookOpen,
  ChevronDown,
  ChevronRight,
  ChevronsDown,
  ChevronsUp,
  Edit3,
  FileText,
  Search,
  Trash2
} from 'lucide-react'
import { useDeferredValue, useMemo, useState } from 'react'
import type { ProjectCardView, WorkspaceSnapshot } from '@shared/types'
import { CardEditDialog } from '../../components/CardEditDialog'
import { EmptyState } from '../../components/EmptyState'
import { ConfirmDialog } from '../../components/Modal'
import { api } from '../../lib/api'
import type { RunMutation } from '../../types'

interface LibraryViewProps {
  snapshot: WorkspaceSnapshot
  runMutation: RunMutation
  onLocateSynthesis: (cardId: string, excluded: boolean) => void
  onOpenSource: (documentId: string, page: number | null, locatorJson: string) => void
}

const roleLabels: Record<ProjectCardView['role'], string> = {
  unset: '暂未判断',
  support: '支持',
  oppose: '反对',
  qualify: '限定',
  background: '背景'
}

export function LibraryView({
  snapshot,
  runMutation,
  onLocateSynthesis,
  onOpenSource
}: LibraryViewProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query.trim().toLocaleLowerCase())
  const [collapsedDocumentIds, setCollapsedDocumentIds] = useState<Set<string>>(
    () => new Set()
  )
  const [editingCard, setEditingCard] = useState<ProjectCardView | null>(null)
  const [deletingCard, setDeletingCard] = useState<ProjectCardView | null>(null)

  const filteredCards = useMemo(() => {
    if (!deferredQuery) return snapshot.cards
    return snapshot.cards.filter((card) =>
      [
        card.displayText,
        card.comment,
        card.documentTitle,
        card.documentAuthors,
        ...card.tags
      ]
        .join('\n')
        .toLocaleLowerCase()
        .includes(deferredQuery)
    )
  }, [deferredQuery, snapshot.cards])

  const groups = useMemo(
    () =>
      snapshot.documents
        .map((document) => ({
          document,
          cards: filteredCards.filter((card) => card.documentId === document.id)
        }))
        .filter((group) => group.cards.length > 0 || !deferredQuery),
    [deferredQuery, filteredCards, snapshot.documents]
  )

  const saveCard = async (input: Parameters<typeof api.updateCard>[0]): Promise<void> => {
    const succeeded = await runMutation(() => api.updateCard(input), '卡片评论与标签已更新。')
    if (succeeded) setEditingCard(null)
  }

  const permanentlyDelete = async (): Promise<void> => {
    if (!deletingCard) return
    const succeeded = await runMutation(
      () => api.deleteCard(deletingCard.id),
      '项目卡片已永久删除。'
    )
    if (succeeded) setDeletingCard(null)
  }

  const toggleDocument = (documentId: string): void => {
    setCollapsedDocumentIds((current) => {
      const next = new Set(current)
      if (next.has(documentId)) next.delete(documentId)
      else next.add(documentId)
      return next
    })
  }

  const searchIsActive = Boolean(deferredQuery)
  const allDocumentsCollapsed =
    !searchIsActive &&
    groups.length > 0 &&
    groups.every(({ document }) => collapsedDocumentIds.has(document.id))

  return (
    <div className="workspace-view library-view">
      <header className="view-heading">
        <div>
          <span className="eyebrow">永久总库</span>
          <h1>项目卡片库</h1>
          <p>按来源文献回顾项目中的全部摘录、评论和整理状态。</p>
        </div>
        <div className="library-heading-actions">
          <button
            className="button secondary library-collapse-all"
            type="button"
            onClick={() =>
              setCollapsedDocumentIds(
                allDocumentsCollapsed
                  ? new Set()
                  : new Set(groups.map(({ document }) => document.id))
              )
            }
            disabled={groups.length === 0 || searchIsActive}
            title={searchIsActive ? '搜索时会自动展开匹配文献' : undefined}
          >
            {allDocumentsCollapsed ? <ChevronsDown size={15} /> : <ChevronsUp size={15} />}
            {allDocumentsCollapsed ? '全部展开' : '全部收起'}
          </button>
          <label className="search-box">
            <Search size={16} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索引文、评论、作者或标签"
            />
            <span>{filteredCards.length}</span>
          </label>
        </div>
      </header>

      <div className="library-groups">
        {groups.map(({ document, cards }) => {
          const collapsed = !deferredQuery && collapsedDocumentIds.has(document.id)
          return (
          <section className={`document-group ${collapsed ? 'collapsed' : ''}`} key={document.id}>
            <header className="document-group-header">
              <button
                className="document-group-toggle"
                type="button"
                aria-label={`${collapsed ? '展开' : '收起'}文献“${document.title}”`}
                aria-expanded={!collapsed}
                onClick={() => toggleDocument(document.id)}
                disabled={searchIsActive}
                title={searchIsActive ? '搜索时会自动展开匹配文献' : undefined}
              >
                {collapsed ? <ChevronRight size={17} /> : <ChevronDown size={17} />}
              </button>
              <span className="document-group-mark">
                <BookOpen size={17} />
              </span>
              <div>
                <h2>{document.title}</h2>
                <p>
                  {document.authors || '未知作者'}
                  {document.year ? ` · ${document.year}` : ''}
                  {document.isRemoved ? ' · 已从阅读列表移除（来源保留）' : ''}
                </p>
              </div>
              <span className="count-badge">{cards.length} 张卡片</span>
            </header>

            {!collapsed && cards.length > 0 ? (
              <div className="library-card-list">
                {cards.map((card) => {
                  const category = snapshot.categories.find(
                    (candidate) => candidate.id === card.categoryId
                  )
                  const excluded = card.synthesisState === 'excluded'
                  return (
                    <article className="library-card" key={card.id}>
                      <div className="page-marker">
                        <span>印刷页</span>
                        <strong>{card.printPage ?? '—'}</strong>
                        <small>PDF {card.pdfPage ?? '—'}</small>
                      </div>
                      <div className="library-card-body">
                        <div className="card-topline">
                          <span className={`role-pill role-${card.role}`}>
                            {roleLabels[card.role]}
                          </span>
                          {card.rawText !== card.displayText ? (
                            <span className="soft-pill">保留原始版本</span>
                          ) : null}
                        </div>
                        <blockquote>{card.displayText}</blockquote>
                        {card.comment ? <p className="research-comment">{card.comment}</p> : null}
                        <div className="tag-list">
                          {card.tags.map((tag) => (
                            <span key={tag}>{tag}</span>
                          ))}
                        </div>
                      </div>
                      <div className="library-card-status">
                        <button
                          className={`synthesis-status ${excluded ? 'excluded' : ''}`}
                          type="button"
                          onClick={() => onLocateSynthesis(card.id, excluded)}
                        >
                          <span
                            className="status-dot"
                            style={{ backgroundColor: excluded ? '#9b8c86' : category?.color }}
                          />
                          <span>
                            <small>{excluded ? '已从二次整理剔除' : '正在二次整理'}</small>
                            <strong>{excluded ? '点击查看并恢复' : category?.name ?? '待归类'}</strong>
                          </span>
                          <ArrowUpRight size={14} />
                        </button>
                        <div className="card-actions">
                          <button
                            type="button"
                            onClick={() => onOpenSource(card.documentId, card.pdfPage, card.locatorJson)}
                          >
                            <FileText size={14} /> 查看原文
                          </button>
                          <button type="button" onClick={() => setEditingCard(card)}>
                            <Edit3 size={14} /> 编辑
                          </button>
                          <button
                            className="danger-text"
                            type="button"
                            onClick={() => setDeletingCard(card)}
                          >
                            <Trash2 size={14} /> 永久删除
                          </button>
                        </div>
                      </div>
                    </article>
                  )
                })}
              </div>
            ) : !collapsed ? (
              <div className="group-empty">这篇文献尚无卡片。</div>
            ) : null}
          </section>
          )
        })}

        {filteredCards.length === 0 ? (
          <EmptyState
            icon={FileText}
            title={query ? '没有匹配的卡片' : '项目中还没有卡片'}
            description={
              query
                ? '尝试缩短关键词，或清空搜索条件。'
                : '第一阶段的新项目会保持空白；真实摘录将在 PDF 阅读功能接入后创建。'
            }
          />
        ) : null}
      </div>

      {editingCard ? (
        <CardEditDialog
          card={editingCard}
          onSave={saveCard}
          onClose={() => setEditingCard(null)}
          onOpenSource={() => onOpenSource(editingCard.documentId, editingCard.pdfPage, editingCard.locatorJson)}
        />
      ) : null}
      {deletingCard ? (
        <ConfirmDialog
          title="永久删除这张项目卡片？"
          description="这会删除当前项目中的评论、标签、整理状态和全部章节关联。来源 PDF 与不可变原文摘录不会被删除，其他项目也不受影响。"
          confirmLabel="永久删除卡片"
          dangerous
          onConfirm={() => void permanentlyDelete()}
          onCancel={() => setDeletingCard(null)}
        />
      ) : null}
    </div>
  )
}
