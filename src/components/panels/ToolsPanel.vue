<script setup lang="ts">
import { useSplatEditor } from '@/composables/useSplatEditor'

const editor = useSplatEditor()
</script>

<template>
  <div class="panel">
    <div class="quantum-panel-header">
      Tools
    </div>
    
    <div class="quantum-panel-content">
      <!-- View Helpers Section -->
      <div class="section">
        <div class="section-title">View Helpers</div>
        
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
      
      <!-- Orientation Section -->
      <div class="section">
        <div class="section-title">Orientation</div>
        
        <div class="quick-rotate">
          <span class="quick-label">Quick Rotate 90°</span>
          <div class="rotate-buttons">
            <v-btn
              size="small"
              variant="outlined"
              :disabled="!editor.hasScene.value"
              @click="editor.rotateX90"
            >
              <span class="axis-x">X</span>
            </v-btn>
            <v-btn
              size="small"
              variant="outlined"
              :disabled="!editor.hasScene.value"
              @click="editor.rotateY90"
            >
              <span class="axis-y">Y</span>
            </v-btn>
            <v-btn
              size="small"
              variant="outlined"
              :disabled="!editor.hasScene.value"
              @click="editor.rotateZ90"
            >
              <span class="axis-z">Z</span>
            </v-btn>
          </div>
        </div>
        
        <v-btn
          block
          variant="tonal"
          size="small"
          prepend-icon="mdi-restore"
          :disabled="!editor.hasScene.value"
          @click="editor.resetTransform"
          class="mt-2"
        >
          Reset Orientation
        </v-btn>
      </div>
      
      <!-- Bake Transform Section -->
      <div class="section">
        <div class="section-title">Origin / Bake</div>
        
        <v-btn
          block
          variant="tonal"
          size="small"
          prepend-icon="mdi-target"
          :disabled="!editor.hasScene.value"
          @click="editor.centerSplatAtOrigin"
          class="mb-2"
        >
          Center at Origin
        </v-btn>
        
        <v-btn
          block
          variant="tonal"
          size="small"
          prepend-icon="mdi-cube-send"
          :disabled="!editor.hasScene.value"
          @click="editor.bakeTransform"
        >
          Bake Transform
        </v-btn>
        
        <div class="bake-hint">
          Applies current transforms to vertices
        </div>
      </div>
      
      <!-- Gizmo Section -->
      <div class="section">
        <div class="section-title">Transform Gizmo</div>
        
        <v-btn-toggle
          :model-value="editor.activeGizmo.value"
          @update:model-value="editor.setGizmo"
          mandatory
          density="compact"
          class="gizmo-toggle"
          :disabled="!editor.hasScene.value"
        >
          <v-btn value="none" size="small">
            <v-icon size="small">mdi-cursor-default</v-icon>
          </v-btn>
          <v-btn value="translate" size="small">
            <v-icon size="small">mdi-axis-arrow</v-icon>
          </v-btn>
          <v-btn value="rotate" size="small">
            <v-icon size="small">mdi-rotate-3d-variant</v-icon>
          </v-btn>
          <v-btn value="scale" size="small">
            <v-icon size="small">mdi-resize</v-icon>
          </v-btn>
        </v-btn-toggle>
        
        <!-- Transform Space Toggle -->
        <div class="space-toggle">
          <span class="space-label">Space:</span>
          <v-btn-toggle
            :model-value="editor.transformSpace.value"
            @update:model-value="editor.setTransformSpace"
            mandatory
            density="compact"
            :disabled="!editor.hasScene.value || editor.activeGizmo.value === 'none'"
          >
            <v-btn value="world" size="x-small">
              <v-icon size="x-small" class="mr-1">mdi-earth</v-icon>
              World
            </v-btn>
            <v-btn value="local" size="x-small">
              <v-icon size="x-small" class="mr-1">mdi-cube-outline</v-icon>
              Local
            </v-btn>
          </v-btn-toggle>
        </div>
        
        <div class="gizmo-hint">
          <template v-if="editor.activeGizmo.value === 'none'">
            Select a gizmo to transform
          </template>
          <template v-else-if="editor.activeGizmo.value === 'translate'">
            Drag arrows to move
          </template>
          <template v-else-if="editor.activeGizmo.value === 'rotate'">
            Drag rings to rotate
          </template>
          <template v-else-if="editor.activeGizmo.value === 'scale'">
            Drag handles to scale
          </template>
        </div>
      </div>
      
      <!-- Clipping Sphere Section -->
      <div class="section">
        <div class="section-title">Clipping Sphere</div>
        
        <div class="toggle-row">
          <v-switch
            :model-value="editor.clipSphere.value.enabled"
            @update:model-value="editor.setClipSphereEnabled"
            density="compact"
            hide-details
            color="warning"
            :disabled="!editor.hasScene.value"
          />
          <div class="toggle-label">
            <v-icon size="small" class="mr-2" color="warning">mdi-sphere</v-icon>
            Enable Clip Sphere
          </div>
        </div>
        
        <template v-if="editor.clipSphere.value.enabled">
          <div class="slider-row">
            <span class="slider-label">Radius</span>
            <v-slider
              :model-value="editor.clipSphere.value.radius"
              @update:model-value="editor.setClipSphereRadius"
              :min="0.5"
              :max="50"
              :step="0.5"
              hide-details
              density="compact"
              thumb-label
              color="warning"
            />
          </div>
          
          <div class="radius-input">
            <v-text-field
              :model-value="editor.clipSphere.value.radius"
              @update:model-value="editor.setClipSphereRadius"
              type="number"
              step="0.1"
              min="0.1"
              label="Radius"
              density="compact"
              hide-details
              variant="outlined"
              class="mono-input"
            />
          </div>
          
          <div class="center-inputs">
            <span class="center-label">Center:</span>
            <div class="center-coords">
              <span class="coord-value">
                X: {{ editor.clipSphere.value.center.x.toFixed(2) }}
              </span>
              <span class="coord-value">
                Y: {{ editor.clipSphere.value.center.y.toFixed(2) }}
              </span>
              <span class="coord-value">
                Z: {{ editor.clipSphere.value.center.z.toFixed(2) }}
              </span>
            </div>
          </div>
          
          <v-btn
            block
            color="warning"
            variant="flat"
            size="small"
            prepend-icon="mdi-crop"
            :disabled="!editor.hasScene.value"
            :loading="editor.isClipping.value"
            @click="editor.applyCrop"
            class="mt-3"
          >
            Apply Crop
          </v-btn>
          
          <div v-if="editor.lastClipResult.value" class="clip-result">
            <v-icon size="small" color="success" class="mr-1">mdi-check-circle</v-icon>
            Kept {{ editor.lastClipResult.value.clippedCount.toLocaleString() }} 
            of {{ editor.lastClipResult.value.originalCount.toLocaleString() }} splats
          </div>
        </template>
      </div>
      
      <!-- Clipping Box Section -->
      <div class="section">
        <div class="section-title">Clipping Box</div>
        
        <div class="toggle-row">
          <v-switch
            :model-value="editor.clipBox.value.enabled"
            @update:model-value="editor.setClipBoxEnabled"
            density="compact"
            hide-details
            color="info"
            :disabled="!editor.hasScene.value"
          />
          <div class="toggle-label">
            <v-icon size="small" class="mr-2" color="info">mdi-cube-outline</v-icon>
            Enable Clip Box
          </div>
        </div>
        
        <template v-if="editor.clipBox.value.enabled">
          <div class="size-inputs">
            <span class="size-label">Size</span>
            <div class="size-coords">
              <v-text-field
                :model-value="editor.clipBox.value.size.x"
                @update:model-value="(v) => editor.setClipBoxSize(Number(v), editor.clipBox.value.size.y, editor.clipBox.value.size.z)"
                type="number"
                step="0.5"
                min="0.1"
                label="X"
                density="compact"
                hide-details
                variant="outlined"
                class="size-field"
              />
              <v-text-field
                :model-value="editor.clipBox.value.size.y"
                @update:model-value="(v) => editor.setClipBoxSize(editor.clipBox.value.size.x, Number(v), editor.clipBox.value.size.z)"
                type="number"
                step="0.5"
                min="0.1"
                label="Y"
                density="compact"
                hide-details
                variant="outlined"
                class="size-field"
              />
              <v-text-field
                :model-value="editor.clipBox.value.size.z"
                @update:model-value="(v) => editor.setClipBoxSize(editor.clipBox.value.size.x, editor.clipBox.value.size.y, Number(v))"
                type="number"
                step="0.5"
                min="0.1"
                label="Z"
                density="compact"
                hide-details
                variant="outlined"
                class="size-field"
              />
            </div>
          </div>
          
          <div class="center-inputs">
            <span class="center-label">Center (drag gizmo to move)</span>
            <div class="center-coords">
              <span class="coord-value">
                X: {{ editor.clipBox.value.center.x.toFixed(2) }}
              </span>
              <span class="coord-value">
                Y: {{ editor.clipBox.value.center.y.toFixed(2) }}
              </span>
              <span class="coord-value">
                Z: {{ editor.clipBox.value.center.z.toFixed(2) }}
              </span>
            </div>
          </div>
          
          <v-btn
            block
            color="info"
            variant="flat"
            size="small"
            prepend-icon="mdi-crop"
            :disabled="!editor.hasScene.value"
            :loading="editor.isClipping.value"
            @click="editor.applyBoxCrop"
            class="mt-3"
          >
            Apply Box Crop
          </v-btn>
          
          <div v-if="editor.lastClipResult.value" class="clip-result">
            <v-icon size="small" color="success" class="mr-1">mdi-check-circle</v-icon>
            Kept {{ editor.lastClipResult.value.clippedCount.toLocaleString() }} 
            of {{ editor.lastClipResult.value.originalCount.toLocaleString() }} splats
          </div>
        </template>
      </div>
      
      <!-- Camera Section -->
      <div class="section">
        <div class="section-title">Camera</div>
        
        <v-btn
          block
          variant="tonal"
          size="small"
          prepend-icon="mdi-crosshairs-gps"
          :disabled="!editor.hasScene.value"
          @click="editor.focusOnSplat"
        >
          Focus on Splat
        </v-btn>
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

