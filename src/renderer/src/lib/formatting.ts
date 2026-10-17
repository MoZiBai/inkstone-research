import type { BackupRecord } from '@shared/types'

export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

export function formatBytes(value: number): string {
  const size = Math.max(0, value)
  if (size < 1024) return `${size} B`
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`
  if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(size < 10 * 1024 ** 2 ? 1 : 0)} MB`
  return `${(size / 1024 ** 3).toFixed(2)} GB`
}

export function formatDateTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date)
}

export function backupKindLabel(record: BackupRecord): string {
  if (record.kind === 'auto') {
    const name = fileName(record.path)
    if (name.includes('before-manual')) return '主动备份'
    if (name.includes('before-scheduled')) return '周期备份'
    if (name.includes('before-project-import') || name.includes('before-import')) return '导入前备份'
    return '安全备份'
  }
  if (record.kind === 'project') return '单项目导出'
  return '完整数据库导出'
}
