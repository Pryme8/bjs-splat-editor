<script setup lang="ts">
import { ref } from 'vue'
import HierarchyPanel from '@/components/panels/HierarchyPanel.vue'
import PropertyPanel from '@/components/panels/PropertyPanel.vue'
import WaypointPanel from '@/components/panels/WaypointPanel.vue'

const activeTab = ref<'hierarchy' | 'waypoints'>('hierarchy')
</script>

<template>
  <aside class="right-panel">
    <div class="tabbed-section">
      <div class="tabs">
        <button 
          :class="['tab', { active: activeTab === 'hierarchy' }]"
          @click="activeTab = 'hierarchy'"
          title="Hierarchy"
        >
          <v-icon size="small">mdi-file-tree</v-icon>
        </button>
        <button 
          :class="['tab', { active: activeTab === 'waypoints' }]"
          @click="activeTab = 'waypoints'"
          title="Waypoints"
        >
          <v-icon size="small">mdi-camera-marker</v-icon>
        </button>
      </div>
      
      <div class="tab-content">
        <HierarchyPanel v-if="activeTab === 'hierarchy'" />
        <WaypointPanel v-if="activeTab === 'waypoints'" />
      </div>
    </div>
    
    <div class="properties-section">
      <PropertyPanel />
    </div>
  </aside>
</template>

<style scoped lang="scss">
.right-panel {
  width: 280px;
  min-width: 280px;
  max-width: 280px;
  height: 100%;
  max-height: 100%;
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  background: #1A1A24;
  border-left: 1px solid #3A3A4A;
  overflow: hidden;
  contain: strict;
}

.tabbed-section {
  flex: 0 0 50%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-bottom: 1px solid #3A3A4A;
}

.tabs {
  display: flex;
  background: #15151D;
  border-bottom: 1px solid #3A3A4A;
  flex-shrink: 0;
}

.tab {
  flex: 1;
  padding: 8px 12px;
  background: transparent;
  border: none;
  color: #9898A8;
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  cursor: pointer;
  transition: all 0.2s;
  border-bottom: 2px solid transparent;
}

.tab:hover {
  background: #1F1F2A;
  color: #B8B8C8;
}

.tab.active {
  color: #E8E8F8;
  border-bottom-color: #4A9EFF;
  background: #1A1A24;
}

.tab-content {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.properties-section {
  flex: 1 1 50%;
  min-height: 0;
  overflow: hidden;
  
  :deep(.panel) {
    height: 100%;
  }
  
  :deep(.quantum-panel-header) {
    display: flex;
    align-items: center;
    padding: 10px 12px;
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: #9898A8;
    border-bottom: 1px solid #3A3A4A;
  }
  
  :deep(.quantum-panel-content) {
    padding: 12px;
  }
}
</style>
