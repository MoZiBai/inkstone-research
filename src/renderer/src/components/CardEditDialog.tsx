import { useEffect, useMemo, useState } from 'react'
import type { ProjectCardView, ResearchRole, UpdateCardInput } from '@shared/types'
import { Modal } from './Modal'

interface CardEditDialogProps {
  card: ProjectCardView
  researchRoles: ResearchRole[]
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
  outlineUsages = [],
  onSave,
  onClose,
  onOpenSource
}: CardEditDialogProps): React.JSX.Element {
  const [displayText, setDisplayText] = useState(card.displayText)
  const [printPage, setPrintPage] = useState(card.printPage ?? '')
  const [comment, setComment] = useState(card.comment)
  const [selectedRoleIds, setSelectedRoleIds] = useState<Set<string>>(
    () => new Set(card.researchRoles.map((role) => role.id))
  )
  const [tags, setTags] = useState(card.tags.join('、'))

  useEffect(() => {
    setDisplayText(card.displayText)
    setPrintPage(card.printPage ?? '')
    setComment(card.comment)
    setSelectedRoleIds(new Set(card.researchRoles.map((role) => role.id)))
    setTags(card.tags.join('、'))
  }, [card])

  const visibleRoles = useMemo(
    () => researchRoles.filter((role) => !role.isArchived || selectedRoleIds.has(role.id)),
    [researchRoles, selectedRoleIds]
  )

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    await onSave({
      cardId: card.id,
      displayText,
      printPage,
      comment,
      researchRoleIds: Array.from(selectedRoleIds),
      tags: tags
        .split(/[、,，]/)
        .map((tag) => tag.trim())
        .filter(Boolean)
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
      title="研究卡片详情"
      subtitle={`${card.documentAuthors || '未知作者'} · ${card.documentTitle}`}
      onClose={onClose}
      width="large"
    >
      <form onSubmit={submit}>
        <div className="card-detail-origin-row">
          <span className={`soft-pill origin-${card.originKind}`}>{originLabels[card.originKind]}</span>
          <span>PDF 第 {card.pdfPage ?? '—'} 页</span>
        </div>
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
            <input value={tags} onChange={(event) => setTags(event.target.value)} />
          </label>
          <label className="field">
            <span>印刷页码（可选）</span>
            <input
              value={printPage}
              onChange={(event) => setPrintPage(event.target.value)}
              placeholder="例如 103"
            />
          </label>
        </div>
        <fieldset className="research-role-picker">
          <legend>研究作用（可多选）</legend>
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
            <p className="field-hint">尚未建立可用的研究作用；可以稍后在二次整理中设置。</p>
          )}
        </fieldset>
        <label className="field">
          <span>即时笔记</span>
          <textarea
            rows={5}
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            placeholder="记录这段材料为什么重要、如何使用或有哪些疑问……"
          />
        </label>
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
            <p>这张卡片尚未关联到论文提纲。</p>
          )}
        </section>
        <div className="modal-actions">
          {onOpenSource ? (
            <button className="button secondary source-dialog-action" type="button" onClick={onOpenSource}>
              查看 PDF 原文
            </button>
          ) : null}
          <button className="button ghost" type="button" onClick={onClose}>
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
