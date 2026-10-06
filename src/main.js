import { createApp } from 'vue'
import 'bootstrap/dist/css/bootstrap.min.css'
import '@mdi/font/css/materialdesignicons.min.css'
import '@xterm/xterm/css/xterm.css'
import './styles/scrollbar.scss'
import './styles/main.scss'
import './styles/dropdown.scss'
import App from './App.vue'
import { runtime } from './api/runtime.js'
import { installDesktopContextMenuPolicy } from './utils/desktopContextMenuPolicy.js'

installDesktopContextMenuPolicy()
void runtime.getInfo()
createApp(App).mount('#app')

// Let the mounted interface paint before fading out the early HTML preloader.
requestAnimationFrame(() => requestAnimationFrame(() => {
  const startup = document.getElementById('app-startup')
  startup?.classList.add('is-ready')
  window.setTimeout(() => startup?.remove(), 200)
}))

if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((error) => {
      console.warn(`Unable to register the Vesperwind service worker: ${error.message}`)
    })
  })
}
