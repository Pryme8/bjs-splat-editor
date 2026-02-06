<script setup lang="ts">
import HierarchyPanel from '@/components/panels/HierarchyPanel.vue'
import PropertyPanel from '@/components/panels/PropertyPanel.vue'
</script>

<template>
  <aside class="right-panel">
    <div class="hierarchy-section">
      <HierarchyPanel />
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

.hierarchy-section {
  flex: 0 0 50%;
  min-height: 0;
  max-height: 50%;
  overflow: hidden;
  border-bottom: 1px solid #3A3A4A;
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
