import { createApp } from 'vue'
import 'bootstrap/dist/css/bootstrap.min.css'
import '@mdi/font/css/materialdesignicons.min.css'
import '@xterm/xterm/css/xterm.css'
import './styles/main.css'
import App from './App.vue'

createApp(App).mount('#app')

if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((error) => {
      console.warn(`Unable to register the Vesperwind service worker: ${error.message}`)
    })
  })
}
