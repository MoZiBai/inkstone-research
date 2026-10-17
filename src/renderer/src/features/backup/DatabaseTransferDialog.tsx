import { useState } from 'react'
import { AlertTriangle, Download, Upload, DatabaseBackup, ShieldCheck, RefreshCw, FolderOpen, LoaderCircle, HardDrive, Trash2 } from 'lucide-react'
import type { BackupManagerState, BackupRecord, BackupRuntimeStatus } from '@shared/types'
import { Modal } from '../../components/Modal'
import { formatBytes, formatDateTime, fileName, backupKindLabel } from '../../lib/formatting'

interface DatabaseTransferDialogProps {
  busy: boolean
  managerBusy: boolean
  manager: BackupManagerState | null
  runtime: BackupRuntimeStatus | null
  onImportBackup: (backup: BackupRecord) => void
  managerError: string | null
  onExport: () => void
  onMerge: () => void
  onImportProject: () => void
  onRefresh: () => void
  onChooseDirectory: () => void
  onResetDirectory: () => void
  onUpdateRetention: (retentionDays: number | null, retentionCount: number | null) => void
  onUpdateInterval: (automaticIntervalMinutes: number) => void
  onCreateSnapshot: () => void
  onCleanup: () => void
  onRevealDirectory: () => void
  onRevealBackup: (backupId: string) => void
  onDeleteBackup: (backup: BackupRecord) => void
  onClose: () => void
}

