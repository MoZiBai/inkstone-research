import { X } from 'lucide-react'
import { completeTag, joinTagDraft, parseTags, splitTagDraft, suggestTags } from '../lib/tags'

export function TagInput({ value, onChange, suggestions = [] }: {
  value: string
  onChange: (value: string) => void
  suggestions?: string[]
}): React.JSX.Element {
  const { committed, draft } = splitTagDraft(value)
  const matches = suggestTags(value, suggestions)
  return <div className="tag-input" onBlur={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget)) onChange(joinTagDraft(parseTags(value)))
  }}>
    <div className="tag-input-editor">
    {committed.map((tag) =>
      <button className="tag-input-chip" type="button" key={tag} onClick={() => onChange(joinTagDraft(committed.filter((item) => item !== tag), draft))} aria-label={`移除标签：${tag}`}>
        {tag}<X size={12} />
      </button>
    )}
    <input value={draft} onChange={(event) => onChange(joinTagDraft(committed, event.target.value))} placeholder={committed.length ? '添加标签…' : '输入标签，回车添加'} aria-label="卡片标签" onKeyDown={(event) => {
      if (event.nativeEvent.isComposing || event.keyCode === 229) return
      if (event.key === 'Enter') {
        event.preventDefault()
        onChange(joinTagDraft(parseTags(value)))
      } else if (event.key === 'Backspace' && !draft && committed.length) {
        event.preventDefault()
        onChange(joinTagDraft(committed.slice(0, -1)))
      }
    }} />
    </div>
    {matches.length > 0 ? <div className="tag-suggestion-list" aria-label="已有标签建议">{matches.map((tag) =>
      <button type="button" key={tag} onMouseDown={(event) => event.preventDefault()} onClick={() => onChange(completeTag(value, tag))}>{tag}</button>
    )}</div> : null}
  </div>
}
