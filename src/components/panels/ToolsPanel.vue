<script setup lang="ts">
import { computed, ref, watch, onMounted, onUnmounted } from 'vue'
import { useSplatEditor } from '@/composables/useSplatEditor'
import { useBabylon } from '@/composables/useBabylon'
import type { BrushMode, GizmoType } from '@/stores/editorStore'
import DragNumberInput from '@/components/common/DragNumberInput.vue'

const editor = useSplatEditor()
const babylon = useBabylon()

// Semantic selection state
const semanticPrompt = ref('')
const semanticSelectAvailable = ref<boolean | null>(null) // null = checking, false = unavailable, true = available
const showMaskDebugDialog = ref(false)

// Reactive mesh transform for detecting negative scale
const meshTransform = ref<{ position: { x: number; y: number; z: number }; rotation: { x: number; y: number; z: number }; scale: { x: number; y: number; z: number } } | null>(null)

let pollInterval: number | null = null

function updateMeshTransform() {
  meshTransform.value = babylon.getMeshTransform()
}

// Check semantic selection availability on mount
onMounted(async () => {
  await recheckSemanticAvailability()
  
  // Start polling for mesh transform
  updateMeshTransform()
  pollInterval = window.setInterval(updateMeshTransform, 100) // Poll every 100ms
})

onUnmounted(() => {
  if (pollInterval !== null) {
    clearInterval(pollInterval)
    pollInterval = null
  }
})

async function recheckSemanticAvailability() {
  semanticSelectAvailable.value = null // Show loading state
  semanticSelectAvailable.value = await editor.checkSemanticSelectAvailable()
  console.log('[ToolsPanel] Semantic select available:', semanticSelectAvailable.value)
}

// Handle semantic selection - capture views for preview
async function handleSemanticSelect() {
  if (!semanticPrompt.value.trim()) return
  await editor.captureForSemanticSelect(semanticPrompt.value)
}

// Confirm and process the captured views
async function handleConfirmSemanticSelect() {
  const count = await editor.confirmSemanticSelect()
  if (count !== null && count > 0) {
    semanticPrompt.value = ''
  }
}

// Combined tool type: gizmo types + brush + operations + clipping tools
type ToolType = GizmoType | 'brush' | 'operations' | 'clipSphere' | 'clipBox'

// Internal state for operations panel
const _operationsSelected = ref(false)

// Watch for selection changes - if rotate is active and selection is made, switch to translate
watch(() => editor.hasSelection.value, (hasSelection) => {
  if (hasSelection && editor.activeGizmo.value === 'rotate') {
    editor.setGizmo('translate')
  }
})

// Computed for combined tool selection (gizmos + brush are mutually exclusive)
const activeTool = computed<ToolType>(() => {
  if (editor.selection.value.brushEnabled) {
    return 'brush'
  }
  if (editor.clipSphere.value.enabled) {
    return 'clipSphere'
  }
  if (editor.clipBox.value.enabled) {
    return 'clipBox'
  }
  // Check if operations was manually selected
  if (_operationsSelected.value) {
    return 'operations'
  }
  return editor.activeGizmo.value
})

// Check if any scale values are negative (prevents bake transform)
const hasNegativeScale = computed(() => {
  if (!meshTransform.value) return false
  return meshTransform.value.scale.x < 0 || meshTransform.value.scale.y < 0 || meshTransform.value.scale.z < 0
})

// Computed reason why bake is disabled
const bakeDisabledReason = computed(() => {
  if (!editor.hasScene.value) return 'No scene loaded'
  if (editor.hasSelection.value) return 'Clear selection to use bake tools'
  if (hasNegativeScale.value) return 'Cannot bake with negative scale (coordinate system conversion)'
  return ''
})

// Check if bake transform is disabled
const isBakeDisabled = computed(() => {
  return !editor.hasScene.value || editor.hasSelection.value || hasNegativeScale.value
})

