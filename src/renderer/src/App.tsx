import {
  AlertTriangle,
  BookOpen,
  Boxes,
  ChevronDown,
  Database,
  DatabaseBackup,
  Download,
  FileStack,
  FolderOpen,
  FolderKanban,
  HardDrive,
  Library,
  LoaderCircle,
  PanelLeftClose,
  PanelLeftOpen,
  PencilLine,
  Plus,
  RefreshCw,
  ScrollText,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload
} from 'lucide-react'
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  BackupManagerState,
  BackupRecord,
  DatabaseImportPreview,
  DatabaseImportResult,
  ProjectSummary,
  WorkspaceSnapshot
} from '@shared/types'
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
  const [projectDialogMode, setProjectDialogMode] = useState<'create' | 'edit' | null>(null)
  const [showProjectActions, setShowProjectActions] = useState(false)
  const [removingProject, setRemovingProject] = useState<ProjectSummary | null>(null)
  const [showDatabaseDialog, setShowDatabaseDialog] = useState(false)
  const [databaseBusy, setDatabaseBusy] = useState(false)
  const [backupManager, setBackupManager] = useState<BackupManagerState | null>(null)
  const [backupManagerError, setBackupManagerError] = useState<string | null>(null)
  const [backupManagerBusy, setBackupManagerBusy] = useState(false)
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
      await loadBackupManager()
      notify('完整数据库备份已导出。')
    } catch (error) {
      notify(normalizeError(error))
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
      notify(normalizeError(error))
    } finally {
      setDatabaseBusy(false)
    }
  }

  const removeSelectedProject = async (): Promise<void> => {
    if (!removingProject || mutating) return
    const nextProjectId = snapshot?.projects.find(
      (project) => project.id !== removingProject.id
    )?.id
    setMutating(true)
    try {
      await api.removeProject(removingProject.id)
      await loadWorkspace(nextProjectId)
      setRemovingProject(null)
      setReadingRequest(null)
      setFocusCardId(null)
      setActiveView('reading')
      notify('项目及其项目专属研究数据已删除。')
    } catch (error) {
      notify(normalizeError(error))
    } finally {
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
      setDatabaseBusy(true)
      const preview = await api.previewDatabaseImport(source, mode === 'project')
      setPendingDatabaseImport({ path: source, mode, preview })
    } catch (error) {
      notify(normalizeError(error))
    } finally {
      setDatabaseBusy(false)
    }
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
        retentionDays: backupManager?.settings.retentionDays ?? null
      })
      setBackupManager(next)
      setBackupManagerError(null)
      notify('自动备份目录已更新；旧目录中的备份仍保留在原位置。')
    } catch (error) {
      notify(normalizeError(error))
    } finally {
      setBackupManagerBusy(false)
    }
  }

  const updateBackupSettings = async (
    customDirectory: string | null,
    retentionDays: number | null
  ): Promise<void> => {
    setBackupManagerBusy(true)
    try {
      const next = await api.updateBackupSettings({ customDirectory, retentionDays })
      setBackupManager(next)
      setBackupManagerError(null)
      notify('自动备份设置已保存。')
    } catch (error) {
      notify(normalizeError(error))
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
      }。`)
    } catch (error) {
      notify(normalizeError(error))
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
      notify(normalizeError(error))
    } finally {
      setBackupManagerBusy(false)
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
    <div
      className={`app-shell ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}
      onContextMenu={(event) => {
        if (!allowsNativeContextMenu(event.target)) event.preventDefault()
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
            <div className="project-heading-copy">
              <div className="project-heading-title-row">
                <h1>{currentProject?.name ?? '尚未创建研究项目'}</h1>
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
                            <small>保存仅包含当前项目的 SQLite 数据库</small>
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
              <p>{currentProject?.description || '从阅读材料开始建立可追溯的论文证据。'}</p>
            </div>
          </div>
          <div className="topbar-tools">
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
          {!currentProject ? (
            <div className="workspace-view empty-workspace-view">
              <div className="empty-state">
                <FolderKanban size={27} />
                <h3>从一个研究项目开始</h3>
                <p>项目可以对应一篇论文、一个章节或任何独立研究任务。</p>
                <button
                  className="button primary"
                  type="button"
                  onClick={() => setProjectDialogMode('create')}
                >
                  <Plus size={15} /> 新建项目
                </button>
              </div>
            </div>
          ) : activeView === 'reading' ? (
            <ReadingView
              snapshot={snapshot}
              runMutation={runMutation}
              notify={notify}
              initialRequest={readingRequest}
              onFocusHandled={() => setReadingRequest(null)}
            />
          ) : null}
          {currentProject && activeView === 'library' ? (
            <LibraryView
              snapshot={snapshot}
              runMutation={runMutation}
              onLocateSynthesis={locateSynthesis}
              onOpenSource={openSource}
            />
          ) : null}
          {currentProject && activeView === 'synthesis' ? (
            <SynthesisView
              snapshot={snapshot}
              runMutation={runMutation}
              focusCardId={focusCardId}
              initialMode={synthesisMode}
              onFocusHandled={() => setFocusCardId(null)}
              onOpenSource={openSource}
            />
          ) : null}
          {currentProject && activeView === 'outline' ? (
            <OutlineView snapshot={snapshot} runMutation={runMutation} onOpenSource={openSource} />
          ) : null}
        </section>
      </main>

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
              '新研究项目已创建。'
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
          description="该项目专属的卡片、批注、阅读笔记、二次整理和论文提纲会一并永久删除；仍被其他项目引用的文献会保留。此操作无法撤销，建议先导出此项目。"
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
          managerError={backupManagerError}
          onExport={() => void exportDatabase()}
          onMerge={() => void chooseDatabaseImport('database')}
          onImportProject={() => void chooseDatabaseImport('project')}
          onRefresh={() => void loadBackupManager()}
          onChooseDirectory={() => void chooseBackupDirectory()}
          onResetDirectory={() =>
            void updateBackupSettings(null, backupManager?.settings.retentionDays ?? null)
          }
          onUpdateRetention={(retentionDays) =>
            void updateBackupSettings(
              backupManager?.settings.customDirectory ?? null,
              retentionDays
            )
          }
          onCleanup={() => void cleanupBackups()}
          onRevealDirectory={() => void api.revealBackupDirectory().catch((error) => notify(normalizeError(error)))}
          onRevealBackup={(backupId) =>
            void api.revealBackup(backupId).catch((error) => notify(normalizeError(error)))
          }
          onDeleteBackup={setDeletingBackup}
          onClose={() => setShowDatabaseDialog(false)}
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
  managerBusy: boolean
  manager: BackupManagerState | null
  managerError: string | null
  onExport: () => void
  onMerge: () => void
  onImportProject: () => void
  onRefresh: () => void
  onChooseDirectory: () => void
  onResetDirectory: () => void
  onUpdateRetention: (retentionDays: number | null) => void
  onCleanup: () => void
  onRevealDirectory: () => void
  onRevealBackup: (backupId: string) => void
  onDeleteBackup: (backup: BackupRecord) => void
  onClose: () => void
}

function DatabaseTransferDialog({
  busy,
  managerBusy,
  manager,
  managerError,
  onExport,
  onMerge,
  onImportProject,
  onRefresh,
  onChooseDirectory,
  onResetDirectory,
  onUpdateRetention,
  onCleanup,
  onRevealDirectory,
  onRevealBackup,
  onDeleteBackup,
  onClose
}: DatabaseTransferDialogProps): React.JSX.Element {
  const retentionDays = manager?.settings.retentionDays ?? null
  const usesCustomRetention = retentionDays !== null && ![7, 30, 90, 180].includes(retentionDays)
  const [showCustomRetention, setShowCustomRetention] = useState(usesCustomRetention)
  const [customRetentionDraft, setCustomRetentionDraft] = useState(
    usesCustomRetention ? String(retentionDays) : '30'
  )

  useEffect(() => {
    setShowCustomRetention(usesCustomRetention)
    if (usesCustomRetention && retentionDays !== null) {
      setCustomRetentionDraft(String(retentionDays))
    }
  }, [retentionDays, usesCustomRetention])

  const allBusy = busy || managerBusy
  return (
    <Modal
      title="数据库备份与导入"
      subtitle="所有导入都采用非破坏性合并；现有项目不会因导入文件内容不完整而消失。"
      onClose={onClose}
      width="large"
    >
      <div className="database-transfer-options">
        <button type="button" disabled={allBusy} onClick={onExport}>
          <span className="database-transfer-icon"><Download size={20} /></span>
          <span>
            <strong>导出完整数据库</strong>
            <small>保存项目、卡片、标注、阅读笔记、二次整理和论文提纲。</small>
          </span>
        </button>
        <button type="button" disabled={allBusy} onClick={onImportProject}>
          <span className="database-transfer-icon"><Upload size={20} /></span>
          <span>
            <strong>导入单个项目</strong>
            <small>导入项目级数据库，保留当前资料库中的所有已有项目。</small>
          </span>
        </button>
        <button className="database-merge-option" type="button" disabled={allBusy} onClick={onMerge}>
          <span className="database-transfer-icon"><DatabaseBackup size={20} /></span>
          <span>
            <strong>合并完整数据库备份</strong>
            <small>把备份中的项目和研究数据补充进来，不删除或覆盖当前内容。</small>
          </span>
        </button>
      </div>
      <div className="database-transfer-note">
        <ShieldCheck size={16} />
        <span>数据库备份保存卡片、批注、分类、提纲、文献元数据和 PDF 路径，但不会复制 PDF 原件。</span>
      </div>

      <section className="backup-manager-section">
        <header className="backup-manager-heading">
          <div>
            <h3>自动安全备份</h3>
            <p>导入合并前先备份当前数据库；只有登记过的自动备份会参与清理。</p>
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
            <div className="backup-settings-grid">
              <div className="backup-setting-card backup-directory-setting">
                <span className="backup-setting-label">当前自动备份目录</span>
                <code title={manager.settings.effectiveDirectory}>{manager.settings.effectiveDirectory}</code>
                {manager.settings.directoryWarning ? (
                  <p className="backup-manager-warning"><AlertTriangle size={14} /><span>{manager.settings.directoryWarning}</span></p>
                ) : null}
                <div className="backup-setting-actions">
                  <button className="button ghost compact" type="button" disabled={allBusy} onClick={onRevealDirectory}>
                    <FolderOpen size={14} /> 打开目录
                  </button>
                  <button className="button ghost compact" type="button" disabled={allBusy} onClick={onChooseDirectory}>
                    更换目录
                  </button>
                  {manager.settings.customDirectory ? (
                    <button className="button ghost compact" type="button" disabled={allBusy} onClick={onResetDirectory}>
                      恢复默认
                    </button>
                  ) : null}
                </div>
                {manager.settings.customDirectory ? (
                  <small>旧目录中的备份不会被移动或删除，仍会保留在下方记录中。</small>
                ) : null}
              </div>

              <div className="backup-setting-card">
                <label className="backup-retention-field">
                  <span className="backup-setting-label">自动清理策略</span>
                  <select
                    value={showCustomRetention ? 'custom' : retentionDays === null ? 'never' : String(retentionDays)}
                    disabled={allBusy}
                    onChange={(event) => {
                      if (event.target.value === 'custom') {
                        setShowCustomRetention(true)
                        return
                      }
                      setShowCustomRetention(false)
                      onUpdateRetention(event.target.value === 'never' ? null : Number(event.target.value))
                    }}
                  >
                    <option value="never">从不自动清理（默认）</option>
                    <option value="7">保留最近 7 天</option>
                    <option value="30">保留最近 30 天</option>
                    <option value="90">保留最近 90 天</option>
                    <option value="180">保留最近 180 天</option>
                    <option value="custom">自定义天数</option>
                  </select>
                </label>
                {showCustomRetention ? (
                  <div className="backup-custom-retention">
                    <input
                      type="number"
                      min={1}
                      max={3650}
                      value={customRetentionDraft}
                      disabled={allBusy}
                      aria-label="自定义自动备份保留天数"
                      onChange={(event) => setCustomRetentionDraft(event.target.value)}
                    />
                    <span>天</span>
                    <button
                      className="button ghost compact"
                      type="button"
                      disabled={allBusy || !validRetentionDays(customRetentionDraft)}
                      onClick={() => onUpdateRetention(Number(customRetentionDraft))}
                    >
                      保存
                    </button>
                  </div>
                ) : null}
                <small>启用清理时仍至少保留最近 3 份有效自动备份；手动导出永不自动清理。</small>
                <button
                  className="button ghost compact backup-cleanup-button"
                  type="button"
                  disabled={allBusy || retentionDays === null}
                  onClick={onCleanup}
                >
                  <RefreshCw size={14} /> 立即按当前策略清理
                </button>
                {manager.settings.lastCleanupAt ? (
                  <small title={manager.settings.lastCleanupResult ?? undefined}>
                    最近清理：{formatDateTime(manager.settings.lastCleanupAt)} · {manager.settings.lastCleanupResult ?? '已完成'}
                  </small>
                ) : null}
              </div>
            </div>

            <div className="backup-records-heading">
              <div>
                <h4>应用登记的备份</h4>
                <span>{manager.records.length} 份 · 当前可用文件共 {formatBytes(manager.totalSizeBytes)}</span>
              </div>
            </div>
            <div className="backup-records-list">
              {manager.records.length === 0 ? (
                <div className="backup-empty"><HardDrive size={20} /><span>尚无应用登记的数据库备份。</span></div>
              ) : manager.records.map((record) => (
                <article className={`backup-record ${record.isAvailable ? '' : 'unavailable'}`} key={record.id}>
                  <span className={`backup-kind backup-kind-${record.kind}`}>{backupKindLabel(record.kind)}</span>
                  <div className="backup-record-copy">
                    <strong title={record.path}>{fileName(record.path)}</strong>
                    <small>{formatDateTime(record.createdAt)} · {formatBytes(record.sizeBytes)}</small>
                    <code title={record.path}>{record.path}</code>
                    {!record.isAvailable ? <em>文件已不在登记位置</em> : null}
                  </div>
                  <div className="backup-record-actions">
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
          </>
        ) : managerBusy ? (
          <div className="backup-empty"><LoaderCircle className="spin" size={18} /><span>正在读取备份记录…</span></div>
        ) : null}
      </section>
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

  return (
    <Modal
      title={editing ? '编辑研究项目' : '新建研究项目'}
      subtitle={
        editing
          ? '项目信息修改后，已有文献、卡片与提纲结构不会改变。'
          : '项目可以是一篇论文、一个章节或其他研究任务，不预设类型。'
      }
      onClose={onClose}
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
            placeholder="记录研究问题或当前工作范围（可选）"
          />
        </label>
        <label className="field color-field">
          <span>项目标识色</span>
          <input type="color" value={color} onChange={(event) => setColor(event.target.value)} />
          <code>{color}</code>
        </label>
        <div className="modal-actions">
          <button className="button ghost" type="button" disabled={busy} onClick={onClose}>
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

function allowsNativeContextMenu(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    Boolean(target.closest('input, textarea, [contenteditable="true"], [role="textbox"]'))
  )
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

function formatBytes(value: number): string {
  const size = Math.max(0, value)
  if (size < 1024) return `${size} B`
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`
  if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(size < 10 * 1024 ** 2 ? 1 : 0)} MB`
  return `${(size / 1024 ** 3).toFixed(2)} GB`
}

function formatDateTime(value: string): string {
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

function backupKindLabel(kind: BackupRecord['kind']): string {
  if (kind === 'auto') return '自动安全备份'
  if (kind === 'project') return '单项目导出'
  return '完整数据库导出'
}

function validRetentionDays(value: string): boolean {
  if (!/^\d+$/.test(value)) return false
  const days = Number(value)
  return Number.isInteger(days) && days >= 1 && days <= 3650
}
