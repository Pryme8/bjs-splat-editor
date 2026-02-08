import { defineStore } from 'pinia'
import { ref } from 'vue'

export interface AppNotification {
  id: number
  message: string
  duration: number  // ms, 0 = click to dismiss
  createdAt: number
}

let nextId = 1

export const useNotificationStore = defineStore('notification', () => {
  const notifications = ref<AppNotification[]>([])
  const timers = new Map<number, ReturnType<typeof setTimeout>>()

  function Push(message: string, duration = 2600) {
    const id = nextId++
    const notification: AppNotification = {
      id,
      message,
      duration,
      createdAt: Date.now()
    }

    // Add to front of the stack (newest first)
    notifications.value.unshift(notification)

    // Auto-dismiss if duration > 0
    if (duration > 0) {
      const timer = setTimeout(() => {
        Dismiss(id)
      }, duration)
      timers.set(id, timer)
    }

    return id
  }

  function Dismiss(id: number) {
    const timer = timers.get(id)
    if (timer) {
      clearTimeout(timer)
      timers.delete(id)
    }
    notifications.value = notifications.value.filter(n => n.id !== id)
  }

  function ClearAll() {
    for (const timer of timers.values()) {
      clearTimeout(timer)
    }
    timers.clear()
    notifications.value = []
  }

  return {
    notifications,
    Push,
    Dismiss,
    ClearAll
  }
})
