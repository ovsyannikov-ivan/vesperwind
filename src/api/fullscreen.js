import { getCurrentWindow } from '@tauri-apps/api/window'
import { backendRuntimeMode } from './backend.js'

let nativeTarget = null
const listeners = new Set()
const notify = () => { for (const listener of listeners) listener(fullscreen.isActive()) }
const clearNativeTarget = () => { nativeTarget?.classList.remove('is-runtime-fullscreen'); nativeTarget = null }

const enter = async (element) => {
  if (!element) return false
  if (backendRuntimeMode === 'tauri') {
    clearNativeTarget()
    nativeTarget = element
    element.classList.add('is-runtime-fullscreen')
    try {
      await getCurrentWindow().setFullscreen(true)
      notify()
      return true
    } catch {
      clearNativeTarget()
      notify()
      return false
    }
  }
  await element.requestFullscreen?.()
  return document.fullscreenElement === element
}

const exit = async () => {
  if (nativeTarget) {
    try {
      await getCurrentWindow().setFullscreen(false)
      clearNativeTarget()
      notify()
      return true
    } catch {
      return false
    }
  }
  if (document.fullscreenElement) await document.exitFullscreen?.()
  return true
}

export const fullscreen = Object.freeze({
  enter,
  exit,
  toggle: (element) => fullscreen.isActive() ? exit() : enter(element),
  isActive: () => Boolean(nativeTarget || document.fullscreenElement),
  onChange: (listener) => {
    listeners.add(listener)
    const handleBrowserChange = () => listener(fullscreen.isActive())
    document.addEventListener('fullscreenchange', handleBrowserChange)
    return () => { listeners.delete(listener); document.removeEventListener('fullscreenchange', handleBrowserChange) }
  },
})
