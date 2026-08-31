export type RunMutation = (
  action: () => Promise<unknown>,
  successMessage: string,
  projectId?: string
) => Promise<boolean>

export type NoticeKind = 'success' | 'warning' | 'error'
export type Notify = (message: string, kind?: NoticeKind) => void
