import { createApp } from 'vue'
import 'bootstrap/dist/css/bootstrap.min.css'
import '@mdi/font/css/materialdesignicons.min.css'
import '../styles/scrollbar.css'
import './media-overlay.css'
import '../styles/dropdown.css'
import MediaOverlay from './MediaOverlay.vue'
import { runtime } from '../api/runtime.js'
import { installDesktopContextMenuPolicy } from '../utils/desktopContextMenuPolicy.js'

installDesktopContextMenuPolicy()
void runtime.getInfo()
createApp(MediaOverlay).mount('#media-overlay-app')
