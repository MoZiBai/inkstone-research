import { useState } from 'react'
import { Modal } from './Modal'

export function CloseApplicationDialog({ busy, onHide, onExit, onClose }: {
  busy: boolean
  onHide: () => Promise<void>
  onExit: () => Promise<void>
  onClose: () => void
}): React.JSX.Element {
  const [working, setWorking] = useState(false)
  const [discarding, setDiscarding] = useState(false)
  const [error, setError] = useState('')
  const hasDraft = Boolean(document.querySelector('[data-unsaved="true"]'))
  const blocked = busy || working

  const exit = async (): Promise<void> => {
    if (busy || document.querySelector('[data-operation-busy="true"]')) {
      setError('任务正在进行，请等待完成后再退出。')
      return
    }
    if (!discarding && document.querySelector('[data-unsaved="true"]')) {
      setDiscarding(true)
      return
    }
    setWorking(true)
    try { await onExit() }
    catch (reason) { setError(String(reason)); setWorking(false) }
  }

  return (
    <Modal title={discarding ? '放弃未保存的修改并退出？' : '关闭砚台'} width="small" onClose={() => { if (!working) onClose() }}>
      <p className="confirm-description">
        {discarding
          ? '未保存的编辑将丢失。已保存的卡片、批注和整理结果不受影响。'
          : hasDraft
            ? '当前有未保存的编辑。隐藏到后台会保留窗口与编辑内容。'
            : '隐藏到后台后自动备份继续运行；完全退出后停止，下次启动重新计时。'}
      </p>
      {busy ? <p role="status">正在完成操作，请稍候再退出。</p> : null}
      {error ? <p role="alert" className="backup-manager-warning">{error}</p> : null}
      <div className="modal-actions">
        <button className="button ghost" type="button" disabled={working} onClick={onClose}>继续使用</button>
        {!discarding ? <button className="button ghost" type="button" disabled={blocked} onClick={() => {
          setWorking(true)
          void onHide().then(onClose).catch((reason) => { setError(String(reason)); setWorking(false) })
        }}>隐藏到后台</button> : null}
        <button className={discarding ? 'button danger' : 'button primary'} type="button" disabled={blocked} onClick={() => void exit()}>
          {discarding ? '放弃修改并退出' : '直接退出'}
        </button>
      </div>
    </Modal>
  )
}
