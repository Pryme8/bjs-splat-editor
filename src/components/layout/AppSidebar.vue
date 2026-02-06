<script setup lang="ts">
import { ref } from 'vue'
import GeneratorPanel from '@/components/panels/GeneratorPanel.vue'
import ToolsPanel from '@/components/panels/ToolsPanel.vue'

const activePanel = ref('tools')
</script>

<template>
  <aside class="sidebar">
    <v-tabs
      v-model="activePanel"
      density="compact"
      color="primary"
      class="sidebar-tabs"
    >
      <v-tab value="tools" size="small" title="Tools">
        <v-icon size="small">mdi-wrench</v-icon>
      </v-tab>
      <v-tab value="generator" size="small" title="Generator">
        <v-icon size="small">mdi-creation</v-icon>
      </v-tab>
    </v-tabs>
    
    <div class="sidebar-content">
      <v-window v-model="activePanel" class="panel-window">
        <v-window-item value="tools">
          <ToolsPanel />
        </v-window-item>
        
        <v-window-item value="generator">
          <GeneratorPanel />
        </v-window-item>
      </v-window>
    </div>
  </aside>
</template>

<style scoped lang="scss">
.sidebar {
  width: 300px;
  min-width: 300px;
  max-width: 300px;
  height: 100%;
  max-height: 100%;
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  background: #1A1A24;
  border-right: 1px solid #3A3A4A;
  overflow: hidden;
  contain: strict;
}

.sidebar-tabs {
  flex-shrink: 0;
  border-bottom: 1px solid #3A3A4A;
}

.sidebar-content {
  flex: 1 1 0;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  position: relative;
}

.panel-window {
  flex: 1 1 0;
  min-height: 0;
  overflow: hidden;
  position: absolute;
  inset: 0;
}

:deep(.v-window__container) {
  height: 100%;
  overflow: hidden;
}

:deep(.v-window-item) {
  height: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: contain;
}
</style>
