<script setup lang="ts">
import { useSceneStore } from '@/stores/sceneStore'
import { useEditorStore } from '@/stores/editorStore'
import { useBabylon } from '@/composables/useBabylon'

const sceneStore = useSceneStore()
const editorStore = useEditorStore()
const babylon = useBabylon()

function formatSplatCount(count: number): string {
  if (count >= 1000000) {
    return `${(count * 0.000001).toFixed(2)}M`
  }
  if (count >= 1000) {
    return `${(count * 0.001).toFixed(1)}K`
  }
  return count.toString()
}

function selectObject(id: string) {
  editorStore.setActiveObject(id)
  sceneStore.selectObject(id)
}

function toggleVisibility(id: string) {
  babylon.toggleSplatVisibility(id)
}

function deleteObject(id: string) {
  babylon.removeSplat(id)
}

function isActive(id: string): boolean {
  return editorStore.activeObjectId === id
}
</script>

<template>
  <div class="hierarchy-panel">
    <div class="panel-header">
      <v-icon size="small" class="mr-2">mdi-file-tree</v-icon>
      Hierarchy
    </div>
    
    <div class="panel-content">
      <template v-if="sceneStore.objects.length > 0">
        <div
          v-for="obj in sceneStore.objects"
          :key="obj.id"
          class="hierarchy-item"
          :class="{ active: isActive(obj.id), preview: obj.isPreview }"
          @click="selectObject(obj.id)"
        >
          <v-btn
            :icon="obj.visible ? 'mdi-eye' : 'mdi-eye-off'"
            size="x-small"
            variant="text"
            :color="obj.visible ? 'grey' : 'grey-darken-2'"
            @click.stop="toggleVisibility(obj.id)"
          />
          
          <v-icon size="small" :color="obj.isPreview ? 'warning' : 'primary'" class="mr-2">
            {{ obj.isPreview ? 'mdi-progress-clock' : 'mdi-grain' }}
          </v-icon>
          
          <span class="item-name">{{ obj.name }}</span>
          
          <span class="item-count mono">
            {{ formatSplatCount(obj.splatCount) }}
          </span>
          
          <v-btn
            v-if="!obj.isPreview"
            icon="mdi-delete-outline"
            size="x-small"
            variant="text"
            color="error"
            class="delete-btn"
            @click.stop="deleteObject(obj.id)"
          />
        </div>
      </template>
      
      <div v-else class="empty-message">
        <v-icon size="28" color="grey-darken-2" class="mb-2">
          mdi-folder-open-outline
        </v-icon>
        <p>No splats loaded</p>
        <p class="text-caption text-grey-darken-1">
          Import a file to begin
        </p>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.hierarchy-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: #1A1A24;
}

.panel-header {
  display: flex;
  align-items: center;
  padding: 10px 12px;
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: #9898A8;
  border-bottom: 1px solid #3A3A4A;
  flex-shrink: 0;
}

.panel-content {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}

.hierarchy-item {
  display: flex;
  align-items: center;
  padding: 6px 8px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.15s ease;
  margin-bottom: 2px;
  
  &:hover {
    background: #252532;
    
    .delete-btn {
      opacity: 1;
    }
  }
  
  &.active {
    background: rgba(#6B8AFF, 0.15);
    border: 1px solid rgba(#6B8AFF, 0.3);
    margin: -1px;
    margin-bottom: 1px;
  }
  
  &.preview {
    opacity: 0.7;
  }
}

.item-name {
  flex: 1;
  font-size: 0.8125rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.item-count {
  font-size: 0.6875rem;
  color: #7A7A8A;
  margin-left: 8px;
  margin-right: 4px;
}

.delete-btn {
  opacity: 0;
  transition: opacity 0.15s ease;
  margin-left: 4px;
}

.empty-message {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 32px 16px;
  color: #5A5A6A;
  text-align: center;
  font-size: 0.8125rem;
}
</style>