.section {
  padding: 12px 0;
  border-bottom: 1px solid #3A3A4A;
  
  &:last-child {
    border-bottom: none;
  }
}

.section-title {
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: #9898A8;
  margin-bottom: 8px;
  padding: 0 12px;
}

.toggle-row {
  display: flex;
  align-items: center;
  padding: 4px 12px;
  gap: 8px;
}

.toggle-label {
  display: flex;
  align-items: center;
  font-size: 0.875rem;
}

.slider-row {
  display: flex;
  align-items: center;
  padding: 4px 12px;
  gap: 12px;
}

.slider-label {
  font-size: 0.75rem;
  color: #9898A8;
  min-width: 32px;
}

.quick-rotate {
  padding: 0 12px;
}

.quick-label {
  font-size: 0.75rem;
  color: #9898A8;
  display: block;
  margin-bottom: 8px;
}

.rotate-buttons {
  display: flex;
  gap: 8px;
  
  .v-btn {
    flex: 1;
  }
}

.axis-x { color: #FF6B6B; font-weight: 600; }
.axis-y { color: #4ECDC4; font-weight: 600; }
.axis-z { color: #6B8AFF; font-weight: 600; }

.gizmo-toggle {
  width: 100%;
  padding: 0 12px;
  
  :deep(.v-btn-group) {
    width: 100%;
  }
  
  :deep(.v-btn) {
    flex: 1;
  }
}

.space-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  
  :deep(.v-btn-group) {
    flex: 1;
  }
  
  :deep(.v-btn) {
    flex: 1;
  }
}

.space-label {
  font-size: 0.75rem;
  color: #9898A8;
  min-width: 40px;
}

.gizmo-hint {
  font-size: 0.75rem;
  color: #7A7A8A;
  text-align: center;
  padding: 8px 12px;
}

.bake-hint {
  font-size: 0.7rem;
  color: #7A7A8A;
  text-align: center;
  padding: 8px 12px 0;
}

.section .v-btn:not(.v-btn-group .v-btn) {
  margin: 0 12px;
  width: calc(100% - 24px);
}

.radius-input {
  padding: 0 12px;
  margin-top: 8px;
}

.center-inputs {
  padding: 8px 12px;
}

.center-label {
  font-size: 0.75rem;
  color: #9898A8;
  display: block;
  margin-bottom: 4px;
}

.center-coords {
  display: flex;
  gap: 12px;
}

.coord-value {
  font-size: 0.75rem;
  font-family: 'JetBrains Mono', 'Consolas', monospace;
  color: #B8B8C8;
}

.clip-result {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.75rem;
  color: #9898A8;
  padding: 8px 12px;
  margin-top: 8px;
  background: rgba(76, 175, 80, 0.1);
  border-radius: 4px;
  margin: 8px 12px 0;
}

.mono-input {
  :deep(input) {
    font-family: 'JetBrains Mono', 'Consolas', monospace;
    font-size: 0.875rem;
  }
}

.size-inputs {
  padding: 8px 12px;
}

.size-label {
  font-size: 0.75rem;
  color: #9898A8;
  display: block;
  margin-bottom: 4px;
}

.size-coords {
  display: flex;
  gap: 8px;
}

.size-field {
  flex: 1;
  
  :deep(input) {
    font-family: 'JetBrains Mono', 'Consolas', monospace;
    font-size: 0.8rem;
  }
}
</style>
