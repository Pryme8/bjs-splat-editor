<script setup lang="ts">
import { useSceneStore } from '@/stores/sceneStore'
import { useAppStore } from '@/stores/appStore'

const sceneStore = useSceneStore()
const appStore = useAppStore()

function formatSplatCount(count: number): string {
  if (count >= 1000000) {
    return `${(count * 0.000001).toFixed(2)}M`
  }
  if (count >= 1000) {
    return `${(count * 0.001).toFixed(1)}K`
  }
  return count.toString()
}
</script>

<template>
  <div class="panel">
    <div class="quantum-panel-header">
      Scene Hierarchy
    </div>
    
    <div class="quantum-panel-content">
      <template v-if="sceneStore.objects.length > 0">
        <div
          v-for="obj in sceneStore.objects"
          :key="obj.id"
          class="scene-item"
          :class="{ selected: sceneStore.selection.objectId === obj.id }"
          @click="sceneStore.selectObject(obj.id)"
        >
          <v-btn
            :icon="obj.visible ? 'mdi-eye' : 'mdi-eye-off'"
            size="x-small"
            variant="text"
            :color="obj.visible ? 'grey' : 'grey-darken-2'"
            @click.stop="sceneStore.toggleVisibility(obj.id)"
          />
          
          <v-icon size="small" color="primary" class="mr-2">
            mdi-grain
          </v-icon>
          
          <span class="item-name">{{ obj.name }}</span>
          
          <span class="item-count mono">
            {{ formatSplatCount(obj.splatCount) }}
          </span>
        </div>
      </template>
      
      <div v-else class="empty-message">
        <v-icon size="32" color="grey-darken-2" class="mb-2">
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
.panel {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.quantum-panel-content {
  flex: 1;
  overflow-y: auto;
}

.scene-item {
  display: flex;
  align-items: center;
  padding: 8px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.15s ease;
  
  &:hover {
    background: #252532;
  }
  
  &.selected {
    background: rgba(#6B8AFF, 0.15);
    border: 1px solid rgba(#6B8AFF, 0.3);
  }
}

.item-name {
  flex: 1;
  font-size: 0.875rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.item-count {
  font-size: 0.75rem;
  color: #9898A8;
  margin-left: 8px;
}

.empty-message {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 48px 24px;
  color: #5A5A6A;
  text-align: center;
}
</style>
