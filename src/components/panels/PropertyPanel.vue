<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted, watch } from 'vue'
import { useSplatEditor } from '@/composables/useSplatEditor'
import { useBabylon } from '@/composables/useBabylon'
import DragNumberInput from '@/components/common/DragNumberInput.vue'

const editor = useSplatEditor()
const babylon = useBabylon()

// Create a reactive transform that reads directly from the mesh
const meshTransform = ref({
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0 },
  scale: { x: 1, y: 1, z: 1 }
})

// Scale lock state for uniform scaling
const scaleUniformLocked = ref(true)

// Watch for lock state changes - when locked, sync Y and Z to X
watch(scaleUniformLocked, (isLocked, wasLocked) => {
  if (isLocked && !wasLocked) {
    // Just became locked - sync Y and Z to match X
    const xValue = meshTransform.value.scale.x
    editor.updateScale('y', xValue)
    editor.updateScale('z', xValue)
  }
})

// Poll the mesh transform to keep UI in sync
let pollInterval: number | null = null

function updateMeshTransform() {
  const transform = babylon.getMeshTransform()
  if (transform) {
    meshTransform.value = transform
  }
}

onMounted(() => {
  // Update immediately
  updateMeshTransform()
  
  // Poll at 60fps to keep in sync with Babylon updates
  pollInterval = window.setInterval(updateMeshTransform, 16)
})

onUnmounted(() => {
  if (pollInterval !== null) {
    clearInterval(pollInterval)
    pollInterval = null
  }
})

// Computed refs that bind directly to the mesh
const positionX = computed({
  get: () => meshTransform.value.position.x,
  set: (val) => editor.updatePosition('x', val)
})
const positionY = computed({
  get: () => meshTransform.value.position.y,
  set: (val) => editor.updatePosition('y', val)
})
const positionZ = computed({
  get: () => meshTransform.value.position.z,
  set: (val) => editor.updatePosition('z', val)
})

const rotationX = computed({
  get: () => meshTransform.value.rotation.x,
  set: (val) => editor.updateRotation('x', val)
})
const rotationY = computed({
  get: () => meshTransform.value.rotation.y,
  set: (val) => editor.updateRotation('y', val)
})
const rotationZ = computed({
  get: () => meshTransform.value.rotation.z,
  set: (val) => editor.updateRotation('z', val)
})

const scaleX = computed({
  get: () => meshTransform.value.scale.x,
  set: (val) => {
    if (scaleUniformLocked.value) {
      editor.updateScale('x', val)
      editor.updateScale('y', val)
      editor.updateScale('z', val)
    } else {
      editor.updateScale('x', val)
    }
  }
})
const scaleY = computed({
  get: () => meshTransform.value.scale.y,
  set: (val) => {
    if (scaleUniformLocked.value) {
      editor.updateScale('x', val)
      editor.updateScale('y', val)
      editor.updateScale('z', val)
    } else {
      editor.updateScale('y', val)
    }
  }
})
const scaleZ = computed({
  get: () => meshTransform.value.scale.z,
  set: (val) => {
    if (scaleUniformLocked.value) {
      editor.updateScale('x', val)
      editor.updateScale('y', val)
      editor.updateScale('z', val)
    } else {
      editor.updateScale('z', val)
    }
  }
})

// Uniform scale value (uses X as the primary value)
const uniformScale = computed({
  get: () => meshTransform.value.scale.x,
  set: (val) => {
    editor.updateScale('x', val)
    editor.updateScale('y', val)
    editor.updateScale('z', val)
  }
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
              <DragNumberInput
                v-model="positionX"
                :step="0.1"
                class="mono-input"
              />
            </div>
            <div class="vector-input">
              <span class="axis-label y">Y</span>
              <DragNumberInput
                v-model="positionY"
                :step="0.1"
                class="mono-input"
              />
            </div>
            <div class="vector-input">
              <span class="axis-label z">Z</span>
              <DragNumberInput
                v-model="positionZ"
                :step="0.1"
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
              <DragNumberInput
                v-model="rotationX"
                :step="1"
                class="mono-input"
              />
            </div>
            <div class="vector-input">
              <span class="axis-label y">Y</span>
              <DragNumberInput
                v-model="rotationY"
                :step="1"
                class="mono-input"
              />
            </div>
            <div class="vector-input">
              <span class="axis-label z">Z</span>
              <DragNumberInput
                v-model="rotationZ"
                :step="1"
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
            <v-btn
              :icon="scaleUniformLocked ? 'mdi-link-variant' : 'mdi-link-variant-off'"
              size="x-small"
              variant="text"
              :color="scaleUniformLocked ? 'primary' : undefined"
              @click="scaleUniformLocked = !scaleUniformLocked"
              class="lock-button"
              :title="scaleUniformLocked ? 'Unlock for non-uniform scaling' : 'Lock for uniform scaling'"
            />
          </div>
          
          <!-- Uniform Scale (locked) -->
          <div v-if="scaleUniformLocked" class="uniform-scale-input">
            <span class="uniform-label">Uniform</span>
            <DragNumberInput
              v-model="uniformScale"
              :step="0.1"
              :min="0.01"
              class="mono-input"
            />
          </div>
          
          <!-- Individual Scales (unlocked) -->
          <div v-else class="vector-inputs">
            <div class="vector-input">
              <span class="axis-label x">X</span>
              <DragNumberInput
                v-model="scaleX"
                :step="0.1"
                :min="0.01"
                class="mono-input"
              />
            </div>
            <div class="vector-input">
              <span class="axis-label y">Y</span>
              <DragNumberInput
                v-model="scaleY"
                :step="0.1"
                :min="0.01"
                class="mono-input"
              />
            </div>
            <div class="vector-input">
              <span class="axis-label z">Z</span>
              <DragNumberInput
                v-model="scaleZ"
                :step="0.1"
                :min="0.01"
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
  
  .lock-button {
    margin-left: auto;
    opacity: 0.6;
    transition: opacity 0.2s ease;
    
    &:hover {
      opacity: 1;
    }
  }
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

.uniform-scale-input {
  display: flex;
  align-items: center;
  gap: 8px;
}

.uniform-label {
  font-size: 0.75rem;
  font-weight: 600;
  color: #9898A8;
  min-width: 60px;
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
