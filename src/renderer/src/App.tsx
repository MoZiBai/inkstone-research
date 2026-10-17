import {
  AlertTriangle,
  BookOpen,
  Boxes,
  CheckCircle2,
  ChevronDown,
  Database,
  DatabaseBackup,
  Download,
  FileStack,
  FolderKanban,
  Library,
  LoaderCircle,
  CircleX,
  ClipboardPaste,
  Copy,
  PanelLeftClose,
  PanelLeftOpen,
  PencilLine,
  Plus,
  Search,
  ScrollText,
  Scissors,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  Type,
  TextSelect
} from 'lucide-react'
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog'
import { listen } from '@tauri-apps/api/event'
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import type {
  BackupManagerState,
  BackupRecord,
  BackupRuntimeStatus,
  DatabaseImportPreview,
  DatabaseImportResult,
  ProjectSummary,
  WorkspaceSnapshot,
  WorkspaceSection
} from '@shared/types'
import { ConfirmDialog, Modal } from './components/Modal'
import { ContextMenu } from './components/ContextMenu'
import { CloseApplicationDialog } from './components/CloseApplicationDialog'
import { CardEditDialog } from './components/CardEditDialog'
import { LibraryView } from './features/library/LibraryView'
import { OutlineView } from './features/outline/OutlineView'
import { ReadingView, type ReadingFocusRequest } from './features/reading/ReadingView'
import { parsePdfLocator } from './features/reading/pdfLocator'
import { SynthesisView } from './features/synthesis/SynthesisView'
import { api } from './lib/api'
import { DatabaseTransferDialog } from './features/backup/DatabaseTransferDialog'
import { formatBytes, formatDateTime, fileName } from './lib/formatting'
import { consumeWorkspaceChanges, mergeWorkspace } from './lib/workspaceRefresh'
import { readPreference, writePreference, usePersistentState } from './lib/preferences'
import {
  filterAndSortProjects,
  searchCurrentProject,
  type ProjectFilter,
  type ProjectSort
} from './lib/workspaceEfficiency'
import type { NoticeKind, RunMutation } from './types'

type ViewId = 'reading' | 'library' | 'synthesis' | 'outline'

const SIDEBAR_STORAGE_KEY = 'inkstone:project-sidebar-collapsed:v1'
const FONT_SIZE_STORAGE_KEY = 'inkstone:font-size:v1'
type FontSize = 'small' | 'standard' | 'large'

const tabs: Array<{
  id: ViewId
  label: string
  icon: typeof BookOpen
}> = [
  { id: 'reading', label: '阅读台', icon: BookOpen },
  { id: 'library', label: '卡片库', icon: Library },
  { id: 'synthesis', label: '二次整理', icon: Boxes },
  { id: 'outline', label: '写作提纲', icon: ScrollText }
]

