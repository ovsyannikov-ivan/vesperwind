import { ref } from 'vue'

// Errors from asynchronous desktop actions (drag out, staging, clipboard)
// that have no dialog of their own are shown in the file operation dialog.
const notice = ref(null)

export const showNotice = (title, error) => {
  notice.value = {
    title,
    message: typeof error === 'string' ? error : error?.message || 'The action failed',
  }
}

export const useNotice = () => ({ notice, showNotice, clearNotice: () => { notice.value = null } })
