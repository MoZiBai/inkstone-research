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
import { useDeferredValue, useEffect, useMemo, useState } from 'react'
import type { ProjectCardView, WorkspaceSnapshot } from '@shared/types'
import { BulkCardActions } from '../../components/BulkCardActions'
import { CardEditDialog } from '../../components/CardEditDialog'
import { ContextMenu } from '../../components/ContextMenu'
import { EmptyState } from '../../components/EmptyState'
import { ConfirmDialog } from '../../components/Modal'
import { api } from '../../lib/api'
import { usePersistentSet, usePersistentState } from '../../lib/preferences'
import { CardText } from '../../components/CardText'
import { descendantDocumentGroupIds } from '../reading/documentGroups'
import {
  filterProjectCards,
  groupCardsByDocument,
  type CardStateFilter
} from '../../lib/workspaceCollections'
import type { RunMutation } from '../../types'

interface LibraryViewProps {
  snapshot: WorkspaceSnapshot
  runMutation: RunMutation
  currentReadingDocumentId: string | null
  onLocateSynthesis: (cardId: string, excluded: boolean) => void
  onOpenSource: (documentId: string, page: number | null, locatorJson: string) => void
}

const libraryCardPreviewCount = 10

export function LibraryView({
  snapshot,
  runMutation,
  currentReadingDocumentId,
  onLocateSynthesis,
  onOpenSource
}: LibraryViewProps): React.JSX.Element {
  const [query, setQuery] = usePersistentState(`inkstone:library-query:${snapshot.currentProjectId}`, '')
  const deferredQuery = useDeferredValue(query.trim().toLocaleLowerCase())
  const [stateFilter, setStateFilter] = usePersistentState<CardStateFilter>(`inkstone:library-filter:${snapshot.currentProjectId}`, 'all')
  const [collapsedDocumentIds, setCollapsedDocumentIds] = usePersistentSet<string>(`inkstone:library-collapsed:${snapshot.currentProjectId}`)
  const [sourceFilter, setSourceFilter] = usePersistentState(`inkstone:library-source:${snapshot.currentProjectId}`, '')
  useEffect(() => {
    if (sourceFilter.startsWith('doc:') && !snapshot.documents.some((document) => document.id === sourceFilter.slice(4))) setSourceFilter('')
    if (sourceFilter.startsWith('group:') && !snapshot.documentGroups.some((group) => group.id === sourceFilter.slice(6))) setSourceFilter('')
  }, [sourceFilter, snapshot.documents, snapshot.documentGroups, setSourceFilter])
  const [cardLimits, setCardLimits] = useState<Record<string, number>>({})
  const [editingCard, setEditingCard] = useState<ProjectCardView | null>(null)
  const [deletingCard, setDeletingCard] = useState<ProjectCardView | null>(null)
  const [expandedDocumentIds, setExpandedDocumentIds] = usePersistentSet<string>(`inkstone:library-expanded:${snapshot.currentProjectId}`)
  const [selectedCardIds, setSelectedCardIds] = useState<Set<string>>(() => new Set())
  const [cardContextMenu, setCardContextMenu] = useState<{
    x: number
    y: number
    card: ProjectCardView
  } | null>(null)

  const filteredCards = useMemo(
    () => {
      const filtered = filterProjectCards(snapshot.cards, deferredQuery, stateFilter)
      if (!sourceFilter) return filtered
      if (sourceFilter.startsWith('doc:')) return filtered.filter((card) => card.documentId === sourceFilter.slice(4))
      const ids = descendantDocumentGroupIds(snapshot.documentGroups, sourceFilter.slice(6))
      ids.add(sourceFilter.slice(6))
      const documents = new Set(snapshot.documents.filter((document) => document.groupId && ids.has(document.groupId)).map((document) => document.id))
      return filtered.filter((card) => documents.has(card.documentId))
    },
    [deferredQuery, snapshot.cards, snapshot.documents, snapshot.documentGroups, sourceFilter, stateFilter]
  )
  const cardsByDocument = useMemo(
    () => groupCardsByDocument(filteredCards),
    [filteredCards]
  )
  const categoryById = useMemo(
    () => new Map(snapshot.categories.map((category) => [category.id, category])),
    [snapshot.categories]
  )

  const groups = useMemo(
    () =>
      snapshot.documents
        .map((document) => ({
          document,
          cards: cardsByDocument.get(document.id) ?? []
        }))
        .filter((group) => group.cards.length > 0 || (!deferredQuery && !sourceFilter && stateFilter === 'all'))
        .sort((first, second) => {
          if (first.document.id === currentReadingDocumentId) return -1
          if (second.document.id === currentReadingDocumentId) return 1
          return first.document.sortOrder - second.document.sortOrder
        }),
    [cardsByDocument, currentReadingDocumentId, deferredQuery, snapshot.documents, sourceFilter, stateFilter]
  )

  const cardStateCounts = useMemo(
    () => ({
      all: snapshot.cards.length,
      active: snapshot.cards.filter((card) => card.synthesisState === 'active').length,
      excluded: snapshot.cards.filter((card) => card.synthesisState === 'excluded').length
    }),
    [snapshot.cards]
  )

  useEffect(() => {
    const availableIds = new Set(filteredCards.map((card) => card.id))
    setSelectedCardIds((current) => new Set([...current].filter((id) => availableIds.has(id))))
  }, [filteredCards])

  const toggleCardSelection = (cardId: string): void => {
    setSelectedCardIds((current) => {
      const next = new Set(current)
      if (next.has(cardId)) next.delete(cardId)
      else next.add(cardId)
      return next
    })
  }

  const allVisibleSelected = filteredCards.length > 0 && filteredCards.every((card) => selectedCardIds.has(card.id))
  const toggleVisibleSelection = (): void => {
    setSelectedCardIds((current) => {
      const next = new Set(current)
      for (const card of filteredCards) {
        if (allVisibleSelected) next.delete(card.id)
        else next.add(card.id)
      }
      return next
    })
  }

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

  const toggleDocumentCardsExpanded = (documentId: string): void => {
    setExpandedDocumentIds((current) => {
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
            className="button secondary library-select-visible"
            type="button"
            disabled={filteredCards.length === 0}
            onClick={toggleVisibleSelection}
          >
            {allVisibleSelected ? '取消筛选结果选择' : `选择全部筛选结果 ${filteredCards.length} 张`}
          </button>
          <div className="segmented-control library-state-filter" aria-label="卡片整理状态筛选">
            {(['all', 'active', 'excluded'] as const).map((state) => (
              <button
                className={stateFilter === state ? 'active' : ''}
                type="button"
                key={state}
                onClick={() => setStateFilter(state)}
              >
                {state === 'all' ? '全部' : state === 'active' ? '整理中' : '已剔除'}
                <span>{cardStateCounts[state]}</span>
              </button>
            ))}
          </div>
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
          <select className="library-document-filter" aria-label="按文献或文献分类筛选" value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value)}>
            <option value="">全部来源</option>
            <optgroup label="文献分类">{snapshot.documentGroups.map((group) => <option key={group.id} value={`group:${group.id}`}>{group.name}</option>)}</optgroup>
            <optgroup label="文献">{snapshot.documents.map((document) => <option key={document.id} value={`doc:${document.id}`}>{document.title}</option>)}</optgroup>
          </select>
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

      <BulkCardActions
        snapshot={snapshot}
        selectedIds={selectedCardIds}
        context="library"
        runMutation={runMutation}
        onClear={() => setSelectedCardIds(new Set())}
      />

      <div className="library-groups">
        {groups.map(({ document, cards }) => {
          const collapsed = !deferredQuery && collapsedDocumentIds.has(document.id)
          const cardsExpanded = Boolean(deferredQuery) || expandedDocumentIds.has(document.id)
          const visibleCards = cards.slice(0, cardsExpanded ? (cardLimits[document.id] ?? 50) : libraryCardPreviewCount)
          const hiddenCardCount = cards.length - visibleCards.length
          return (
          <section className={`document-group ${collapsed ? 'collapsed' : ''} ${document.id === currentReadingDocumentId ? 'current-reading-document' : ''}`} key={document.id}>
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
              {document.id === currentReadingDocumentId ? <span className="current-reading-badge">正在阅读</span> : null}
              <span className="count-badge">{cards.length} 张卡片</span>
            </header>

            {!collapsed && cards.length > 0 ? (
              <div className="library-card-list">
                {visibleCards.map((card) => {
                  const category = card.categoryId ? categoryById.get(card.categoryId) : undefined
                  const excluded = card.synthesisState === 'excluded'
                  return (
                    <article
                      className={`library-card ${selectedCardIds.has(card.id) ? 'selected' : ''}`}
                      key={card.id}
                      onContextMenu={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        setCardContextMenu({ x: event.clientX, y: event.clientY, card })
                      }}
                    >
                      <label className="card-selection-checkbox" title="选择卡片进行批量操作">
                        <input
                          type="checkbox"
                          checked={selectedCardIds.has(card.id)}
                          onChange={() => toggleCardSelection(card.id)}
                          aria-label={`选择卡片：${card.displayText.slice(0, 40)}`}
                        />
                      </label>
                      <div className="page-marker">
                        <span>{card.printPage ? '印刷页' : 'PDF 页'}</span>
                        <strong className={card.printPage ? undefined : 'pdf-only'}>
                          {card.printPage ?? card.pdfPage ?? '—'}
                        </strong>
                        {card.printPage ? <small>PDF {card.pdfPage ?? '—'}</small> : null}
                      </div>
                      <div className="library-card-body">
                        <div className="card-topline">
                          {card.researchRoles.length > 0 ? card.researchRoles.map((role) => (
                            <span
                              className="role-pill"
                              key={role.id}
                              style={{ '--role-color': role.color } as React.CSSProperties}
                            >
                              {role.name}
                            </span>
                          )) : <span className="soft-pill">未设置卡片用途</span>}
                          {card.rawText !== card.displayText ? (
                            <span className="soft-pill">保留原始版本</span>
                          ) : null}
                        </div>
                        <CardText card={card} />
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
                {hiddenCardCount > 0 && cardsExpanded ? <button className="library-card-overflow" type="button" onClick={() => setCardLimits((limits) => ({ ...limits, [document.id]: (limits[document.id] ?? 50) + 50 }))}>再显示 {Math.min(50, hiddenCardCount)} 张 · 剩余 {hiddenCardCount} 张</button> : null}
                {!deferredQuery && cards.length > libraryCardPreviewCount ? (
                  <button
                    className="library-card-overflow"
                    type="button"
                    onClick={() => toggleDocumentCardsExpanded(document.id)}
                  >
                    {cardsExpanded ? (
                      <><ChevronsUp size={15} /> 收起，仅显示前 {libraryCardPreviewCount} 张</>
                    ) : (
                      <><ChevronsDown size={15} /> 展开更多（共 {cards.length} 张）</>
                    )}
                  </button>
                ) : null}
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
            title={
              query
                ? '没有匹配的卡片'
                : stateFilter !== 'all'
                ? '当前整理状态下没有卡片'
                : '项目中还没有卡片'
            }
            description={
              query
                ? '尝试缩短关键词，或清空搜索条件。'
                : stateFilter !== 'all'
                ? '当前整理状态下没有卡片，可以切换到“全部”查看永久总库。'
                : '第一阶段的新项目会保持空白；真实摘录将在 PDF 阅读功能接入后创建。'
            }
          />
        ) : null}
      </div>

      {cardContextMenu ? (
        <ContextMenu
          x={cardContextMenu.x}
          y={cardContextMenu.y}
          ariaLabel="卡片操作"
          onClose={() => setCardContextMenu(null)}
          items={[
            {
              id: 'source',
              label: '查看 PDF 原文',
              icon: <FileText size={14} />,
              onSelect: () => onOpenSource(
                cardContextMenu.card.documentId,
                cardContextMenu.card.pdfPage,
                cardContextMenu.card.locatorJson
              )
            },
            {
              id: 'synthesis',
              label: cardContextMenu.card.synthesisState === 'excluded' ? '在已剔除中定位' : '在二次整理中定位',
              icon: <ArrowUpRight size={14} />,
              onSelect: () => onLocateSynthesis(
                cardContextMenu.card.id,
                cardContextMenu.card.synthesisState === 'excluded'
              )
            },
            {
              id: 'edit',
              label: '编辑卡片',
              icon: <Edit3 size={14} />,
              onSelect: () => setEditingCard(cardContextMenu.card)
            },
            {
              id: 'delete',
              label: '永久删除卡片',
              icon: <Trash2 size={14} />,
              danger: true,
              separatorBefore: true,
              onSelect: () => setDeletingCard(cardContextMenu.card)
            }
          ]}
        />
      ) : null}

      {editingCard ? (
        <CardEditDialog
          card={editingCard}
          researchRoles={snapshot.researchRoles}
          availableTags={[...new Set(snapshot.cards.flatMap((card) => card.tags))]}
          outlineUsages={snapshot.outlineLinks
            .filter((link) => link.projectCardId === editingCard.id)
            .map((link) => ({
              linkId: link.id,
              nodeTitle: snapshot.outlineNodes.find((node) => node.id === link.outlineNodeId)?.title ?? '未知章节',
              note: link.note
            }))}
          onSave={saveCard}
          onClose={() => setEditingCard(null)}
          onOpenSource={() => { setEditingCard(null); onOpenSource(editingCard.documentId, editingCard.pdfPage, editingCard.locatorJson) }}
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
