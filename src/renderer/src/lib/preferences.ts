import { useCallback, useMemo, useState } from 'react'

export function readPreference<T>(key: string, fallback: T): T {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(key) ?? 'null')
    if (value === null || typeof value !== typeof fallback || Array.isArray(value) !== Array.isArray(fallback)) return fallback
    if (Array.isArray(fallback) && (!Array.isArray(value) || !value.every((item) => typeof item === 'string'))) return fallback
    return value as T
  } catch { return fallback }
}

export function writePreference(key: string, value: unknown): void {
  try { window.localStorage.setItem(key, JSON.stringify(value)) } catch { /* Preferences are optional. */ }
}

// Project views are keyed by project ID, so each mounted view owns its key.
export function usePersistentState<T>(key: string, fallback: T): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => readPreference(key, fallback))
  const update = useCallback<React.Dispatch<React.SetStateAction<T>>>((action) => {
    setValue((current) => {
      const next = typeof action === 'function' ? (action as (value: T) => T)(current) : action
      writePreference(key, next)
      return next
    })
  }, [key])
  return [value, update]
}

export function usePersistentSet<T extends string>(key: string, fallback: T[] = []): [Set<T>, React.Dispatch<React.SetStateAction<Set<T>>>] {
  const [values, setValues] = usePersistentState<T[]>(key, fallback)
  const set = useMemo(() => new Set(values), [values])
  const update = useCallback<React.Dispatch<React.SetStateAction<Set<T>>>>((action) => {
    setValues((current) => [...(typeof action === 'function' ? action(new Set(current)) : action)])
  }, [setValues])
  return [set, update]
}