// Handle tool selection - manages mutual exclusivity
function handleToolChange(tool: ToolType | undefined) {
  if (!tool) return
  
  if (tool === 'brush') {
    // Selecting brush: disable gizmos, enable brush, close operations, disable clipping
    editor.setGizmo('none')
    editor.setSelectionBrushEnabled(true)
    editor.setClipSphereEnabled(false)
    editor.setClipBoxEnabled(false)
    _operationsSelected.value = false
  } else if (tool === 'operations') {
    // Selecting operations: disable gizmos and brush, show operations panel, disable clipping
    editor.setGizmo('none')
    editor.setSelectionBrushEnabled(false)
    editor.setClipSphereEnabled(false)
    editor.setClipBoxEnabled(false)
    _operationsSelected.value = true
  } else if (tool === 'clipSphere') {
    // Selecting clip sphere: disable gizmos, brush, operations, clip box
    editor.setGizmo('none')
    editor.setSelectionBrushEnabled(false)
    editor.setClipBoxEnabled(false)
    editor.setClipSphereEnabled(true)
    _operationsSelected.value = false
  } else if (tool === 'clipBox') {
    // Selecting clip box: disable gizmos, brush, operations, clip sphere
    editor.setGizmo('none')
    editor.setSelectionBrushEnabled(false)
    editor.setClipSphereEnabled(false)
    editor.setClipBoxEnabled(true)
    _operationsSelected.value = false
  } else {
    // Selecting a gizmo: disable brush, close operations, disable clipping, set gizmo
    editor.setSelectionBrushEnabled(false)
    editor.setClipSphereEnabled(false)
    editor.setClipBoxEnabled(false)
    _operationsSelected.value = false
    editor.setGizmo(tool)
  }
}

function handleBrushRadiusChange(value: string | number) {
  const num = typeof value === 'string' ? parseFloat(value) : value
  if (!isNaN(num) && num > 0) {
    editor.setSelectionBrushRadius(num)
  }
}

function handleBrushModeChange(value: BrushMode | undefined) {
  if (value) {
    editor.setSelectionBrushMode(value)
  }
}

function handleClipSphereRadiusChange(value: string | number) {
  const num = typeof value === 'string' ? parseFloat(value) : value
  if (!isNaN(num) && num > 0) {
    editor.setClipSphereRadius(num)
  }
}
</script>

