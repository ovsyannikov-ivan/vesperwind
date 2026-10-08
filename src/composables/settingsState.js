import { ref } from 'vue'
import { createDefaultSettings } from '../../shared/defaultSettings.js'

// The one shared Settings value; importing it does not initialize browser theme APIs.
export const settings = ref(createDefaultSettings())
