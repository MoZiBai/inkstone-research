export const MIN_PDF_SCALE = 0.55
export const MAX_PDF_SCALE = 5
export const PDF_SCALE_STEP = 0.1

export function clampPdfScale(value: number): number {
  return Math.round(Math.max(MIN_PDF_SCALE, Math.min(MAX_PDF_SCALE, value)) * 100) / 100
}

export function scaleFromCtrlWheel(currentScale: number, deltaY: number): number {
  if (deltaY === 0) return clampPdfScale(currentScale)
  const factor = deltaY < 0 ? 1.1 : 1 / 1.1
  return clampPdfScale(currentScale * factor)
}

export function scaleFromStep(currentScale: number, direction: -1 | 1): number {
  return clampPdfScale(currentScale + direction * PDF_SCALE_STEP)
}
