<script setup lang="ts">
import { computed, watch } from 'vue'
import { useSplatEditor } from '@/composables/useSplatEditor'

const editor = useSplatEditor()

// Use computed refs that bind to the store
const positionX = computed({
  get: () => editor.splatTransform.value.position.x,
  set: (val) => editor.updatePosition('x', val)
})
const positionY = computed({
  get: () => editor.splatTransform.value.position.y,
  set: (val) => editor.updatePosition('y', val)
})
const positionZ = computed({
  get: () => editor.splatTransform.value.position.z,
  set: (val) => editor.updatePosition('z', val)
})

const rotationX = computed({
  get: () => editor.splatTransform.value.rotation.x,
  set: (val) => editor.updateRotation('x', val)
})
const rotationY = computed({
  get: () => editor.splatTransform.value.rotation.y,
  set: (val) => editor.updateRotation('y', val)
})
const rotationZ = computed({
  get: () => editor.splatTransform.value.rotation.z,
  set: (val) => editor.updateRotation('z', val)
})

const scaleX = computed({
  get: () => editor.splatTransform.value.scale.x,
  set: (val) => editor.updateScale('x', val)
})
const scaleY = computed({
  get: () => editor.splatTransform.value.scale.y,
  set: (val) => editor.updateScale('y', val)
})
const scaleZ = computed({
  get: () => editor.splatTransform.value.scale.z,
  set: (val) => editor.updateScale('z', val)
})

const hasScene = computed(() => editor.hasScene.value)
</script>

<template>
  <div class="panel">
    <div class="quantum-panel-header">
      Properties
    </div>
    
    <div class="quantum-panel-content">
      <template v-if="hasScene">
        <!-- Position -->
        <div class="property-group">
          <div class="property-label">
            <v-icon size="small" class="mr-1">mdi-axis-arrow</v-icon>
            Position
          </div>
          <div class="vector-inputs">
            <div class="vector-input">
              <span class="axis-label x">X</span>
              <v-text-field
                v-model.number="positionX"
                type="number"
                step="0.1"
                hide-details
                density="compact"
                class="mono-input"
              />
            </div>
            <div class="vector-input">
              <span class="axis-label y">Y</span>
              <v-text-field
                v-model.number="positionY"
                type="number"
                step="0.1"
                hide-details
                density="compact"
                class="mono-input"
              />
            </div>
            <div class="vector-input">
              <span class="axis-label z">Z</span>
              <v-text-field
                v-model.number="positionZ"
                type="number"
                step="0.1"
                hide-details
                density="compact"
                class="mono-input"
              />
            </div>
          </div>
        </div>
        
        <!-- Rotation -->
        <div class="property-group">
          <div class="property-label">
            <v-icon size="small" class="mr-1">mdi-rotate-3d-variant</v-icon>
            Rotation (degrees)
          </div>
          <div class="vector-inputs">
            <div class="vector-input">
              <span class="axis-label x">X</span>
              <v-text-field
                v-model.number="rotationX"
                type="number"
                step="1"
                hide-details
                density="compact"
                class="mono-input"
              />
            </div>
            <div class="vector-input">
              <span class="axis-label y">Y</span>
              <v-text-field
                v-model.number="rotationY"
                type="number"
                step="1"
                hide-details
                density="compact"
                class="mono-input"
              />
            </div>
            <div class="vector-input">
              <span class="axis-label z">Z</span>
              <v-text-field
                v-model.number="rotationZ"
                type="number"
                step="1"
                hide-details
                density="compact"
                class="mono-input"
              />
            </div>
          </div>
        </div>
        
        <!-- Scale -->
        <div class="property-group">
          <div class="property-label">
            <v-icon size="small" class="mr-1">mdi-resize</v-icon>
            Scale
          </div>
          <div class="vector-inputs">
            <div class="vector-input">
              <span class="axis-label x">X</span>
              <v-text-field
                v-model.number="scaleX"
                type="number"
                step="0.1"
                hide-details
                density="compact"
                class="mono-input"
              />
            </div>
            <div class="vector-input">
              <span class="axis-label y">Y</span>
              <v-text-field
                v-model.number="scaleY"
                type="number"
                step="0.1"
                hide-details
                density="compact"
                class="mono-input"
              />
            </div>
            <div class="vector-input">
              <span class="axis-label z">Z</span>
              <v-text-field
                v-model.number="scaleZ"
                type="number"
                step="0.1"
                hide-details
                density="compact"
                class="mono-input"
              />
            </div>
          </div>
        </div>
      </template>
      
      <div v-else class="empty-message">
        <v-icon size="32" color="grey-darken-2" class="mb-2">
          mdi-cube-scan
        </v-icon>
        <p>No splat loaded</p>
        <p class="text-caption text-grey-darken-1">
          Load a splat to edit properties
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

.property-group {
  margin-bottom: 16px;
  padding-bottom: 16px;
  border-bottom: 1px solid #3A3A4A;
  
  &:last-child {
    border-bottom: none;
  }
}

.property-label {
  display: flex;
  align-items: center;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: #9898A8;
  margin-bottom: 8px;
}

.vector-inputs {
  display: flex;
  gap: 8px;
}

.vector-input {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 4px;
}

.axis-label {
  font-size: 0.75rem;
  font-weight: 600;
  width: 16px;
  
  &.x { color: #FF6B6B; }
  &.y { color: #4ECDC4; }
  &.z { color: #6B8AFF; }
}

.mono-input {
  :deep(input) {
    font-family: 'JetBrains Mono', 'Consolas', monospace;
    font-size: 0.875rem;
  }
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
