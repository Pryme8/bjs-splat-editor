import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export type LogLevel = 'info' | 'warn' | 'error'

export interface ConsoleMessage {
  timestamp: number
  level: LogLevel
  message: string
  source?: string
}

const MAX_MESSAGES = 200

export const useConsoleStore = defineStore('console', () => {
  // State
  const messages = ref<ConsoleMessage[]>([])
  const filter = ref<LogLevel | 'all'>('all')
  const isSubscribed = ref(false)

  // Computed
  const filteredMessages = computed(() => {
    if (filter.value === 'all') {
      return messages.value
    }
    return messages.value.filter(m => m.level === filter.value)
  })

  /**
   * Get the most recent message that looks like progress output
   * (contains "/" or "%" indicating progress like "Matching: 2578/44551" or "50%")
   */
  const lastProgressMessage = computed(() => {
    // Search from end for efficiency
    for (let i = messages.value.length - 1; i >= 0; i--) {
      const msg = messages.value[i]
      if (msg.message.includes('/') || msg.message.includes('%')) {
        return msg
      }
    }
    return null
  })

  /**
   * Get just the most recent message
   */
  const lastMessage = computed(() => {
    return messages.value.length > 0 ? messages.value[messages.value.length - 1] : null
  })

  // Actions
  function addMessage(msg: ConsoleMessage): void {
    messages.value.push(msg)
    // Keep only last MAX_MESSAGES
    if (messages.value.length > MAX_MESSAGES) {
      messages.value.shift()
    }
  }

  function addMessages(msgs: ConsoleMessage[]): void {
    // Add multiple messages (e.g., history on subscribe)
    for (const msg of msgs) {
      messages.value.push(msg)
    }
    // Trim to MAX_MESSAGES
    while (messages.value.length > MAX_MESSAGES) {
      messages.value.shift()
    }
  }

  function clear(): void {
    messages.value = []
  }

  function setFilter(level: LogLevel | 'all'): void {
    filter.value = level
  }

  function setSubscribed(value: boolean): void {
    isSubscribed.value = value
  }

  return {
    // State
    messages,
    filter,
    isSubscribed,
    
    // Computed
    filteredMessages,
    lastProgressMessage,
    lastMessage,
    
    // Actions
    addMessage,
    addMessages,
    clear,
    setFilter,
    setSubscribed
  }
})
