<script setup lang="ts">
import { useAppStore } from '@/stores/appStore'
import { computed } from 'vue'

const appStore = useAppStore()

const fileInfo = computed(() => {
  if (!appStore.currentFile) return null
  const size = appStore.currentFile.size
  const sizeStr = size > 1024 * 1024 
    ? `${(size / (1024 * 1024)).toFixed(2)} MB`
    : `${(size / 1024).toFixed(2)} KB`
  return {
    name: appStore.currentFile.name,
    type: appStore.currentFile.type.toUpperCase(),
    size: sizeStr
  }
})
</script>

<template>
  <div class="panel">
    <div class="quantum-panel-header">
      File Info
    </div>
    
    <div class="quantum-panel-content">
      <template v-if="fileInfo">
        <div class="info-row">
          <span class="info-label">Name</span>
          <span class="info-value">{{ fileInfo.name }}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Format</span>
          <span class="info-value mono">{{ fileInfo.type }}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Size</span>
          <span class="info-value mono">{{ fileInfo.size }}</span>
        </div>
      </template>
      
      <div v-else class="empty-message">
        No file loaded
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.panel {
  height: 100%;
}

.info-row {
  display: flex;
  justify-content: space-between;
  padding: 8px 0;
  border-bottom: 1px solid #3A3A4A;
  
  &:last-child {
    border-bottom: none;
  }
}

.info-label {
  color: #9898A8;
  font-size: 0.875rem;
}

.info-value {
  color: #E8E8F0;
  font-size: 0.875rem;
}

.empty-message {
  color: #5A5A6A;
  text-align: center;
  padding: 24px;
}
</style>