export default function App(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null)
  const [activeView, setActiveView] = usePersistentState<ViewId>('inkstone:active-view', 'reading')
  const [initialLoading, setInitialLoading] = useState(true)
  const [mutating, setMutating] = useState(false)
  const [fatalError, setFatalError] = useState<string | null>(null)
  const [toast, setToast] = useState<{ message: string; kind: NoticeKind } | null>(null)
  const [projectDialogMode, setProjectDialogMode] = useState<'create' | 'edit' | null>(null)
  const [showProjectActions, setShowProjectActions] = useState(false)
  const [removingProject, setRemovingProject] = useState<ProjectSummary | null>(null)
  const [showDatabaseDialog, setShowDatabaseDialog] = useState(false)
  const [databaseBusy, setDatabaseBusy] = useState(false)
  const [backupManager, setBackupManager] = useState<BackupManagerState | null>(null)
  const [backupRuntime, setBackupRuntime] = useState<BackupRuntimeStatus | null>(null)
  const [backupManagerError, setBackupManagerError] = useState<string | null>(null)
  const [backupManagerBusy, setBackupManagerBusy] = useState(false)
  const [showCloseChoice, setShowCloseChoice] = useState(false)
  const mutationLock = useRef(false)
  const refreshSequence = useRef(0)
  const [deletingBackup, setDeletingBackup] = useState<BackupRecord | null>(null)
  const [pendingDatabaseImport, setPendingDatabaseImport] = useState<{
    path: string
    mode: 'database' | 'project'
    preview: DatabaseImportPreview
  } | null>(null)
  const [databaseImportResult, setDatabaseImportResult] = useState<DatabaseImportResult | null>(null)
  const [focusCardId, setFocusCardId] = useState<string | null>(null)
  const [synthesisMode, setSynthesisMode] = useState<'active' | 'excluded'>('active')
  const [readingRequest, setReadingRequest] = useState<ReadingFocusRequest | null>(null)
  const [readingDocumentId, setReadingDocumentId] = useState<string | null>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(loadSidebarCollapsed)
  const [fontSize, setFontSize] = useState<FontSize>(loadFontSize)
  const [projectQuery, setProjectQuery] = usePersistentState('inkstone:project-query', '')
  const [projectFilter, setProjectFilter] = usePersistentState<ProjectFilter>('inkstone:project-filter', 'all')
  const [projectSort, setProjectSort] = usePersistentState<ProjectSort>('inkstone:project-sort', 'updated')
  const [projectSearchQuery, setProjectSearchQuery] = useState('')
  const [projectSearchFocused, setProjectSearchFocused] = useState(false)
  const [projectSearchLimit, setProjectSearchLimit] = useState(8)
  const [searchCardId, setSearchCardId] = useState<string | null>(null)
  const [appContextMenu, setAppContextMenu] = useState<{
    x: number
    y: number
    editable: HTMLInputElement | HTMLTextAreaElement | null
  } | null>(null)
  const deferredProjectQuery = useDeferredValue(projectQuery)
  const deferredProjectSearchQuery = useDeferredValue(projectSearchQuery)

  const notify = useCallback((message: string, kind: NoticeKind = 'success'): void => {
    const notice = { message, kind }
    setToast(notice)
    window.setTimeout(() => {
      setToast((current) => (current === notice ? null : current))
    }, kind === 'error' ? 6500 : kind === 'warning' ? 5000 : 3200)
  }, [])

  const loadWorkspace = useCallback(async (projectId?: string, sections?: WorkspaceSection[]): Promise<boolean> => {
    const sequence = ++refreshSequence.current
    try {
      const next = await api.getWorkspace(projectId, sections)
      if (sequence !== refreshSequence.current) return false
      setSnapshot((previous) => mergeWorkspace(previous, next, sections))
      if (next.currentProjectId) writePreference('inkstone:last-project', next.currentProjectId)
      setFatalError(null)
      return true
    } catch (error) {
      if (sequence !== refreshSequence.current) return false
      setFatalError(normalizeError(error))
      return false
    } finally {
      if (sequence === refreshSequence.current) setInitialLoading(false)
    }
  }, [])

  const loadBackupManager = useCallback(async (): Promise<void> => {
    setBackupManagerBusy(true)
    try {
      setBackupManager(await api.getBackupManager())
      setBackupManagerError(null)
    } catch (error) {
      setBackupManagerError(normalizeError(error))
    } finally {
      setBackupManagerBusy(false)
    }
  }, [])

  useEffect(() => {
    void loadWorkspace(readPreference('inkstone:last-project', '') || undefined)
  }, [loadWorkspace])

  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined
    void listen('app-close-requested', () => setShowCloseChoice(true)).then((stop) => {
      if (disposed) stop()
      else unlisten = stop
    })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_STORAGE_KEY, sidebarCollapsed ? 'true' : 'false')
    } catch {
      // The layout remains usable when browser storage is unavailable.
    }
  }, [sidebarCollapsed])

  useEffect(() => {
    document.documentElement.dataset.fontSize = fontSize
    try {
      window.localStorage.setItem(FONT_SIZE_STORAGE_KEY, fontSize)
    } catch {
      // The selected size still applies for the current session.
    }
  }, [fontSize])

  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined
    void api.getBackupRuntime().then((status) => { if (!disposed) setBackupRuntime(status) }).catch(() => undefined)
    void listen<BackupRuntimeStatus>('backup-status-changed', ({ payload }) => {
      setBackupRuntime(payload)
      if (payload.lastError) notify(`自动备份未完成：${payload.lastError}`, 'error')
      if (showDatabaseDialog) void loadBackupManager()
    }).then((stop) => { if (disposed) stop(); else unlisten = stop })
    const timer = showDatabaseDialog ? window.setInterval(() => {
      void api.getBackupRuntime().then((status) => { if (!disposed) setBackupRuntime(status) }).catch(() => undefined)
    }, 10000) : undefined
    return () => { disposed = true; unlisten?.(); window.clearInterval(timer) }
  }, [showDatabaseDialog, loadBackupManager, notify])

  const runMutation: RunMutation = useCallback(
    async (action, successMessage, projectId) => {
      if (mutationLock.current) {
        notify('上一项操作正在完成，请稍候。', 'warning')
        return false
      }
      mutationLock.current = true
      setMutating(true)
      try {
        await action()
        const refreshed = await loadWorkspace(projectId ?? snapshot?.currentProjectId ?? undefined, consumeWorkspaceChanges())
        if (refreshed) notify(successMessage)
        else notify('修改已保存，但界面刷新失败。请重试刷新，无需重复提交。', 'warning')
        return true
      } catch (error) {
        notify(normalizeError(error), 'error')
        return false
      } finally {
        mutationLock.current = false
        setMutating(false)
      }
    },
    [loadWorkspace, notify, snapshot?.currentProjectId]
  )

  const currentProject = useMemo(
    () => snapshot?.projects.find((project) => project.id === snapshot.currentProjectId) ?? null,
    [snapshot]
  )
  const visibleProjects = useMemo(
    () => filterAndSortProjects(snapshot?.projects ?? [], deferredProjectQuery, projectFilter, projectSort),
    [deferredProjectQuery, projectFilter, projectSort, snapshot?.projects]
  )
  const projectSearchResults = useMemo(
    () => snapshot
      ? searchCurrentProject(snapshot, deferredProjectSearchQuery, projectSearchLimit)
      : { documents: [], cards: [], documentTotal: 0, cardTotal: 0 },
    [deferredProjectSearchQuery, snapshot, projectSearchLimit]
  )
  const projectSearchOpen = projectSearchFocused && Boolean(projectSearchQuery.trim())
  const searchCard = snapshot?.cards.find((card) => card.id === searchCardId)
  useEffect(() => {
    setProjectSearchLimit(8)
  }, [projectSearchQuery])
  useEffect(() => {
    setProjectSearchQuery('')
    setSearchCardId(null)
  }, [snapshot?.currentProjectId])

  const switchProject = async (projectId: string): Promise<void> => {
    if (projectId === snapshot?.currentProjectId || mutationLock.current) return
    mutationLock.current = true
    setMutating(true)
    if (await loadWorkspace(projectId)) {
      setReadingRequest(null)
      setReadingDocumentId(null)
    }
    mutationLock.current = false
    setMutating(false)
  }

  const locateSynthesis = useCallback((cardId: string, excluded: boolean): void => {
    setFocusCardId(cardId)
    setSynthesisMode(excluded ? 'excluded' : 'active')
    setActiveView('synthesis')
  }, [setActiveView])

  const openSource = useCallback((documentId: string, page: number | null, locatorJson: string): void => {
    const token = Date.now() + Math.floor(Math.random() * 1000)
    const locator = page ? parsePdfLocator(locatorJson, page) : null
    setReadingRequest({ token, documentId, page, locator })
    setActiveView('reading')
  }, [setActiveView])
  const clearReadingRequest = useCallback(() => setReadingRequest(null), [])
  const clearFocusCard = useCallback(() => setFocusCardId(null), [])

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
      await loadBackupManager()
      notify('完整数据库备份已导出。')
    } catch (error) {
      notify(normalizeError(error), 'error')
    } finally {
      setDatabaseBusy(false)
    }
  }

  const exportProjectDatabase = async (): Promise<void> => {
    if (!currentProject) return
    try {
      const destination = await saveDialog({
        title: `导出项目：${currentProject.name}`,
        defaultPath: projectDatabaseFileName(currentProject.name),
        filters: [{ name: '砚台项目数据库', extensions: ['db'] }]
      })
      if (typeof destination !== 'string') return
      setDatabaseBusy(true)
      await api.exportProjectDatabase(currentProject.id, destination)
      await loadBackupManager()
      notify('当前项目数据库已导出；PDF 文件未打包。')
    } catch (error) {
      notify(normalizeError(error), 'error')
    } finally {
      setDatabaseBusy(false)
    }
  }

  const removeSelectedProject = async (): Promise<void> => {
    if (!removingProject || mutationLock.current) return
    mutationLock.current = true
    const nextProjectId = snapshot?.projects.find(
      (project) => project.id !== removingProject.id
    )?.id
    setMutating(true)
    try {
      await api.removeProject(removingProject.id)
      consumeWorkspaceChanges()
      await loadWorkspace(nextProjectId)
      setRemovingProject(null)
      setReadingRequest(null)
      setFocusCardId(null)
      setActiveView('reading')
      notify('项目及其项目专属研究数据已删除。')
    } catch (error) {
      notify(normalizeError(error), 'error')
    } finally {
      mutationLock.current = false
      setMutating(false)
    }
  }

  const chooseDatabaseImport = async (mode: 'database' | 'project'): Promise<void> => {
    try {
      const source = await openDialog({
        title: mode === 'project' ? '选择单项目数据库' : '选择要合并的砚台数据库备份',
        multiple: false,
        directory: false,
        filters: [{ name: mode === 'project' ? '砚台项目数据库' : '砚台数据库备份', extensions: ['db'] }]
      })
      if (typeof source !== 'string') return
      await previewBackupImport(source, mode)
    } catch (error) {
      notify(normalizeError(error), 'error')
    } finally {
      setDatabaseBusy(false)
    }
  }

  const previewBackupImport = async (path: string, mode: 'database' | 'project'): Promise<void> => {
    setDatabaseBusy(true)
    try {
      const preview = await api.previewDatabaseImport(path, mode === 'project')
      setPendingDatabaseImport({ path, mode, preview })
    } catch (error) { notify(normalizeError(error), 'error') }
    finally { setDatabaseBusy(false) }
  }

  const importDatabase = async (): Promise<void> => {
    if (!pendingDatabaseImport) return
    const pendingImport = pendingDatabaseImport
    const resultHolder: { value: DatabaseImportResult | null } = { value: null }
    setDatabaseBusy(true)
    const succeeded = await runMutation(
      async () => {
        resultHolder.value =
          pendingImport.mode === 'project'
            ? await api.importProjectDatabase(pendingImport.path)
            : await api.importDatabase(pendingImport.path)
      },
      pendingImport.mode === 'project'
        ? '项目已加入当前资料库，原有项目保持不变。'
        : '数据库备份已合并，原有项目保持不变。'
    )
    setDatabaseBusy(false)
    if (succeeded && resultHolder.value) {
      await loadBackupManager()
      setDatabaseImportResult(resultHolder.value)
      setPendingDatabaseImport(null)
      setShowDatabaseDialog(false)
      setReadingRequest(null)
      setFocusCardId(null)
    }
  }

  const chooseBackupDirectory = async (): Promise<void> => {
    try {
      const directory = await openDialog({
        title: '选择自动安全备份目录',
        multiple: false,
        directory: true
      })
      if (typeof directory !== 'string') return
      setBackupManagerBusy(true)
      const next = await api.updateBackupSettings({
        customDirectory: directory,
        retentionDays: backupManager?.settings.retentionDays ?? null,
        retentionCount: backupManager?.settings.retentionCount ?? null,
        automaticIntervalMinutes: backupManager?.settings.automaticIntervalMinutes ?? 120
      })
      setBackupManager(next)
      setBackupManagerError(null)
      notify('自动备份目录已更新；旧目录中的备份仍保留在原位置。', 'warning')
    } catch (error) {
      notify(normalizeError(error), 'error')
    } finally {
      setBackupManagerBusy(false)
    }
  }

  const updateBackupSettings = async (
    customDirectory: string | null,
    retentionDays: number | null,
    retentionCount: number | null,
    automaticIntervalMinutes: number
  ): Promise<void> => {
    const intervalChanged =
      backupManager?.settings.automaticIntervalMinutes !== automaticIntervalMinutes
    setBackupManagerBusy(true)
    try {
      const next = await api.updateBackupSettings({
        customDirectory,
        retentionDays,
        retentionCount,
        automaticIntervalMinutes
      })
      setBackupManager(next)
      setBackupManagerError(null)
      notify(intervalChanged
        ? '自动备份周期已保存；倒计时从现在重新开始。'
        : '自动备份设置已保存。')
    } catch (error) {
      notify(normalizeError(error), 'error')
    } finally {
      setBackupManagerBusy(false)
    }
  }

  const createBackupSnapshot = async (): Promise<void> => {
    setBackupManagerBusy(true)
    try {
      setBackupManager(await api.createBackupSnapshot())
      setBackupManagerError(null)
      notify('当前资料库已备份。')
    } catch (error) {
      notify(normalizeError(error), 'error')
    } finally {
      setBackupManagerBusy(false)
    }
  }

  const cleanupBackups = async (): Promise<void> => {
    setBackupManagerBusy(true)
    try {
      const result = await api.cleanupBackups()
      await loadBackupManager()
      notify(`备份清理完成：删除 ${result.deletedCount} 份，释放 ${formatBytes(result.freedBytes)}${
        result.failedCount > 0 ? `，${result.failedCount} 份未能处理` : ''
      }。`, result.failedCount > 0 ? 'warning' : 'success')
    } catch (error) {
      notify(normalizeError(error), 'error')
    } finally {
      setBackupManagerBusy(false)
    }
  }

  const deleteAutomaticBackup = async (): Promise<void> => {
    if (!deletingBackup) return
    setBackupManagerBusy(true)
    try {
      await api.deleteAutomaticBackup(deletingBackup.id)
      setDeletingBackup(null)
      await loadBackupManager()
      notify('自动安全备份已删除；当前数据库未受影响。')
    } catch (error) {
      notify(normalizeError(error), 'error')
    } finally {
      setBackupManagerBusy(false)
    }
  }

  const closeDialog = showCloseChoice ? (
    <CloseApplicationDialog
      busy={mutating || databaseBusy || backupManagerBusy || Boolean(backupRuntime?.running)}
      onHide={api.hideToTray}
      onExit={api.exitApplication}
      onClose={() => setShowCloseChoice(false)}
    />
  ) : null

  if (initialLoading) {
    return (
      <div className="app-loading">
        <span className="brand-seal">砚</span>
        <LoaderCircle className="spin" size={20} />
        <p>正在打开本地资料库……</p>
        {closeDialog}
      </div>
    )
  }

  if (!snapshot) {
    return (
      <div className="app-loading error-screen">
        <span className="brand-seal">砚</span>
        <h1>本地资料库未能打开</h1>
        <p>{fatalError ?? '未知错误'}</p>
        <button className="button primary" type="button" onClick={() => void loadWorkspace()}>
          重试
        </button>
        {closeDialog}
      </div>
    )
  }

  return (
    <div
      className={`app-shell ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}
      onContextMenu={(event) => {
        event.preventDefault()
        const target = event.target
        if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) {
          setAppContextMenu(null)
          return
        }
        setAppContextMenu({
          x: event.clientX,
          y: event.clientY,
          editable: target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ? target : null
        })
      }}
    >
      <aside className="sidebar">
        <header className="brand">
          <span className="brand-seal">砚</span>
          <span className="brand-copy">
            <strong>砚台</strong>
            <small>RESEARCH DESK</small>
          </span>
        </header>

        <div className="sidebar-section-heading">
          <span>我的项目</span>
          <button
            className="icon-button subtle"
            type="button"
            onClick={() => setProjectDialogMode('create')}
            aria-label="新建项目"
          >
            <Plus size={15} />
          </button>
        </div>

        <div className="project-list-tools">
          <label className="sidebar-search-box">
            <Search size={14} />
            <input
              value={projectQuery}
              onChange={(event) => setProjectQuery(event.target.value)}
              placeholder="搜索项目"
              aria-label="搜索项目"
            />
          </label>
          <div className="project-list-selects">
            <select
              value={projectFilter}
              onChange={(event) => setProjectFilter(event.target.value as ProjectFilter)}
              aria-label="筛选项目"
            >
              <option value="all">全部项目</option>
              <option value="documents">有文献</option>
              <option value="cards">有卡片</option>
              <option value="empty">空项目</option>
            </select>
            <select
              value={projectSort}
              onChange={(event) => setProjectSort(event.target.value as ProjectSort)}
              aria-label="项目排序"
            >
              <option value="updated">最近更新</option>
              <option value="name">名称</option>
              <option value="documents">文献数</option>
              <option value="cards">卡片数</option>
            </select>
          </div>
        </div>

        <nav className="project-navigation" aria-label="阅读项目">
          {visibleProjects.map((project) => (
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
          {visibleProjects.length === 0 && snapshot.projects.length > 0 ? (
            <p className="project-list-empty">没有符合条件的项目</p>
          ) : null}
        </nav>

        <footer className="sidebar-footer">
          <button
            className="sidebar-collapse-button"
            type="button"
            aria-label={sidebarCollapsed ? '展开项目栏' : '收起项目栏'}
            title={sidebarCollapsed ? '展开项目栏' : '收起项目栏'}
            onClick={() => setSidebarCollapsed((current) => !current)}
          >
            {sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
            <span>{sidebarCollapsed ? '展开项目栏' : '收起项目栏'}</span>
          </button>
          <div className="local-database-status" title={mutating ? '正在保存更改' : '已保存的内容保留在本机'}>
            <Database size={15} />
            <span>
              <strong>本地资料库</strong>
              <small>{mutating ? '正在保存更改…' : '已保存内容保留在本机'}</small>
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
            <div className="project-heading-copy">
              <div className="project-heading-title-row">
                <h1>{currentProject?.name ?? '尚未创建阅读项目'}</h1>
                {currentProject ? (
                  <div
                    className="project-actions-anchor"
                    onBlur={(event) => {
                      if (!event.currentTarget.contains(event.relatedTarget)) {
                        setShowProjectActions(false)
                      }
                    }}
                  >
                    <button
                      className={`project-manage-button ${showProjectActions ? 'active' : ''}`}
                      type="button"
                      aria-haspopup="menu"
                      aria-expanded={showProjectActions}
                      onClick={() => setShowProjectActions((visible) => !visible)}
                    >
                      <Settings2 size={14} />
                      <span>项目操作</span>
                      <ChevronDown size={13} />
                    </button>
                    {showProjectActions ? (
                      <div className="project-actions-menu" role="menu">
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setShowProjectActions(false)
                            setProjectDialogMode('edit')
                          }}
                        >
                          <PencilLine size={15} />
                          <span>
                            <strong>编辑项目信息</strong>
                            <small>修改名称、说明和标识色</small>
                          </span>
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          disabled={databaseBusy}
                          onClick={() => {
                            setShowProjectActions(false)
                            void exportProjectDatabase()
                          }}
                        >
                          <Download size={15} />
                          <span>
                            <strong>导出此项目</strong>
                            <small>备份当前项目的全部记录</small>
                          </span>
                        </button>
                        <button
                          className="danger"
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setShowProjectActions(false)
                            setRemovingProject(currentProject)
                          }}
                        >
                          <Trash2 size={15} />
                          <span>
                            <strong>删除项目</strong>
                            <small>删除前会再次确认</small>
                          </span>
                        </button>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
              <p>{currentProject?.description || '从阅读材料开始，积累自己的笔记与想法。'}</p>
            </div>
          </div>
          <div className="topbar-tools">
            {currentProject ? (
              <div
                className="project-global-search"
                onFocus={() => setProjectSearchFocused(true)}
                onBlur={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget)) setProjectSearchFocused(false)
                }}
                onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setProjectSearchFocused(false) } }}
              >
                <label>
                  <Search size={15} />
                  <input
                    value={projectSearchQuery}
                    onChange={(event) => setProjectSearchQuery(event.target.value)}
                    placeholder="搜索当前项目"
                    aria-label="搜索当前项目的文献和卡片"
                  />
                </label>
                {projectSearchOpen ? (
                  <div className="project-global-search-results">
                    {projectSearchResults.documents.length > 0 ? (
                      <section>
                        <header>文献 <span>{projectSearchResults.documentTotal}</span></header>
                        {projectSearchResults.documents.map((document) => (
                          <button
                            type="button"
                            key={document.id}
                            onClick={() => {
                              setReadingRequest({ token: Date.now(), documentId: document.id, page: null, locator: null })
                              setActiveView('reading')
                              setProjectSearchFocused(false)
                            }}
                          >
                            <BookOpen size={14} />
                            <span><strong>{document.title}</strong><small>{document.authors || '未知作者'}{document.year ? ` · ${document.year}` : ''}</small></span>
                          </button>
                        ))}
                      </section>
                    ) : null}
                    {projectSearchResults.cards.length > 0 ? (
                      <section>
                        <header>卡片 <span>{projectSearchResults.cardTotal}</span></header>
                        {projectSearchResults.cards.map((card) => (
                          <button
                            type="button"
                            key={card.id}
                            onClick={() => {
                              setSearchCardId(card.id)
                              setProjectSearchFocused(false)
                            }}
                          >
                            <FileStack size={14} />
                            <span><strong>{card.comment || card.displayText}</strong><small>{card.documentTitle} · {card.tags.join(' · ') || card.displayText}</small></span>
                          </button>
                        ))}
                      </section>
                    ) : null}
                    {projectSearchResults.documentTotal > projectSearchResults.documents.length || projectSearchResults.cardTotal > projectSearchResults.cards.length ? <button type="button" onClick={() => setProjectSearchLimit((limit) => limit + 20)}>显示更多结果</button> : null}
                    {projectSearchResults.documents.length === 0 && projectSearchResults.cards.length === 0 ? (
                      <p>没有匹配的文献、摘录、即时笔记或标签。</p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}
            <div className="font-size-control" role="group" aria-label="界面字号">
              <Type size={14} />
              {(['small', 'standard', 'large'] as const).map((size) => (
                <button
                  className={fontSize === size ? 'active' : ''}
                  type="button"
                  key={size}
                  aria-pressed={fontSize === size}
                  onClick={() => setFontSize(size)}
                >
                  {size === 'small' ? '小' : size === 'standard' ? '标准' : '大'}
                </button>
              ))}
            </div>
            <button
              className="topbar-database-button"
              type="button"
              onClick={() => {
                setShowDatabaseDialog(true)
                void loadBackupManager()
              }}
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
                disabled={!currentProject}
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
          {fatalError ? <div role="alert" className="workspace-refresh-warning">界面刷新失败，当前仍显示上次内容。<button className="button ghost compact" type="button" onClick={() => void loadWorkspace(snapshot.currentProjectId ?? undefined)}>重试刷新</button><small>{fatalError}</small></div> : null}
          {!currentProject ? (
            <div className="workspace-view empty-workspace-view">
              <div className="empty-state">
                <FolderKanban size={27} />
                <h3>从一个阅读项目开始</h3>
                <p>用项目组织一本书、一个主题或一项写作任务。</p>
                <button
                  className="button primary"
                  type="button"
                  onClick={() => setProjectDialogMode('create')}
                >
                  <Plus size={15} /> 新建项目
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className={`view-pane ${activeView === 'reading' ? 'active' : ''}`} aria-hidden={activeView !== 'reading'}>
                <ReadingView
                  key={snapshot.currentProjectId}
                  isActive={activeView === 'reading'}
                  snapshot={snapshot}
                  runMutation={runMutation}
                  notify={notify}
                  initialRequest={readingRequest}
                  onFocusHandled={clearReadingRequest}
                  onSelectedDocumentChange={setReadingDocumentId}
                />
              </div>
              <div className={`view-pane ${activeView === 'library' ? 'active' : ''}`} aria-hidden={activeView !== 'library'}>
                <LibraryView
                  key={snapshot.currentProjectId}
                  snapshot={snapshot}
                  runMutation={runMutation}
                  currentReadingDocumentId={readingDocumentId}
                  onLocateSynthesis={locateSynthesis}
                  onOpenSource={openSource}
                />
              </div>
              <div className={`view-pane ${activeView === 'synthesis' ? 'active' : ''}`} aria-hidden={activeView !== 'synthesis'}>
                <SynthesisView
                  key={snapshot.currentProjectId}
                  snapshot={snapshot}
                  runMutation={runMutation}
                  focusCardId={focusCardId}
                  initialMode={synthesisMode}
                  onFocusHandled={clearFocusCard}
                  onOpenSource={openSource}
                />
              </div>
              <div className={`view-pane ${activeView === 'outline' ? 'active' : ''}`} aria-hidden={activeView !== 'outline'}>
                <OutlineView key={snapshot.currentProjectId} snapshot={snapshot} runMutation={runMutation} onOpenSource={openSource} />
              </div>
            </>
          )}
        </section>
      </main>

      {appContextMenu ? (
        <ContextMenu
          x={appContextMenu.x}
          y={appContextMenu.y}
          ariaLabel={appContextMenu.editable ? '文字编辑操作' : '切换项目视图'}
          onClose={() => setAppContextMenu(null)}
          items={appContextMenu.editable
            ? [
                { id: 'cut', label: '剪切', icon: <Scissors size={14} />, onSelect: () => { if (!runEditingCommand(appContextMenu.editable, 'cut')) notify('当前环境未能完成剪切，请使用 Ctrl+X。', 'warning') } },
                { id: 'copy', label: '复制', icon: <Copy size={14} />, onSelect: () => { if (!runEditingCommand(appContextMenu.editable, 'copy')) notify('当前环境未能完成复制，请使用 Ctrl+C。', 'warning') } },
                { id: 'paste', label: '粘贴', icon: <ClipboardPaste size={14} />, onSelect: () => { if (!runEditingCommand(appContextMenu.editable, 'paste')) notify('当前环境未能读取剪贴板，请使用 Ctrl+V。', 'warning') } },
                { id: 'select-all', label: '全选', icon: <TextSelect size={14} />, separatorBefore: true, onSelect: () => appContextMenu.editable?.select() }
              ]
            : tabs.map((tab) => {
                const Icon = tab.icon
                return {
                  id: tab.id,
                  label: `切换到${tab.label}`,
                  icon: <Icon size={14} />,
                  disabled: !currentProject || activeView === tab.id,
                  onSelect: () => setActiveView(tab.id)
                }
              })}
        />
      ) : null}

      {searchCard && snapshot ? (
        <CardEditDialog
          card={searchCard}
          researchRoles={snapshot.researchRoles}
          availableTags={[...new Set(snapshot.cards.flatMap((card) => card.tags))]}
          onClose={() => setSearchCardId(null)}
          onSave={async (input) => { if (await runMutation(() => api.updateCard(input), '卡片已更新。')) setSearchCardId(null) }}
          onOpenSource={() => { setSearchCardId(null); openSource(searchCard.documentId, searchCard.pdfPage, searchCard.locatorJson) }}
        />
      ) : null}

      {projectDialogMode ? (
        <ProjectDialog
          project={projectDialogMode === 'edit' ? currentProject : null}
          busy={mutating}
          onSubmit={async (name, description, color) => {
            if (projectDialogMode === 'edit' && currentProject) {
              const succeeded = await runMutation(
                () => api.updateProject({
                  projectId: currentProject.id,
                  name,
                  description,
                  color
                }),
                '项目信息已更新。'
              )
              if (succeeded) setProjectDialogMode(null)
              return
            }

            let newProjectId: string | null = null
            const succeeded = await runMutation(
              async () => {
                newProjectId = await api.createProject({ name, description, color })
              },
              '新阅读项目已创建。'
            )
            if (succeeded && newProjectId) {
              await loadWorkspace(newProjectId)
              setProjectDialogMode(null)
              setActiveView('reading')
            }
          }}
          onClose={() => setProjectDialogMode(null)}
        />
      ) : null}

      {removingProject ? (
        <ConfirmDialog
          title={`删除项目“${removingProject.name}”？`}
          description="该项目专属的卡片、批注、阅读笔记、二次整理和写作提纲会一并永久删除；仍被其他项目引用的文献会保留。此操作无法撤销，建议先导出此项目。"
          confirmLabel={mutating ? '正在删除…' : '删除项目'}
          dangerous
          onConfirm={() => void removeSelectedProject()}
          onCancel={() => {
            if (!mutating) setRemovingProject(null)
          }}
        />
      ) : null}

      {showDatabaseDialog ? (
        <DatabaseTransferDialog
          busy={databaseBusy || mutating}
          managerBusy={backupManagerBusy}
          manager={backupManager}
          runtime={backupRuntime}
          onImportBackup={(backup) => void previewBackupImport(backup.path, backup.kind === 'project' ? 'project' : 'database')}
          managerError={backupManagerError}
          onExport={() => void exportDatabase()}
          onMerge={() => void chooseDatabaseImport('database')}
          onImportProject={() => void chooseDatabaseImport('project')}
          onRefresh={() => void loadBackupManager()}
          onChooseDirectory={() => void chooseBackupDirectory()}
          onResetDirectory={() =>
            void updateBackupSettings(
              null,
              backupManager?.settings.retentionDays ?? null,
              backupManager?.settings.retentionCount ?? null,
              backupManager?.settings.automaticIntervalMinutes ?? 120
            )
          }
          onUpdateRetention={(retentionDays, retentionCount) =>
            void updateBackupSettings(
              backupManager?.settings.customDirectory ?? null,
              retentionDays,
              retentionCount,
              backupManager?.settings.automaticIntervalMinutes ?? 120
            )
          }
          onUpdateInterval={(automaticIntervalMinutes) =>
            void updateBackupSettings(
              backupManager?.settings.customDirectory ?? null,
              backupManager?.settings.retentionDays ?? null,
              backupManager?.settings.retentionCount ?? null,
              automaticIntervalMinutes
            )
          }
          onCreateSnapshot={() => void createBackupSnapshot()}
          onCleanup={() => void cleanupBackups()}
          onRevealDirectory={() => void api.revealBackupDirectory().catch((error) => notify(normalizeError(error), 'error'))}
          onRevealBackup={(backupId) =>
            void api.revealBackup(backupId).catch((error) => notify(normalizeError(error), 'error'))
          }
          onDeleteBackup={setDeletingBackup}
          onClose={() => { if (!databaseBusy && !backupManagerBusy) setShowDatabaseDialog(false) }}
        />
      ) : null}

      {deletingBackup ? (
        <ConfirmDialog
          title="删除这份自动安全备份？"
          description={`将永久删除“${fileName(deletingBackup.path)}”（${formatDateTime(deletingBackup.createdAt)}，${formatBytes(deletingBackup.sizeBytes)}）。这不会删除或修改当前正在使用的数据库。`}
          confirmLabel={backupManagerBusy ? '正在删除…' : '删除备份文件'}
          dangerous
          onConfirm={() => {
            if (!backupManagerBusy) void deleteAutomaticBackup()
          }}
          onCancel={() => {
            if (!backupManagerBusy) setDeletingBackup(null)
          }}
        />
      ) : null}

      {pendingDatabaseImport ? (
        <DatabaseImportPreviewDialog
          pending={pendingDatabaseImport}
          busy={databaseBusy}
          onConfirm={() => void importDatabase()}
          onClose={() => setPendingDatabaseImport(null)}
        />
      ) : null}

      {databaseImportResult ? (
        <DatabaseImportResultDialog
          result={databaseImportResult}
          onClose={() => setDatabaseImportResult(null)}
        />
      ) : null}

      {closeDialog}

      <div
        className={`toast toast-${toast?.kind ?? 'success'} ${toast ? 'show' : ''}`}
        role={toast?.kind === 'error' ? 'alert' : 'status'}
        aria-live={toast?.kind === 'error' ? 'assertive' : 'polite'}
      >
        <span className="toast-mark">
          {toast?.kind === 'error' ? <CircleX size={15} /> : toast?.kind === 'warning' ? <AlertTriangle size={15} /> : <CheckCircle2 size={15} />}
        </span>
        <span>{toast?.message}</span>
      </div>
      {mutating ? <div className="mutation-line" /> : null}
    </div>
  )
}

function runEditingCommand(
  target: HTMLInputElement | HTMLTextAreaElement | null,
  command: 'cut' | 'copy' | 'paste'
): boolean {
  if (!target) return false
  target.focus()
  try { return document.execCommand(command) } catch { return false }
}

function DatabaseImportResultDialog({
  result,
  onClose
}: {
  result: DatabaseImportResult
  onClose: () => void
}): React.JSX.Element {
  return (
    <Modal title="数据库合并完成" onClose={onClose} width="large">
      <div className="database-import-result">
        <ShieldCheck size={28} />
        <p>现有项目保持不变；文件中的项目、卡片、标注、二次整理和提纲已安全合并。</p>
        <div className="database-preview-summary database-result-summary">
          <section>
            <h3>来源内容</h3>
            <dl>
              <div><dt>项目</dt><dd>{result.sourceProjectCount}</dd></div>
              <div><dt>文献</dt><dd>{result.sourceDocumentCount}</dd></div>
              <div><dt>卡片</dt><dd>{result.sourceCardCount}</dd></div>
              <div><dt>PDF 批注</dt><dd>{result.sourceAnnotationCount}</dd></div>
              <div><dt>提纲节点</dt><dd>{result.sourceOutlineNodeCount}</dd></div>
            </dl>
          </section>
          <section>
            <h3>合并结果</h3>
            <dl>
              <div className="positive"><dt>新增记录</dt><dd>{result.addedItemCount}</dd></div>
              <div><dt>新增项目</dt><dd>{result.createdProjectCount}</dd></div>
              <div><dt>合并已有项目</dt><dd>{result.mergedProjectCount}</dd></div>
              <div><dt>跳过相同记录</dt><dd>{result.skippedItemCount}</dd></div>
              <div className={result.conflictItemCount > 0 ? 'warning' : ''}><dt>保留当前版本的冲突</dt><dd>{result.conflictItemCount}</dd></div>
              <div className={result.missingPdfCount > 0 ? 'warning' : ''}><dt>缺失 PDF</dt><dd>{result.missingPdfCount}</dd></div>
            </dl>
          </section>
        </div>
        <dl className="database-result-details">
          <div>
            <dt>合并前自动备份</dt>
            <dd title={result.safetyBackupPath}>{result.safetyBackupPath}</dd>
          </div>
        </dl>
        {result.backupWarning ? (
          <p className="database-import-warning">{result.backupWarning}</p>
        ) : null}
        {result.cleanupDeletedCount > 0 ? (
          <p className="database-cleanup-result">
            自动清理删除 {result.cleanupDeletedCount} 份过期安全备份，释放 {formatBytes(result.cleanupFreedBytes)}。
          </p>
        ) : null}
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

function DatabaseImportPreviewDialog({
  pending,
  busy,
  onConfirm,
  onClose
}: {
  pending: { path: string; mode: 'database' | 'project'; preview: DatabaseImportPreview }
  busy: boolean
  onConfirm: () => void
  onClose: () => void
}): React.JSX.Element {
  const { preview } = pending
  const projectOnly = pending.mode === 'project'
  return (
    <Modal
      title={projectOnly ? '导入项目预览' : '数据库合并预览'}
      subtitle={`已检查“${fileName(pending.path)}”；确认前请核对来源内容和预计合并结果。`}
      onClose={() => {
        if (!busy) onClose()
      }}
      width="large"
    >
      <div className="database-preview-summary">
        <section>
          <h3>文件内容</h3>
          <dl>
            <div><dt>项目</dt><dd>{preview.sourceProjectCount}</dd></div>
            <div><dt>文献</dt><dd>{preview.sourceDocumentCount}</dd></div>
            <div><dt>卡片</dt><dd>{preview.sourceCardCount}</dd></div>
            <div><dt>PDF 批注</dt><dd>{preview.sourceAnnotationCount}</dd></div>
            <div><dt>提纲节点</dt><dd>{preview.sourceOutlineNodeCount}</dd></div>
          </dl>
        </section>
        <section>
          <h3>预计合并结果</h3>
          <dl>
            <div className="positive"><dt>新增记录</dt><dd>{preview.addedItemCount}</dd></div>
            <div><dt>合并到已有项目</dt><dd>{preview.mergedProjectCount}</dd></div>
            <div><dt>跳过相同记录</dt><dd>{preview.skippedItemCount}</dd></div>
            <div className={preview.conflictItemCount > 0 ? 'warning' : ''}><dt>内容冲突</dt><dd>{preview.conflictItemCount}</dd></div>
            <div className={preview.missingPdfCount > 0 ? 'warning' : ''}><dt>缺失 PDF</dt><dd>{preview.missingPdfCount}</dd></div>
          </dl>
        </section>
      </div>
      <div className="database-preview-explanation">
        <ShieldCheck size={17} />
        <p>
          “新增”是会补入的数据库记录；“跳过”是稳定标识与内容都相同的重复记录；“冲突”表示稳定标识相同但内容不同，本次会保留当前资料库中的版本。导入前必须先成功创建自动安全备份，现有项目不会被清空或替换。
        </p>
      </div>
      {preview.missingPdfCount > 0 ? (
        <p className="database-import-warning">数据库不包含 PDF 原件；导入后可在阅读台为缺失文献重新链接 PDF。</p>
      ) : null}
      <div className="modal-actions">
        <button className="button ghost" type="button" disabled={busy} onClick={onClose}>取消</button>
        <button className="button primary" type="button" disabled={busy} onClick={onConfirm}>
          {busy ? '正在安全合并…' : projectOnly ? '确认导入项目' : '确认合并数据库'}
        </button>
      </div>
    </Modal>
  )
}

interface ProjectDialogProps {
  project: ProjectSummary | null
  busy: boolean
  onSubmit: (name: string, description: string, color: string) => Promise<void>
  onClose: () => void
}

function ProjectDialog({ project, busy, onSubmit, onClose }: ProjectDialogProps): React.JSX.Element {
  const [name, setName] = useState(project?.name ?? '')
  const [description, setDescription] = useState(project?.description ?? '')
  const [color, setColor] = useState(project?.color ?? '#a05d43')
  const editing = Boolean(project)
  const hasUnsavedChanges =
    name !== (project?.name ?? '') ||
    description !== (project?.description ?? '') ||
    color !== (project?.color ?? '#a05d43')

  return (
    <Modal
      title={editing ? '编辑阅读项目' : '新建阅读项目'}
      subtitle={
        editing
          ? '项目信息修改后，已有文献、卡片与提纲结构不会改变。'
          : '按阅读主题、写作任务或资料用途建立项目，不预设类型。'
      }
      onClose={onClose}
      hasUnsavedChanges={hasUnsavedChanges}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (!busy) void onSubmit(name, description, color)
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
            placeholder="记录阅读主题或当前工作范围（可选）"
          />
        </label>
        <label className="field color-field">
          <span>项目标识色</span>
          <input type="color" value={color} onChange={(event) => setColor(event.target.value)} />
          <code>{color}</code>
        </label>
        <div className="modal-actions">
          <button className="button ghost" type="button" disabled={busy} data-modal-close>
            取消
          </button>
          <button className="button primary" type="submit" disabled={busy}>
            {editing ? <PencilLine size={15} /> : <FileStack size={15} />}
            {busy ? '正在保存…' : editing ? '保存修改' : '创建项目'}
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

function projectDatabaseFileName(projectName: string): string {
  const date = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  const safeName = projectName
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/[. ]+$/g, '')
    .slice(0, 80) || '未命名项目'
  return `砚台项目-${safeName}-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}.db`
}


function loadFontSize(): FontSize {
  if (typeof window === 'undefined') return 'standard'
  try {
    const stored = window.localStorage.getItem(FONT_SIZE_STORAGE_KEY)
    return stored === 'small' || stored === 'large' || stored === 'standard' ? stored : 'standard'
  } catch {
    return 'standard'
  }
}
