<script setup lang="ts">
import { useSplatEditor } from '@/composables/useSplatEditor'

const editor = useSplatEditor()
</script>

<template>
  <div class="panel">
    <div class="quantum-panel-header">
      View Helpers
    </div>
    
    <div class="quantum-panel-content">
      <!-- View Helpers Section -->
      <div class="section">
        <div class="toggle-row">
          <v-switch
            :model-value="editor.showAxes.value"
            @update:model-value="editor.toggleAxes"
            density="compact"
            hide-details
            color="primary"
          />
          <div class="toggle-label">
            <v-icon size="small" class="mr-2">mdi-axis-arrow</v-icon>
            Show Axes
          </div>
        </div>
        
        <div class="toggle-row">
          <v-switch
            :model-value="editor.showGroundPlane.value"
            @update:model-value="editor.toggleGroundPlane"
            density="compact"
            hide-details
            color="primary"
          />
          <div class="toggle-label">
            <v-icon size="small" class="mr-2">mdi-grid</v-icon>
            Ground Plane
          </div>
        </div>
        
        <div v-if="editor.showGroundPlane.value" class="slider-row">
          <span class="slider-label">Size</span>
          <v-slider
            :model-value="editor.groundPlaneSize.value"
            @update:model-value="editor.setGroundPlaneSize"
            :min="5"
            :max="50"
            :step="5"
            hide-details
            density="compact"
            thumb-label
          />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.section {
  margin-bottom: 16px;
  
  &:last-child {
    margin-bottom: 0;
  }
}

.toggle-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
  padding: 4px 0;
}

.toggle-label {
  display: flex;
  align-items: center;
  font-size: 0.875rem;
  color: #E8E8F8;
}

.slider-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-left: 48px;
  margin-top: -4px;
  margin-bottom: 12px;
}

.slider-label {
  font-size: 0.75rem;
  color: #9898A8;
  min-width: 40px;
}
</style>
