import {
  BookOpen,
  Boxes,
  Database,
  DatabaseBackup,
  Download,
  FileStack,
  FolderKanban,
  Library,
  LoaderCircle,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  ScrollText,
  ShieldCheck,
  Sparkles,
  Upload
} from 'lucide-react'
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DatabaseImportResult, WorkspaceSnapshot } from '@shared/types'
import { ConfirmDialog, Modal } from './components/Modal'
import { LibraryView } from './features/library/LibraryView'
import { OutlineView } from './features/outline/OutlineView'
import { ReadingView, type ReadingFocusRequest } from './features/reading/ReadingView'
import { parsePdfLocator } from './features/reading/pdfLocator'
import { SynthesisView } from './features/synthesis/SynthesisView'
import { api } from './lib/api'
import type { RunMutation } from './types'

type ViewId = 'reading' | 'library' | 'synthesis' | 'outline'

const SIDEBAR_STORAGE_KEY = 'inkstone:project-sidebar-collapsed:v1'

const tabs: Array<{
  id: ViewId
  label: string
  icon: typeof BookOpen
}> = [
  { id: 'reading', label: '阅读台', icon: BookOpen },
  { id: 'library', label: '卡片库', icon: Library },
  { id: 'synthesis', label: '二次整理', icon: Boxes },
  { id: 'outline', label: '论文提纲', icon: ScrollText }
]

