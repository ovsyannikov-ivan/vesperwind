import { createApp } from 'vue'
import 'bootstrap/dist/css/bootstrap.min.css'
import '@mdi/font/css/materialdesignicons.min.css'
import '../styles/scrollbar.scss'
import './media-overlay.scss'
import '../styles/dropdown.scss'
import MediaOverlay from './MediaOverlay.vue'
import { runtime } from '../api/runtime.js'
import { installDesktopContextMenuPolicy } from '../utils/desktopContextMenuPolicy.js'

installDesktopContextMenuPolicy()
void runtime.getInfo()
createApp(MediaOverlay).mount('#media-overlay-app')
