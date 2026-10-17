import { useEffect, useMemo, useState } from 'react'
import type { ProjectCardView, ResearchRole, UpdateCardInput } from '@shared/types'
import { Modal } from './Modal'
import { TagInput } from './TagInput'
import { parseTags } from '../lib/tags'

interface CardEditDialogProps {
  card: ProjectCardView
  researchRoles: ResearchRole[]
  availableTags?: string[]
  outlineUsages?: Array<{ linkId: string; nodeTitle: string; note: string }>
  onSave: (input: UpdateCardInput) => Promise<void>
  onClose: () => void
  onOpenSource?: () => void
}

const originLabels: Record<ProjectCardView['originKind'], string> = {
  normal: '普通摘录',
  insight: '由灵感转换',
  critique: '由质疑转换'
}

export function CardEditDialog({
  card,
  researchRoles,
  availableTags = [],
  outlineUsages = [],
  onSave,
  onClose,
  onOpenSource
}: CardEditDialogProps): React.JSX.Element {
  const [displayText, setDisplayText] = useState(card.displayText)
  const [printPageOverride, setPrintPageOverride] = useState(card.printPageOverride ?? '')
  const [comment, setComment] = useState(card.comment)
  const [selectedRoleIds, setSelectedRoleIds] = useState<Set<string>>(
    () => new Set(card.researchRoles.map((role) => role.id))
  )
  const [tags, setTags] = useState(card.tags.join('、'))

  useEffect(() => {
    setDisplayText(card.displayText)
    setPrintPageOverride(card.printPageOverride ?? '')
    setComment(card.comment)
    setSelectedRoleIds(new Set(card.researchRoles.map((role) => role.id)))
    setTags(card.tags.join('、'))
  }, [card])

  const visibleRoles = useMemo(
    () => researchRoles.filter((role) => !role.isArchived || selectedRoleIds.has(role.id)),
    [researchRoles, selectedRoleIds]
  )
  const hasUnsavedChanges =
    displayText !== card.displayText ||
    printPageOverride !== (card.printPageOverride ?? '') ||
    comment !== card.comment ||
    tags !== card.tags.join('、') ||
    Array.from(selectedRoleIds).sort().join('\u0000') !==
      card.researchRoles.map((role) => role.id).sort().join('\u0000')

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    await onSave({
      cardId: card.id,
      displayText,
      printPageOverride,
      comment,
      researchRoleIds: Array.from(selectedRoleIds),
      tags: parseTags(tags)
    })
  }

  const toggleRole = (roleId: string): void => {
    setSelectedRoleIds((current) => {
      const next = new Set(current)
      if (next.has(roleId)) next.delete(roleId)
      else next.add(roleId)
      return next
    })
  }

  return (
    <Modal
      title="阅读卡片详情"
      subtitle={`${card.documentAuthors || '未知作者'} · ${card.documentTitle}`}
      onClose={onClose}
      width="large"
      hasUnsavedChanges={hasUnsavedChanges}
    >
      <form onSubmit={submit}>
        <div className="card-detail-origin-row">
          <span className={`soft-pill origin-${card.originKind}`}>{originLabels[card.originKind]}</span>
          <span>PDF 第 {card.pdfPage ?? '—'} 页</span>
        </div>
        <label className="field">
          <span>我的笔记</span>
          <textarea
            rows={5}
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            placeholder="记录这段材料为什么重要、如何使用或有哪些疑问……"
          />
        </label>
        <label className="field excerpt-text-editor">
          <span>卡片摘录文字 <small>修改不会改变原始选区和 PDF 定位</small></span>
          <textarea
            required
            rows={5}
            maxLength={50_000}
            value={displayText}
            onChange={(event) => setDisplayText(event.target.value)}
          />
        </label>
        <div className="form-grid two-columns">
          <label className="field">
            <span>标签（使用顿号或逗号分隔）</span>
            <TagInput value={tags} onChange={setTags} suggestions={availableTags} />
          </label>
          <label className="field">
            <span>单卡印刷页覆盖 <small>留空则使用文献映射</small></span>
            <input
              value={printPageOverride}
              onChange={(event) => setPrintPageOverride(event.target.value)}
              placeholder={card.printPage && !card.printPageOverride ? `自动计算为 ${card.printPage}` : '例如 103 或 103a'}
            />
            <small>
              {card.printPageOverride
                ? '当前显示使用单卡覆盖；清空并保存可恢复自动计算。'
                : card.printPage
                  ? `当前按文献映射自动计算为第 ${card.printPage} 页。`
                  : '当前文献尚未设置印刷页映射。'}
            </small>
          </label>
        </div>
        <fieldset className="research-role-picker">
          <legend>卡片用途（可多选）</legend>
          {visibleRoles.length > 0 ? (
            <div className="research-role-options">
              {visibleRoles.map((role) => (
                <label key={role.id} className={role.isArchived ? 'archived' : ''}>
                  <input
                    type="checkbox"
                    checked={selectedRoleIds.has(role.id)}
                    onChange={() => toggleRole(role.id)}
                  />
                  <i style={{ backgroundColor: role.color }} />
                  <span>{role.name}</span>
                  {role.isArchived ? <small>已归档</small> : null}
                </label>
              ))}
            </div>
          ) : (
            <p className="field-hint">尚未建立可用的卡片用途；可以稍后在二次整理中设置。</p>
          )}
        </fieldset>
        <details className="card-source-details">
          <summary>原始文字、上下文与来源信息</summary>
          <div className="original-selection-details">
            <span>未修改的 PDF 选区文字</span>
            <blockquote className="dialog-quote compact">{card.rawText}</blockquote>
          </div>
          <div className="source-context">
            <div>
              <span>前文</span>
              <p>{card.contextBefore || '暂无上下文'}</p>
            </div>
            <div>
              <span>后文</span>
              <p>{card.contextAfter || '暂无上下文'}</p>
            </div>
          </div>
          <p className="field-hint">
            来源：{card.documentTitle} · PDF 第 {card.pdfPage ?? '—'} 页 · 原文定位已保存
          </p>
        </details>
        <section className="card-outline-usages">
          <h3>提纲使用位置</h3>
          {outlineUsages.length > 0 ? (
            <ul>
              {outlineUsages.map((usage) => (
                <li key={usage.linkId}>
                  <strong>{usage.nodeTitle}</strong>
                  <span>{usage.note || '尚未填写章节内使用说明'}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p>这张卡片尚未关联到写作提纲。</p>
          )}
        </section>
        <div className="modal-actions">
          {onOpenSource ? (
            <button
              className="button secondary source-dialog-action"
              type="button"
              disabled={hasUnsavedChanges}
              title={hasUnsavedChanges ? '请先保存或放弃当前修改，再打开 PDF 原文。' : undefined}
              onClick={onOpenSource}
            >
              查看 PDF 原文
            </button>
          ) : null}
          <button className="button ghost" type="button" data-modal-close>
            取消
          </button>
          <button className="button primary" type="submit">
            保存修改
          </button>
        </div>
      </form>
    </Modal>
  )
}