export default function App(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null)
  const [activeView, setActiveView] = useState<ViewId>('reading')
  const [initialLoading, setInitialLoading] = useState(true)
  const [mutating, setMutating] = useState(false)
  const [fatalError, setFatalError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [showProjectDialog, setShowProjectDialog] = useState(false)
  const [showDatabaseDialog, setShowDatabaseDialog] = useState(false)
  const [databaseBusy, setDatabaseBusy] = useState(false)
  const [pendingDatabaseImport, setPendingDatabaseImport] = useState<string | null>(null)
  const [databaseImportResult, setDatabaseImportResult] = useState<DatabaseImportResult | null>(null)
  const [focusCardId, setFocusCardId] = useState<string | null>(null)
  const [synthesisMode, setSynthesisMode] = useState<'active' | 'excluded'>('active')
  const [readingRequest, setReadingRequest] = useState<ReadingFocusRequest | null>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(loadSidebarCollapsed)

  const notify = useCallback((message: string): void => {
    setToast(message)
    window.setTimeout(() => {
      setToast((current) => (current === message ? null : current))
    }, 3200)
  }, [])

  const loadWorkspace = useCallback(async (projectId?: string): Promise<void> => {
    try {
      const next = await api.getWorkspace(projectId)
      setSnapshot(next)
      setFatalError(null)
    } catch (error) {
      setFatalError(normalizeError(error))
    } finally {
      setInitialLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadWorkspace()
  }, [loadWorkspace])

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_STORAGE_KEY, sidebarCollapsed ? 'true' : 'false')
    } catch {
      // The layout remains usable when browser storage is unavailable.
    }
  }, [sidebarCollapsed])

  const runMutation: RunMutation = useCallback(
    async (action, successMessage, projectId) => {
      if (mutating) return false
      setMutating(true)
      try {
        await action()
        await loadWorkspace(projectId ?? snapshot?.currentProjectId ?? undefined)
        notify(successMessage)
        return true
      } catch (error) {
        notify(normalizeError(error))
        return false
      } finally {
        setMutating(false)
      }
    },
    [loadWorkspace, mutating, notify, snapshot?.currentProjectId]
  )

  const currentProject = useMemo(
    () => snapshot?.projects.find((project) => project.id === snapshot.currentProjectId) ?? null,
    [snapshot]
  )

  const switchProject = async (projectId: string): Promise<void> => {
    if (projectId === snapshot?.currentProjectId || mutating) return
    setMutating(true)
    setReadingRequest(null)
    await loadWorkspace(projectId)
    setMutating(false)
  }

  const locateSynthesis = (cardId: string, excluded: boolean): void => {
    setFocusCardId(cardId)
    setSynthesisMode(excluded ? 'excluded' : 'active')
    setActiveView('synthesis')
  }

  const openSource = (documentId: string, page: number | null, locatorJson: string): void => {
    const token = Date.now() + Math.floor(Math.random() * 1000)
    const locator = page ? parsePdfLocator(locatorJson, page) : null
    setReadingRequest({ token, documentId, page, locator })
    setActiveView('reading')
  }

  const exportDatabase = async (): Promise<void> => {
    try {
      const destination = await saveDialog({
        title: '导出砚台数据库备份',
        defaultPath: databaseBackupFileName(),
        filters: [{ name: '砚台数据库备份', extensions: ['db'] }]
      })
      if (typeof destination !== 'string') return
      setDatabaseBusy(true)
      await api.exportDatabase(destination)
      notify('完整数据库备份已导出。')
    } catch (error) {
      notify(normalizeError(error))
    } finally {
      setDatabaseBusy(false)
    }
  }

  const chooseDatabaseImport = async (): Promise<void> => {
    try {
      const source = await openDialog({
        title: '选择砚台数据库备份',
        multiple: false,
        directory: false,
        filters: [{ name: '砚台数据库备份', extensions: ['db'] }]
      })
      if (typeof source === 'string') setPendingDatabaseImport(source)
    } catch (error) {
      notify(normalizeError(error))
    }
  }

  const importDatabase = async (): Promise<void> => {
    if (!pendingDatabaseImport) return
    const resultHolder: { value: DatabaseImportResult | null } = { value: null }
    setDatabaseBusy(true)
    const succeeded = await runMutation(
      async () => {
        resultHolder.value = await api.importDatabase(pendingDatabaseImport)
      },
      '数据库备份已导入，项目状态已重新载入。'
    )
    setDatabaseBusy(false)
    if (succeeded && resultHolder.value) {
      setDatabaseImportResult(resultHolder.value)
      setPendingDatabaseImport(null)
      setShowDatabaseDialog(false)
      setReadingRequest(null)
      setFocusCardId(null)
    }
  }

  if (initialLoading) {
    return (
      <div className="app-loading">
        <span className="brand-seal">砚</span>
        <LoaderCircle className="spin" size={20} />
        <p>正在打开本地资料库……</p>
      </div>
    )
  }

  if (!snapshot || fatalError) {
    return (
      <div className="app-loading error-screen">
        <span className="brand-seal">砚</span>
        <h1>本地资料库未能打开</h1>
        <p>{fatalError ?? '未知错误'}</p>
        <button className="button primary" type="button" onClick={() => void loadWorkspace()}>
          重试
        </button>
      </div>
    )
  }

  return (
    <div className={`app-shell ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
      <aside className="sidebar">
        <header className="brand">
          <span className="brand-seal">砚</span>
          <span className="brand-copy">
            <strong>砚台</strong>
            <small>RESEARCH DESK</small>
          </span>
        </header>

        <button
          className="sidebar-collapse-button"
          type="button"
          aria-label={sidebarCollapsed ? '展开项目栏' : '收起项目栏'}
          title={sidebarCollapsed ? '展开项目栏' : '收起项目栏'}
          onClick={() => setSidebarCollapsed((current) => !current)}
        >
          {sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
        </button>

        <div className="sidebar-section-heading">
          <span>我的项目</span>
          <button
            className="icon-button subtle"
            type="button"
            onClick={() => setShowProjectDialog(true)}
            aria-label="新建项目"
          >
            <Plus size={15} />
          </button>
        </div>

        <nav className="project-navigation" aria-label="研究项目">
          {snapshot.projects.map((project) => (
            <button
              className={`project-navigation-item ${
                project.id === snapshot.currentProjectId ? 'active' : ''
              }`}
              key={project.id}
              type="button"
              title={sidebarCollapsed ? project.name : undefined}
              onClick={() => void switchProject(project.id)}
              style={{ '--project-color': project.color } as React.CSSProperties}
            >
              <span className="project-icon">
                <FolderKanban size={16} />
              </span>
              <span className="project-navigation-copy">
                <strong>{project.name}</strong>
                <small>
                  {project.documentCount} 篇文献 · {project.cardCount} 张卡片
                </small>
              </span>
            </button>
          ))}
        </nav>

        <footer className="sidebar-footer">
          <div className="local-database-status" title={mutating ? '本地 SQLite：正在保存更改' : '本地 SQLite：已连接并自动持久化'}>
            <Database size={15} />
            <span>
              <strong>本地 SQLite</strong>
              <small>{mutating ? '正在保存更改…' : '已连接 · 自动持久化'}</small>
            </span>
            <i className={mutating ? 'saving' : ''} />
          </div>
          <p>数据保存在本机应用目录；PDF 原件不会被修改。</p>
        </footer>
      </aside>

      <main className="main-shell">
        <header className="topbar">
          <div className="project-heading">
            <span className="project-color" style={{ backgroundColor: currentProject?.color }} />
            <div>
              <h1>{currentProject?.name ?? '新研究项目'}</h1>
              <p>{currentProject?.description || '从阅读材料开始建立可追溯的论文证据。'}</p>
            </div>
          </div>
          <div className="topbar-tools">
            <button
              className="topbar-database-button"
              type="button"
              onClick={() => setShowDatabaseDialog(true)}
            >
              <DatabaseBackup size={14} /> 备份与恢复
            </button>
            <span className="local-badge">
              <Sparkles size={14} /> 本地优先
            </span>
          </div>
        </header>

        <nav className="view-tabs" aria-label="项目视图">
          {tabs.map((tab) => {
            const Icon = tab.icon
            const count =
              tab.id === 'library'
                ? snapshot.cards.length
                : tab.id === 'synthesis'
                  ? snapshot.cards.filter((card) => card.synthesisState === 'active').length
                  : tab.id === 'outline'
                    ? snapshot.outlineNodes.length
                    : snapshot.documents.filter((document) => !document.isRemoved).length
            return (
              <button
                className={activeView === tab.id ? 'active' : ''}
                key={tab.id}
                type="button"
                onClick={() => setActiveView(tab.id)}
              >
                <Icon size={15} />
                <span>{tab.label}</span>
                <small>{count}</small>
              </button>
            )
          })}
        </nav>

        <section className="view-container">
          {activeView === 'reading' ? (
            <ReadingView
              snapshot={snapshot}
              runMutation={runMutation}
              notify={notify}
              initialRequest={readingRequest}
              onFocusHandled={() => setReadingRequest(null)}
            />
          ) : null}
          {activeView === 'library' ? (
            <LibraryView
              snapshot={snapshot}
              runMutation={runMutation}
              onLocateSynthesis={locateSynthesis}
              onOpenSource={openSource}
            />
          ) : null}
          {activeView === 'synthesis' ? (
            <SynthesisView
              snapshot={snapshot}
              runMutation={runMutation}
              focusCardId={focusCardId}
              initialMode={synthesisMode}
              onFocusHandled={() => setFocusCardId(null)}
              onOpenSource={openSource}
            />
          ) : null}
          {activeView === 'outline' ? (
            <OutlineView snapshot={snapshot} runMutation={runMutation} onOpenSource={openSource} />
          ) : null}
        </section>
      </main>

      {showProjectDialog ? (
        <ProjectDialog
          onCreate={async (name, description, color) => {
            let newProjectId: string | null = null
            const succeeded = await runMutation(
              async () => {
                newProjectId = await api.createProject({ name, description, color })
              },
              '新研究项目已创建。'
            )
            if (succeeded && newProjectId) {
              await loadWorkspace(newProjectId)
              setShowProjectDialog(false)
              setActiveView('reading')
            }
          }}
          onClose={() => setShowProjectDialog(false)}
        />
      ) : null}

      {showDatabaseDialog ? (
        <DatabaseTransferDialog
          busy={databaseBusy || mutating}
          onExport={() => void exportDatabase()}
          onImport={() => void chooseDatabaseImport()}
          onClose={() => setShowDatabaseDialog(false)}
        />
      ) : null}

      {pendingDatabaseImport ? (
        <ConfirmDialog
          title="导入并替换当前数据库？"
          description={`即将导入“${fileName(pendingDatabaseImport)}”。砚台会先自动备份当前数据库；导入文件不会包含 PDF，缺失文献可在阅读台重新链接。`}
          confirmLabel={databaseBusy ? '正在导入…' : '确认导入'}
          onConfirm={() => {
            if (!databaseBusy) void importDatabase()
          }}
          onCancel={() => setPendingDatabaseImport(null)}
        />
      ) : null}

      {databaseImportResult ? (
        <DatabaseImportResultDialog
          result={databaseImportResult}
          onClose={() => setDatabaseImportResult(null)}
        />
      ) : null}

      <div className={`toast ${toast ? 'show' : ''}`} role="status">
        <span className="toast-mark">✓</span>
        <span>{toast}</span>
      </div>
      {mutating ? <div className="mutation-line" /> : null}
    </div>
  )
}

interface DatabaseTransferDialogProps {
  busy: boolean
  onExport: () => void
  onImport: () => void
  onClose: () => void
}

function DatabaseTransferDialog({
  busy,
  onExport,
  onImport,
  onClose
}: DatabaseTransferDialogProps): React.JSX.Element {
  return (
    <Modal
      title="数据库备份与恢复"
      subtitle="备份包含全部研究数据；PDF 管理副本不打包，可在恢复后重新链接。"
      onClose={onClose}
      width="large"
    >
      <div className="database-transfer-options">
        <button type="button" disabled={busy} onClick={onExport}>
          <span className="database-transfer-icon"><Download size={20} /></span>
          <span>
            <strong>导出完整数据库</strong>
            <small>保存项目、卡片、标注、阅读笔记、二次整理和论文提纲。</small>
          </span>
        </button>
        <button type="button" disabled={busy} onClick={onImport}>
          <span className="database-transfer-icon"><Upload size={20} /></span>
          <span>
            <strong>导入数据库备份</strong>
            <small>验证备份后替换当前资料库，并先自动保存当前数据库。</small>
          </span>
        </button>
      </div>
      <div className="database-transfer-note">
        <ShieldCheck size={16} />
        <span>导出使用 SQLite 一致性快照；导入前会检查文件完整性与数据关联。</span>
      </div>
    </Modal>
  )
}

function DatabaseImportResultDialog({
  result,
  onClose
}: {
  result: DatabaseImportResult
  onClose: () => void
}): React.JSX.Element {
  return (
    <Modal title="数据库恢复完成" onClose={onClose} width="medium">
      <div className="database-import-result">
        <ShieldCheck size={28} />
        <p>卡片、标注、阅读笔记、二次整理和提纲结构已从备份恢复。</p>
        <dl>
          <div>
            <dt>缺失 PDF</dt>
            <dd>{result.missingPdfCount} 篇</dd>
          </div>
          <div>
            <dt>导入前自动备份</dt>
            <dd title={result.safetyBackupPath}>{result.safetyBackupPath}</dd>
          </div>
        </dl>
        {result.missingPdfCount > 0 ? (
          <p className="database-import-warning">请在阅读台选择缺失文献，并使用“重新链接 PDF”。</p>
        ) : null}
      </div>
      <div className="modal-actions">
        <button className="button primary" type="button" onClick={onClose}>知道了</button>
      </div>
    </Modal>
  )
}

interface ProjectDialogProps {
  onCreate: (name: string, description: string, color: string) => Promise<void>
  onClose: () => void
}

function ProjectDialog({ onCreate, onClose }: ProjectDialogProps): React.JSX.Element {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [color, setColor] = useState('#a05d43')

  return (
    <Modal
      title="新建研究项目"
      subtitle="项目可以是一篇论文、一个章节或其他研究任务，不预设类型。"
      onClose={onClose}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void onCreate(name, description, color)
        }}
      >
        <label className="field">
          <span>项目名称</span>
          <input
            autoFocus
            required
            maxLength={160}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="例如：墓葬空间与社会结构"
          />
        </label>
        <label className="field">
          <span>项目说明</span>
          <textarea
            rows={4}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="记录研究问题或当前工作范围（可选）"
          />
        </label>
        <label className="field color-field">
          <span>项目标识色</span>
          <input type="color" value={color} onChange={(event) => setColor(event.target.value)} />
          <code>{color}</code>
        </label>
        <div className="modal-actions">
          <button className="button ghost" type="button" onClick={onClose}>
            取消
          </button>
          <button className="button primary" type="submit">
            <FileStack size={15} /> 创建项目
          </button>
        </div>
      </form>
    </Modal>
  )
}

function normalizeError(error: unknown): string {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  try {
    return JSON.stringify(error)
  } catch {
    return '发生未知错误。'
  }
}

function loadSidebarCollapsed(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

function databaseBackupFileName(): string {
  const date = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `砚台数据库备份-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}.db`
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}
