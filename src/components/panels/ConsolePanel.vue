<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { useConsoleStore, type LogLevel } from '@/stores/consoleStore'
import { BackendApi } from '@/services/BackendApi'

const consoleStore = useConsoleStore()
const logContainer = ref<HTMLElement | null>(null)
const autoScroll = ref(true)

// Filter options
const filterOptions = [
  { title: 'All', value: 'all' },
  { title: 'Info', value: 'info' },
  { title: 'Warnings', value: 'warn' },
  { title: 'Errors', value: 'error' }
]

// Format timestamp
function formatTime(timestamp: number): string {
  const date = new Date(timestamp)
  return date.toLocaleTimeString('en-US', { 
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

// Get level color class
function getLevelClass(level: LogLevel): string {
  switch (level) {
    case 'warn': return 'log-warn'
    case 'error': return 'log-error'
    default: return 'log-info'
  }
}

// Auto-scroll when new messages arrive
watch(() => consoleStore.messages.length, () => {
  if (autoScroll.value) {
    nextTick(() => {
      if (logContainer.value) {
        logContainer.value.scrollTop = logContainer.value.scrollHeight
      }
    })
  }
})

// Subscribe to console on mount
onMounted(() => {
  BackendApi.SubscribeToConsole(
    (msg) => consoleStore.addMessage(msg),
    (msgs) => consoleStore.addMessages(msgs)
  )
  consoleStore.setSubscribed(true)
})

// Unsubscribe on unmount
onUnmounted(() => {
  BackendApi.UnsubscribeFromConsole()
  consoleStore.setSubscribed(false)
})

// Handle manual scroll - disable auto-scroll if user scrolls up
function handleScroll() {
  if (!logContainer.value) return
  const { scrollTop, scrollHeight, clientHeight } = logContainer.value
  // Consider "at bottom" if within 50px of bottom
  autoScroll.value = scrollTop + clientHeight >= scrollHeight - 50
}
</script>

<template>
  <div class="console-panel">
    <div class="console-header">
      <span class="console-title">Console</span>
      <div class="console-controls">
        <v-select
          v-model="consoleStore.filter"
          :items="filterOptions"
          item-title="title"
          item-value="value"
          density="compact"
          variant="outlined"
          hide-details
          class="filter-select"
        />
        <v-btn
          icon="mdi-delete"
          size="x-small"
          variant="text"
          @click="consoleStore.clear()"
          title="Clear console"
        />
        <v-btn
          :icon="autoScroll ? 'mdi-arrow-down-bold' : 'mdi-arrow-down-bold-outline'"
          size="x-small"
          variant="text"
          :color="autoScroll ? 'primary' : undefined"
          @click="autoScroll = !autoScroll"
          title="Auto-scroll"
        />
      </div>
    </div>
    
    <div 
      ref="logContainer" 
      class="log-container"
      @scroll="handleScroll"
    >
      <div
        v-for="(msg, idx) in consoleStore.filteredMessages"
        :key="idx"
        :class="['log-line', getLevelClass(msg.level)]"
      >
        <span class="log-time">{{ formatTime(msg.timestamp) }}</span>
        <span v-if="msg.source" class="log-source">[{{ msg.source }}]</span>
        <span class="log-message">{{ msg.message }}</span>
      </div>
      
      <div v-if="consoleStore.messages.length === 0" class="log-empty">
        No messages yet. Backend logs will appear here.
      </div>
    </div>
  </div>
</template>

<style scoped>
.console-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: #1a1a24;
  border-top: 1px solid #2a2a3a;
}

.console-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  background: #1e1e2e;
  border-bottom: 1px solid #2a2a3a;
  min-height: 36px;
}

.console-title {
  font-size: 0.8rem;
  font-weight: 500;
  color: #c0c0d0;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.console-controls {
  display: flex;
  align-items: center;
  gap: 4px;
}

.filter-select {
  width: 100px;
  font-size: 0.75rem;
}

.filter-select :deep(.v-field) {
  min-height: 24px !important;
}

.filter-select :deep(.v-field__input) {
  padding: 2px 8px;
  font-size: 0.75rem;
}

.log-container {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 8px;
  font-family: 'JetBrains Mono', 'Fira Code', 'Consolas', monospace;
  font-size: 0.72rem;
  line-height: 1.5;
}

.log-line {
  display: flex;
  gap: 8px;
  padding: 1px 4px;
  border-radius: 2px;
  white-space: nowrap;
}

.log-line:hover {
  background: rgba(255, 255, 255, 0.03);
}

.log-time {
  color: #606080;
  flex-shrink: 0;
}

.log-source {
  color: #7070a0;
  flex-shrink: 0;
}

.log-message {
  color: #a0a0b0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.log-info .log-message {
  color: #a0a0b0;
}

.log-warn .log-message {
  color: #d4a72c;
}

.log-warn .log-source {
  color: #d4a72c;
}

.log-error .log-message {
  color: #d44a4a;
}

.log-error .log-source {
  color: #d44a4a;
}

.log-empty {
  color: #505060;
  font-style: italic;
  padding: 20px;
  text-align: center;
}

/* Scrollbar styling */
.log-container::-webkit-scrollbar {
  width: 6px;
}

.log-container::-webkit-scrollbar-track {
  background: transparent;
}

.log-container::-webkit-scrollbar-thumb {
  background: #3a3a4a;
  border-radius: 3px;
}

.log-container::-webkit-scrollbar-thumb:hover {
  background: #4a4a5a;
}
</style>
