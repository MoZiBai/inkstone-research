export type RunMutation = (
  action: () => Promise<unknown>,
  successMessage: string,
  projectId?: string
) => Promise<boolean>

export type Notify = (message: string) => void
