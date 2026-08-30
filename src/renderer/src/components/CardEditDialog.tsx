import { useEffect, useState } from 'react'
import type { CardRole, ProjectCardView, UpdateCardInput } from '@shared/types'
import { Modal } from './Modal'

interface CardEditDialogProps {
  card: ProjectCardView
  onSave: (input: UpdateCardInput) => Promise<void>
  onClose: () => void
  onOpenSource?: () => void
}

const roleOptions: Array<{ value: CardRole; label: string }> = [
  { value: 'unset', label: '暂未判断' },
  { value: 'support', label: '支持' },
  { value: 'oppose', label: '反对' },
  { value: 'qualify', label: '限定' },
  { value: 'background', label: '背景' }
]

export function CardEditDialog({
  card,
  onSave,
  onClose,
  onOpenSource
}: CardEditDialogProps): React.JSX.Element {
  const [comment, setComment] = useState(card.comment)
  const [role, setRole] = useState<CardRole>(card.role)
  const [tags, setTags] = useState(card.tags.join('、'))

  useEffect(() => {
    setComment(card.comment)
    setRole(card.role)
    setTags(card.tags.join('、'))
  }, [card])

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    await onSave({
      cardId: card.id,
      comment,
      role,
      tags: tags
        .split(/[、,，]/)
        .map((tag) => tag.trim())
        .filter(Boolean)
    })
  }

  return (
    <Modal
      title="编辑研究卡片"
      subtitle={`${card.documentAuthors || '未知作者'} · ${card.documentTitle}`}
      onClose={onClose}
      width="large"
    >
      <form onSubmit={submit}>
        <blockquote className="dialog-quote">{card.cleanText}</blockquote>
        <div className="form-grid two-columns">
          <label className="field">
            <span>研究作用</span>
            <select value={role} onChange={(event) => setRole(event.target.value as CardRole)}>
              {roleOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>标签（使用顿号或逗号分隔）</span>
            <input value={tags} onChange={(event) => setTags(event.target.value)} />
          </label>
        </div>
        <label className="field">
          <span>我的评论</span>
          <textarea
            rows={5}
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            placeholder="记录这段材料为什么重要、如何使用或有哪些疑问……"
          />
        </label>
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
