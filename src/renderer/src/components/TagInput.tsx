import { X } from 'lucide-react'
import { completeTag, parseTags, suggestTags } from '../lib/tags'

export function TagInput({ value, onChange, suggestions = [] }: {
  value: string
  onChange: (value: string) => void
  suggestions?: string[]
}): React.JSX.Element {
  const tags = parseTags(value)
  const matches = suggestTags(value, suggestions)
  return <div className="tag-input">
    {tags.length > 0 ? <div className="tag-input-chips">{tags.map((tag) =>
      <button type="button" key={tag} onClick={() => onChange(tags.filter((item) => item !== tag).join('、'))} aria-label={`移除标签：${tag}`}>
        {tag}<X size={12} />
      </button>
    )}</div> : null}
    <input value={value} onChange={(event) => onChange(event.target.value)} placeholder="输入标签，用顿号或逗号分隔" aria-label="卡片标签" />
    {matches.length > 0 ? <div className="tag-suggestion-list" aria-label="已有标签建议">{matches.map((tag) =>
      <button type="button" key={tag} onClick={() => onChange(completeTag(value, tag))}>{tag}</button>
    )}</div> : null}
  </div>
}