<template>
  <div class="panel">
    <div class="quantum-panel-header">
      Tools
    </div>
    
    <div class="quantum-panel-content">
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
        
        <v-tooltip 
          :disabled="!editor.hasSelection.value" 
          text="Clear selection to use bake tools"
          location="top"
        >
          <template #activator="{ props }">
            <div v-bind="props">
              <v-btn
                block
                variant="tonal"
                size="small"
                prepend-icon="mdi-target"
                :disabled="!editor.hasScene.value || editor.hasSelection.value"
                @click="editor.centerSplatAtOrigin"
                class="mb-2"
              >
                Center at Origin
              </v-btn>
            </div>
          </template>
        </v-tooltip>
        
        <v-tooltip 
          :disabled="!isBakeDisabled" 
          :text="bakeDisabledReason"
          location="top"
        >
          <template #activator="{ props }">
            <div v-bind="props">
              <v-btn
                block
                variant="tonal"
                size="small"
                prepend-icon="mdi-cube-send"
                :disabled="isBakeDisabled"
                @click="editor.bakeTransform"
              >
                Bake Transform
              </v-btn>
            </div>
          </template>
        </v-tooltip>
        
        <div class="bake-hint">
          <template v-if="hasNegativeScale">
            <v-icon size="small" color="warning" class="mr-1">mdi-alert</v-icon>
            Cannot bake: negative scale detected
          </template>
          <template v-else-if="editor.hasSelection.value">
            Clear selection to use bake tools
          </template>
          <template v-else>
            Applies current transforms to vertices
          </template>
        </div>
      </div>
      
      <!-- Tools Section (Gizmos + Brush) -->
      <div class="section">
        <div class="section-title">Tools</div>
        
        <div class="tools-grid">
          <v-btn 
            :variant="activeTool === 'none' ? 'flat' : 'tonal'"
            size="small" 
            title="Select"
            :disabled="!editor.hasScene.value"
            @click="handleToolChange('none')"
          >
            <v-icon size="small">mdi-cursor-default</v-icon>
          </v-btn>
          <v-btn 
            :variant="activeTool === 'translate' ? 'flat' : 'tonal'"
            size="small" 
            title="Move"
            :disabled="!editor.hasScene.value"
            @click="handleToolChange('translate')"
          >
            <v-icon size="small">mdi-axis-arrow</v-icon>
          </v-btn>
          <v-btn 
            :variant="activeTool === 'rotate' ? 'flat' : 'tonal'"
            size="small" 
            :title="editor.hasSelection.value ? 'Rotate (disabled with selection)' : 'Rotate'"
            :disabled="!editor.hasScene.value || editor.hasSelection.value"
            @click="handleToolChange('rotate')"
          >
            <v-icon size="small">mdi-rotate-3d-variant</v-icon>
          </v-btn>
          <v-btn 
            :variant="activeTool === 'scale' ? 'flat' : 'tonal'"
            size="small" 
            title="Scale"
            :disabled="!editor.hasScene.value"
            @click="handleToolChange('scale')"
          >
            <v-icon size="small">mdi-resize</v-icon>
          </v-btn>
          <v-btn 
            :variant="activeTool === 'brush' ? 'flat' : 'tonal'"
            :color="activeTool === 'brush' ? 'info' : undefined"
            size="small" 
            title="Selection Brush"
            :disabled="!editor.hasScene.value"
            @click="handleToolChange('brush')"
          >
            <v-icon size="small">mdi-brush</v-icon>
          </v-btn>
          <v-btn 
            :variant="activeTool === 'clipSphere' ? 'flat' : 'tonal'"
            :color="activeTool === 'clipSphere' ? 'warning' : undefined"
            size="small" 
            title="Clip Sphere"
            :disabled="!editor.hasScene.value || editor.hasSelection.value"
            @click="handleToolChange('clipSphere')"
          >
            <v-icon size="small">mdi-sphere</v-icon>
          </v-btn>
          <v-btn 
            :variant="activeTool === 'clipBox' ? 'flat' : 'tonal'"
            :color="activeTool === 'clipBox' ? 'warning' : undefined"
            size="small" 
            title="Clip Box"
            :disabled="!editor.hasScene.value || editor.hasSelection.value"
            @click="handleToolChange('clipBox')"
          >
            <v-icon size="small">mdi-cube-outline</v-icon>
          </v-btn>
          <v-btn 
            :variant="activeTool === 'operations' ? 'flat' : 'tonal'"
            :color="activeTool === 'operations' ? 'secondary' : undefined"
            size="small" 
            title="Operations"
            :disabled="!editor.hasScene.value"
            @click="handleToolChange('operations')"
          >
            <v-icon size="small">mdi-cog</v-icon>
          </v-btn>
        </div>
        
        <!-- Transform Space Toggle (shown for gizmos) -->
        <template v-if="activeTool !== 'none' && activeTool !== 'brush' && activeTool !== 'operations' && activeTool !== 'clipSphere' && activeTool !== 'clipBox'">
          <div class="space-toggle">
            <span class="space-label">Space:</span>
            <v-btn-toggle
              :model-value="editor.transformSpace.value"
              @update:model-value="editor.setTransformSpace"
              mandatory
              density="compact"
              :disabled="!editor.hasScene.value"
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
        </template>
        
        <!-- Brush Options (shown when brush is active) -->
        <template v-if="activeTool === 'brush'">
          <div class="slider-row">
            <span class="slider-label">Radius</span>
            <v-slider
              :model-value="editor.selection.value.brushRadius"
              @update:model-value="handleBrushRadiusChange"
              :min="0.1"
              :max="10"
              :step="0.1"
              hide-details
              density="compact"
              thumb-label
              color="info"
            />
          </div>
          
          <div class="radius-input">
            <DragNumberInput
              :model-value="editor.selection.value.brushRadius"
              @update:model-value="handleBrushRadiusChange"
              :step="0.1"
              :min="0.1"
              label="Radius"
              class="mono-input"
            />
          </div>
          
          <!-- Brush Mode Toggle -->
          <div class="mode-toggle">
            <span class="mode-label">Mode:</span>
            <v-btn-toggle
              :model-value="editor.selection.value.brushMode"
              @update:model-value="handleBrushModeChange"
              mandatory
              density="compact"
            >
              <v-btn value="add" size="x-small">
                <v-icon size="x-small" class="mr-1">mdi-plus</v-icon>
                Add
              </v-btn>
              <v-btn value="remove" size="x-small">
                <v-icon size="x-small" class="mr-1">mdi-minus</v-icon>
                Remove
              </v-btn>
            </v-btn-toggle>
          </div>
        </template>
        
        <!-- Operations Options (shown when operations is active) -->
        <template v-if="activeTool === 'operations'">
          <div class="operations-panel">
            <v-btn
              block
              color="error"
              variant="flat"
              size="small"
              prepend-icon="mdi-delete"
              :disabled="!editor.hasScene.value || !editor.hasSelection.value"
              :loading="editor.isDeleting.value"
              @click="editor.deleteSelected"
              class="mb-2"
            >
              Delete Selected
            </v-btn>
            
            <v-btn
              block
              color="primary"
              variant="tonal"
              size="small"
              prepend-icon="mdi-content-copy"
              :disabled="!editor.hasScene.value || !editor.hasSelection.value"
              class="mb-2"
              @click="() => { /* TODO: Clone Selected */ }"
            >
              Clone Selected
            </v-btn>
            
            <v-btn
              block
              color="primary"
              variant="tonal"
              size="small"
              prepend-icon="mdi-export"
              :disabled="!editor.hasScene.value || !editor.hasSelection.value"
              class="mb-2"
              @click="() => { /* TODO: Selected To New */ }"
            >
              Selected To New
            </v-btn>
            
            <v-btn
              block
              color="warning"
              variant="tonal"
              size="small"
              prepend-icon="mdi-restore"
              :disabled="!editor.hasScene.value"
              @click="editor.restoreToOriginal"
              class="mb-2"
            >
              Restore to Original
            </v-btn>
            
            <div v-if="editor.lastDeleteResult.value" class="delete-result">
              <v-icon size="small" color="success" class="mr-1">mdi-check-circle</v-icon>
              Deleted {{ (editor.lastDeleteResult.value.originalCount - editor.lastDeleteResult.value.remainingCount).toLocaleString() }} splats
            </div>
          </div>
        </template>
        
        <!-- Clip Sphere Options (shown when clipSphere is active) -->
        <template v-if="activeTool === 'clipSphere'">
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
            <DragNumberInput
              :model-value="editor.clipSphere.value.radius"
              @update:model-value="handleClipSphereRadiusChange"
              :step="0.5"
              :min="0.5"
              label="Radius"
              class="mono-input"
            />
          </div>
          
          <div class="center-inputs">
            <span class="center-label">Center (drag gizmo to move)</span>
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
        
        <!-- Clip Box Options (shown when clipBox is active) -->
        <template v-if="activeTool === 'clipBox'">
          <div class="size-inputs">
            <span class="size-label">Size</span>
            <div class="size-coords">
              <DragNumberInput
                :model-value="editor.clipBox.value.size.x"
                @update:model-value="(v) => editor.setClipBoxSize(v, editor.clipBox.value.size.y, editor.clipBox.value.size.z)"
                :step="0.5"
                :min="0.1"
                label="X"
                class="size-field"
              />
              <DragNumberInput
                :model-value="editor.clipBox.value.size.y"
                @update:model-value="(v) => editor.setClipBoxSize(editor.clipBox.value.size.x, v, editor.clipBox.value.size.z)"
                :step="0.5"
                :min="0.1"
                label="Y"
                class="size-field"
              />
              <DragNumberInput
                :model-value="editor.clipBox.value.size.z"
                @update:model-value="(v) => editor.setClipBoxSize(editor.clipBox.value.size.x, editor.clipBox.value.size.y, v)"
                :step="0.5"
                :min="0.1"
                label="Z"
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
            color="warning"
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
        
        <div class="gizmo-hint">
          <template v-if="activeTool === 'none'">
            Select a tool to begin
          </template>
          <template v-else-if="activeTool === 'translate'">
            Drag arrows to move
          </template>
          <template v-else-if="activeTool === 'rotate'">
            Drag rings to rotate
          </template>
          <template v-else-if="activeTool === 'scale'">
            Drag handles to scale
          </template>
          <template v-else-if="activeTool === 'brush'">
            Click and drag on splats to paint selection
          </template>
          <template v-else-if="activeTool === 'clipSphere'">
            Drag sphere to position, adjust radius, then apply
          </template>
          <template v-else-if="activeTool === 'clipBox'">
            Drag box to position, adjust size, then apply
          </template>
          <template v-else-if="activeTool === 'operations'">
            Operations on selected splats
          </template>
        </div>
      </div>
      
      <!-- Selection Section -->
      <div class="section">
        <div class="section-title">Selection</div>
        
        <!-- Selection Info and Actions -->
        <div class="selection-info">
          <v-icon size="small" class="mr-1" :color="editor.hasSelection.value ? 'info' : undefined">
            mdi-selection
          </v-icon>
          <span>{{ editor.selectionCount.value.toLocaleString() }} splats selected</span>
        </div>
        
        <div class="selection-actions">
          <v-btn
            size="x-small"
            variant="text"
            :disabled="!editor.hasScene.value"
            @click="editor.selectAll"
          >
            Select All
          </v-btn>
          <v-btn
            size="x-small"
            variant="text"
            :disabled="!editor.hasScene.value || !editor.hasSelection.value"
            @click="editor.invertSelection"
          >
            Invert
          </v-btn>
          <v-btn
            size="x-small"
            variant="text"
            :disabled="!editor.hasScene.value || !editor.hasSelection.value"
            @click="editor.clearSelection"
          >
            Clear
          </v-btn>
        </div>
        
        <div class="selection-hint">
          Double-right-click to clear selection
        </div>
        
        <!-- AI Selection (Semantic) -->
        <div class="semantic-select-section">
          <div class="subsection-title">
            <v-icon size="x-small" class="mr-1">mdi-brain</v-icon>
            AI Select
            <v-btn
              v-if="semanticSelectAvailable === false"
              icon
              size="x-small"
              variant="text"
              @click="recheckSemanticAvailability"
              title="Re-check availability"
              class="ml-auto"
            >
              <v-icon size="x-small">mdi-refresh</v-icon>
            </v-btn>
          </div>
          
          <!-- Loading state -->
          <div v-if="semanticSelectAvailable === null" class="semantic-checking">
            <v-progress-circular indeterminate size="16" width="2" />
            <span>Checking availability...</span>
          </div>
          
          <!-- Unavailable state -->
          <div v-else-if="semanticSelectAvailable === false" class="semantic-unavailable">
            <v-icon size="small" color="warning" class="mr-1">mdi-alert-circle-outline</v-icon>
            <span>Backend dependencies not installed</span>
            <div class="unavailable-hint">
              Run: <code>pip install -r backend/scripts/requirements.txt</code>
            </div>
          </div>
          
          <!-- Available state -->
          <template v-else>
            <div class="semantic-input-row">
              <div class="semantic-search-wrapper">
                <v-icon class="search-icon" size="small">mdi-magnify</v-icon>
                <input
                  v-model="semanticPrompt"
                  type="text"
                  placeholder="e.g. bike, tree, car"
                  :disabled="!editor.hasScene.value || editor.isSemanticSelecting.value || !!editor.pendingSemanticCapture.value"
                  @keyup.enter="handleSemanticSelect"
                  class="semantic-search-input"
                />
              </div>
            </div>
            
            <div v-if="editor.isSemanticSelecting.value" class="semantic-progress">
              <v-progress-linear indeterminate color="primary" height="2" />
              <span class="progress-text">{{ editor.semanticSelectProgress.value || 'Processing...' }}</span>
            </div>
            
            <div v-if="editor.lastSemanticSelectResult.value && !editor.pendingSemanticCapture.value" class="semantic-result">
              <div class="result-text">
                <v-icon 
                  size="small" 
                  :color="editor.lastSemanticSelectResult.value.selectedCount > 0 ? 'success' : 'warning'" 
                  class="mr-1"
                >
                  {{ editor.lastSemanticSelectResult.value.selectedCount > 0 ? 'mdi-check-circle' : 'mdi-alert-circle' }}
                </v-icon>
                <template v-if="editor.lastSemanticSelectResult.value.selectedCount > 0">
                  Selected {{ editor.lastSemanticSelectResult.value.selectedCount.toLocaleString() }} splats
                  for "{{ editor.lastSemanticSelectResult.value.prompt }}"
                </template>
                <template v-else>
                  No matches found for "{{ editor.lastSemanticSelectResult.value.prompt }}"
                </template>
              </div>
              <v-btn
                v-if="editor.lastSemanticSelectResult.value.debugMasks"
                size="x-small"
                variant="text"
                class="view-masks-btn"
                @click="showMaskDebugDialog = true"
              >
                View Masks
              </v-btn>
            </div>
          </template>
        </div>
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
  
  <!-- Semantic Selection Preview Dialog -->
  <v-dialog 
    :model-value="editor.pendingSemanticCapture.value !== null" 
    max-width="600"
    @update:model-value="(v: boolean) => !v && editor.cancelSemanticSelect()"
  >
    <v-card class="preview-dialog">
      <v-card-title class="preview-dialog-title">
        <v-icon class="mr-2" color="primary">mdi-brain</v-icon>
        AI Selection Preview
      </v-card-title>
      
      <v-card-text v-if="editor.pendingSemanticCapture.value" class="preview-dialog-content">
        <div class="preview-info">
          <span class="preview-prompt-label">Searching for:</span>
          <span class="preview-prompt-text">"{{ editor.pendingSemanticCapture.value.prompt }}"</span>
        </div>
        
        <div class="preview-grid-dialog">
          <div 
            v-for="(view, index) in editor.pendingSemanticCapture.value.views" 
            :key="index"
            class="preview-thumb-dialog"
          >
            <img :src="view.dataUrl" :alt="`View ${index + 1}`" />
            <span class="view-label">{{ index + 1 }}</span>
          </div>
        </div>
        
        <div class="preview-hint">
          {{ editor.pendingSemanticCapture.value.views.length }} camera views captured. 
          Click Analyze to run AI segmentation on these images.
        </div>
      </v-card-text>
      
      <v-card-actions class="preview-dialog-actions">
        <v-btn variant="text" @click="editor.cancelSemanticSelect">
          Cancel
        </v-btn>
        <v-spacer />
        <v-btn
          color="primary"
          variant="flat"
          :loading="editor.isSemanticSelecting.value"
          @click="handleConfirmSemanticSelect"
        >
          <v-icon start>mdi-magnify-scan</v-icon>
          Analyze
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
  
  <!-- Mask Debug Dialog -->
  <v-dialog v-model="showMaskDebugDialog" max-width="800">
    <v-card class="mask-debug-dialog">
      <v-card-title class="mask-debug-title">
        <v-icon class="mr-2">mdi-image-multiple</v-icon>
        Generated Masks
        <v-spacer />
        <span class="mask-debug-prompt" v-if="editor.lastSemanticSelectResult.value">
          "{{ editor.lastSemanticSelectResult.value.prompt }}"
        </span>
      </v-card-title>
      
      <v-card-text class="mask-debug-content" v-if="editor.lastSemanticSelectResult.value?.debugMasks">
        <div class="mask-debug-grid">
          <div 
            v-for="(item, index) in editor.lastSemanticSelectResult.value.debugMasks" 
            :key="index"
            class="mask-debug-item"
            :class="{ 'has-detection': item.hasDetection }"
          >
            <div class="mask-debug-images">
              <div class="image-container">
                <img :src="item.originalImage" alt="Original" />
                <span class="image-label">Original</span>
              </div>
              <div class="image-container" v-if="item.maskImage">
                <img :src="item.maskImage" alt="Mask" class="mask-image" />
                <span class="image-label">Mask</span>
              </div>
              <div class="image-container no-detection" v-else>
                <span class="no-detection-text">No detection</span>
              </div>
            </div>
            <div class="mask-debug-label">
              View {{ index + 1 }}
              <v-icon v-if="item.hasDetection" size="small" color="success">mdi-check</v-icon>
            </div>
          </div>
        </div>
      </v-card-text>
      
      <v-card-actions class="mask-debug-actions">
        <v-btn variant="text" @click="showMaskDebugDialog = false">Close</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
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
  overflow-x: hidden;
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