export function DatabaseTransferDialog({
  busy,
  managerBusy,
  manager,
  runtime,
  onImportBackup,
  managerError,
  onExport,
  onMerge,
  onImportProject,
  onRefresh,
  onChooseDirectory,
  onResetDirectory,
  onUpdateRetention,
  onUpdateInterval,
  onCreateSnapshot,
  onCleanup,
  onRevealDirectory,
  onRevealBackup,
  onDeleteBackup,
  onClose
}: DatabaseTransferDialogProps): React.JSX.Element {
  const retentionDays = manager?.settings.retentionDays ?? null
  const retentionCount = manager?.settings.retentionCount ?? null
  const automaticIntervalMinutes = manager?.settings.automaticIntervalMinutes ?? 120
  const retentionValue = retentionCount !== null
    ? `count:${retentionCount}`
    : retentionDays !== null
      ? `days:${retentionDays}`
      : 'never'

  const [recordLimit, setRecordLimit] = useState(30)
  const allBusy = busy || managerBusy || Boolean(runtime?.running)
  return (
    <Modal
      title="备份与导入"
      subtitle="备份保存阅读记录，不包含 PDF 文件。导入可补回缺失内容，但不会把现有修改回退到旧版本。"
      onClose={onClose}
      width="large"
    >
      <details className="backup-transfer-extra">
        <summary>导出到其他位置 / 导入已有备份</summary>
        <div className="database-transfer-options">
          <button type="button" disabled={allBusy} onClick={onExport}>
            <span className="database-transfer-icon"><Download size={20} /></span>
            <span><strong>导出全部记录</strong><small>自行选择保存位置；不受自动清理规则影响，不含 PDF 文件。</small></span>
          </button>
          <button type="button" disabled={allBusy} onClick={onImportProject}>
            <span className="database-transfer-icon"><Upload size={20} /></span>
            <span><strong>导入单个项目</strong><small>添加项目备份中的记录，不移除现有项目。</small></span>
          </button>
          <button className="database-merge-option" type="button" disabled={allBusy} onClick={onMerge}>
            <span className="database-transfer-icon"><DatabaseBackup size={20} /></span>
            <span><strong>导入完整备份</strong><small>补入缺少的记录；相同记录不重复，内容不同则保留当前版本。</small></span>
          </button>
        </div>
        <div className="database-transfer-note"><ShieldCheck size={16} /><span>换电脑时请另外保存 PDF 文件；导入记录后可重新链接 PDF。</span></div>
      </details>
      <section className="backup-manager-section">
        <header className="backup-manager-heading">
          <div>
            <h3>备份全部记录</h3>
            <p>周期从每次启动软件后开始计算；隐藏到后台仍继续，完全退出后停止。</p>
          </div>
          <button className="icon-button" type="button" disabled={managerBusy} onClick={onRefresh} aria-label="刷新备份列表">
            <RefreshCw className={managerBusy ? 'spin' : undefined} size={16} />
          </button>
        </header>

        {managerError ? (
          <div className="backup-manager-warning"><AlertTriangle size={16} /><span>{managerError}</span></div>
        ) : null}

        {manager ? (
          <>
            <div className="backup-control-panel">
              <div className="backup-location-row">
                <div className="backup-location-copy">
                  <span className="backup-setting-label">备份位置</span>
                  <code title={manager.settings.effectiveDirectory}>{manager.settings.effectiveDirectory}</code>
                </div>
                <div className="backup-setting-actions">
                  <button className="button ghost compact" type="button" disabled={allBusy} onClick={onRevealDirectory}>
                    <FolderOpen size={14} /> 打开
                  </button>
                  <button className="button ghost compact" type="button" disabled={allBusy} onClick={onChooseDirectory}>
                    更换
                  </button>
                  {manager.settings.customDirectory ? (
                    <button className="button ghost compact" type="button" disabled={allBusy} onClick={onResetDirectory}>
                      恢复默认
                    </button>
                  ) : null}
                  <button className="button primary compact backup-now-button" type="button" disabled={allBusy} onClick={onCreateSnapshot}>
                    {managerBusy ? <LoaderCircle className="spin" size={14} /> : <DatabaseBackup size={14} />} 立即备份
                  </button>
                </div>
              </div>

              {manager.settings.directoryWarning ? (
                <p className="backup-manager-warning"><AlertTriangle size={14} /><span>{manager.settings.directoryWarning}</span></p>
              ) : null}

              <div className="backup-runtime-status" role="status">
                <strong>{runtime?.running ? '正在备份，请稍候…' : runtime?.lastError ? '上次自动备份未完成' : '备份状态'}</strong>
                <span>{runtime?.running ? '完成后更新下次备份时间' : automaticIntervalMinutes === 0 ? '自动备份已关闭' : runtime?.nextBackupAt ? `下次自动备份：${formatDateTime(runtime.nextBackupAt)}` : '正在读取下次备份时间…'}</span>
                {runtime?.lastError ? <p role="alert">{runtime.lastError}</p> : null}
              </div>
              <div className="backup-policy-row">
                <label>
                  <span>周期</span>
                  <select
                    value={String(automaticIntervalMinutes)}
                    disabled={allBusy}
                    onChange={(event) => onUpdateInterval(Number(event.target.value))}
                  >
                    <option value="0">关闭周期备份</option>
                    <option value="30">每 30 分钟</option>
                    <option value="60">每 1 小时</option>
                    <option value="120">每 2 小时（默认）</option>
                    <option value="360">每 6 小时</option>
                    <option value="720">每 12 小时</option>
                    <option value="1440">每 24 小时</option>
                  </select>
                </label>
                <label>
                  <span>保留</span>
                  <select
                    value={retentionValue}
                    disabled={allBusy}
                    onChange={(event) => {
                      const [mode, amount] = event.target.value.split(':')
                      onUpdateRetention(
                        mode === 'days' ? Number(amount) : null,
                        mode === 'count' ? Number(amount) : null
                      )
                    }}
                  >
                    <option value="never">不自动清理</option>
                    <option value="count:5">保留最近 5 份</option>
                    <option value="count:12">保留最近 12 份</option>
                    <option value="count:30">保留最近 30 份</option>
                    <option value="days:7">保留最近 7 天</option>
                    <option value="days:30">保留最近 30 天</option>
                    <option value="days:90">保留最近 90 天</option>
                  </select>
                </label>
                <button
                  className="button ghost compact"
                  type="button"
                  disabled={allBusy || retentionValue === 'never'}
                  onClick={onCleanup}
                >
                  清理旧备份
                </button>
              </div>

              <p className="field-hint">保留规则适用于周期备份、主动备份和导入前安全备份；单独导出的文件不自动清理。</p>
              <div className="backup-status-line">
                <span>
                  {manager.settings.lastAutomaticBackupAt
                    ? `最近成功备份：${formatDateTime(manager.settings.lastAutomaticBackupAt)}`
                    : automaticIntervalMinutes === 0
                      ? '周期备份已关闭，可随时主动备份'
                      : '尚未完成备份'}
                </span>
                {manager.settings.lastCleanupAt ? (
                  <span title={manager.settings.lastCleanupResult ?? undefined}>
                    最近清理：{formatDateTime(manager.settings.lastCleanupAt)}
                  </span>
                ) : null}
              </div>
            </div>

            <div className="backup-records-heading">
              <div>
                <h4>备份记录</h4>
                <span>{manager.records.filter((record) => record.isAvailable).length} 份文件存在 · {manager.records.filter((record) => !record.isAvailable).length} 份文件缺失 · 共 {formatBytes(manager.totalSizeBytes)}</span>
              </div>
            </div>
            <div className="backup-records-list">
              {manager.records.length === 0 ? (
                <div className="backup-empty"><HardDrive size={20} /><span>尚无已登记备份。点击“立即备份”创建第一份。</span></div>
              ) : manager.records.slice(0, recordLimit).map((record) => (
                <article className={`backup-record ${record.isAvailable ? '' : 'unavailable'}`} key={record.id}>
                  <span className={`backup-kind backup-kind-${record.kind}`}>{backupKindLabel(record)}</span>
                  <div className="backup-record-copy">
                    <strong title={record.path}>{fileName(record.path)}</strong>
                    <small>{formatDateTime(record.createdAt)} · {formatBytes(record.sizeBytes)}</small>
                  <details className="backup-file-location"><summary>文件位置</summary><code>{record.path}</code></details>
                    {!record.isAvailable ? <em>文件已不在登记位置</em> : null}
                  </div>
                  <div className="backup-record-actions">
                    <button className="button secondary compact" type="button" disabled={!record.isAvailable || allBusy} onClick={() => onImportBackup(record)}>导入此备份</button>
                    <button className="button ghost compact" type="button" disabled={!record.isAvailable || allBusy} onClick={() => onRevealBackup(record.id)}>
                      <FolderOpen size={13} /> 定位
                    </button>
                    {record.kind === 'auto' ? (
                      <button className="button danger compact" type="button" disabled={allBusy} onClick={() => onDeleteBackup(record)}>
                        <Trash2 size={13} /> 删除
                      </button>
                    ) : null}
                  </div>
                </article>
              ))}
            </div>
            {recordLimit < manager.records.length ? <button className="button ghost" type="button" onClick={() => setRecordLimit((count) => count + 30)}>再显示 30 份备份</button> : null}
          </>
        ) : managerBusy ? (
          <div className="backup-empty"><LoaderCircle className="spin" size={18} /><span>正在读取备份记录…</span></div>
        ) : null}
      </section>
    </Modal>
  )
}