.tools-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(36px, 1fr));
  gap: 6px;
  padding: 0 12px;
  
  .v-btn {
    min-width: 36px;
    margin: 0;
    
    &:disabled {
      opacity: 0.35;
    }
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

// Selection section styles
.mode-toggle {
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

.mode-label {
  font-size: 0.75rem;
  color: #9898A8;
  min-width: 40px;
}

.brush-hint {
  font-size: 0.7rem;
  color: #7A7A8A;
  text-align: center;
  padding: 8px 12px 0;
}

.operations-panel {
  padding: 8px 12px;
  
  .v-btn {
    width: 100%;
  }
}

.selection-info {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.8rem;
  color: #B8B8C8;
  padding: 12px 12px 4px;
}

.selection-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 4px;
  padding: 4px 12px;
}

.selection-hint {
  font-size: 0.7rem;
  color: #7A7A8A;
  text-align: center;
  padding: 4px 12px 0;
}

// Semantic (AI) selection styles
.semantic-select-section {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}

.subsection-title {
  display: flex;
  align-items: center;
  font-size: 0.7rem;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.8px;
  color: #8888B8;
  padding: 0 12px 10px;
  
  .v-icon {
    color: #6B8AFF;
    opacity: 0.8;
  }
}

.semantic-checking {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 14px 12px;
  font-size: 0.75rem;
  color: #8888A8;
  
  :deep(.v-progress-circular) {
    color: #6B8AFF;
  }
}

.semantic-unavailable {
  padding: 12px;
  margin: 0 12px;
  font-size: 0.75rem;
  color: #9898A8;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  background: rgba(255, 193, 7, 0.06);
  border: 1px solid rgba(255, 193, 7, 0.15);
  border-radius: 6px;
  
  .unavailable-hint {
    width: 100%;
    margin-top: 6px;
    font-size: 0.68rem;
    color: #7A7A8A;
    line-height: 1.5;
    
    code {
      display: block;
      margin-top: 4px;
      background: rgba(30, 30, 50, 0.6);
      padding: 6px 8px;
      border-radius: 4px;
      font-size: 0.65rem;
      color: #A0A0C0;
      word-break: break-all;
    }
  }
}

.semantic-input-row {
  padding: 0 12px;
}

.semantic-search-wrapper {
  display: flex;
  align-items: center;
  width: 100%;
  background: rgba(30, 30, 50, 0.8);
  border: 1px solid rgba(107, 138, 255, 0.3);
  border-radius: 6px;
  padding: 0 10px;
  gap: 6px;
  transition: border-color 0.2s, box-shadow 0.2s;
  
  &:focus-within {
    border-color: rgba(107, 138, 255, 0.6);
    box-shadow: 0 0 0 2px rgba(107, 138, 255, 0.15);
  }
  
  &:hover:not(:focus-within) {
    border-color: rgba(107, 138, 255, 0.4);
  }
  
  .search-icon {
    color: #6B8AFF;
    opacity: 0.7;
    flex-shrink: 0;
  }
}

.semantic-search-input {
  flex: 1;
  width: 100%;
  background: transparent;
  border: none;
  outline: none;
  color: #E0E0E8;
  font-size: 0.8rem;
  padding: 10px 8px;
  min-width: 0;
  
  &::placeholder {
    color: #6A6A7A;
    font-size: 0.75rem;
  }
  
  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
}

.semantic-progress {
  padding: 12px 12px 8px;
  
  .progress-text {
    display: block;
    font-size: 0.7rem;
    color: #7A7A8A;
    text-align: center;
    margin-top: 6px;
  }
  
  :deep(.v-progress-linear) {
    border-radius: 2px;
    overflow: hidden;
  }
}

.semantic-result {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  gap: 4px;
  font-size: 0.72rem;
  color: #B0B0C0;
  padding: 10px 12px;
  margin: 10px 12px 0;
  background: rgba(107, 138, 255, 0.08);
  border: 1px solid rgba(107, 138, 255, 0.15);
  border-radius: 6px;
  text-align: center;
  
  &.success {
    background: rgba(76, 175, 80, 0.08);
    border-color: rgba(76, 175, 80, 0.2);
  }
  
  &.warning {
    background: rgba(255, 193, 7, 0.08);
    border-color: rgba(255, 193, 7, 0.2);
  }
}

// Preview dialog styles
.preview-dialog {
  background: #1A1A24 !important;
}

.preview-dialog-title {
  display: flex;
  align-items: center;
  padding: 16px 20px !important;
  font-size: 1rem !important;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.preview-dialog-content {
  padding: 16px 20px !important;
}

.preview-info {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 16px;
  
  .preview-prompt-label {
    font-size: 0.8rem;
    color: #7A7A8A;
  }
  
  .preview-prompt-text {
    font-size: 0.85rem;
    color: #6B8AFF;
    font-weight: 500;
  }
}

.preview-grid-dialog {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
  margin-bottom: 16px;
}

.preview-thumb-dialog {
  aspect-ratio: 1;
  border-radius: 6px;
  overflow: hidden;
  background: rgba(0, 0, 0, 0.3);
  position: relative;
  border: 1px solid rgba(255, 255, 255, 0.1);
  
  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  
  .view-label {
    position: absolute;
    bottom: 4px;
    right: 4px;
    background: rgba(0, 0, 0, 0.6);
    color: #B0B0C0;
    font-size: 0.65rem;
    padding: 2px 6px;
    border-radius: 3px;
  }
}

.preview-hint {
  font-size: 0.75rem;
  color: #6A6A7A;
  text-align: center;
}

.preview-dialog-actions {
  padding: 12px 16px !important;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}

.delete-result {
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

.semantic-result {
  .result-text {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-wrap: wrap;
  }
  
  .view-masks-btn {
    margin-top: 8px;
    font-size: 0.7rem;
  }
}

// Mask debug dialog styles
.mask-debug-dialog {
  background: #1A1A24 !important;
}

.mask-debug-title {
  display: flex;
  align-items: center;
  padding: 16px 20px !important;
  font-size: 1rem !important;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  
  .mask-debug-prompt {
    font-size: 0.8rem;
    color: #6B8AFF;
    font-style: italic;
  }
}

.mask-debug-content {
  padding: 16px 20px !important;
  max-height: 60vh;
  overflow-y: auto;
}

.mask-debug-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 16px;
}

.mask-debug-item {
  background: rgba(30, 30, 50, 0.6);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  padding: 8px;
  
  &.has-detection {
    border-color: rgba(76, 175, 80, 0.3);
  }
}

.mask-debug-images {
  display: flex;
  gap: 8px;
}

.mask-debug-item .image-container {
  flex: 1;
  aspect-ratio: 1;
  position: relative;
  border-radius: 4px;
  overflow: hidden;
  background: rgba(0, 0, 0, 0.3);
  
  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  
  .mask-image {
    background: white;
  }
  
  .image-label {
    position: absolute;
    bottom: 4px;
    left: 4px;
    background: rgba(0, 0, 0, 0.7);
    color: #B0B0C0;
    font-size: 0.6rem;
    padding: 2px 6px;
    border-radius: 3px;
  }
  
  &.no-detection {
    display: flex;
    align-items: center;
    justify-content: center;
    
    .no-detection-text {
      font-size: 0.7rem;
      color: #6A6A7A;
    }
  }
}

.mask-debug-label {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  margin-top: 6px;
  font-size: 0.7rem;
  color: #8A8A9A;
}

.mask-debug-actions {
  padding: 12px 16px !important;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}
</style>
