<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { useGeneratorStore } from '@/stores/generatorStore'
import { useGenerator } from '@/composables/useGenerator'
import { useBabylon } from '@/composables/useBabylon'

const generatorStore = useGeneratorStore()
const generator = useGenerator()
const babylon = useBabylon()

const webgpuChecked = ref(false)
const browserSupportsWebGPU = ref(false)
const checkingBackend = ref(true)

// Check capabilities on mount
onMounted(async () => {
  // Check WebGPU
  if ('gpu' in navigator) {
    try {
      const adapter = await navigator.gpu.requestAdapter()
      browserSupportsWebGPU.value = adapter !== null
    } catch {
      browserSupportsWebGPU.value = false
    }
  }
  webgpuChecked.value = true

  // Check backend availability
  await generatorStore.checkBackendAvailable()
  checkingBackend.value = false
})

// Computed for capability display
const canGenerate = computed(() => {
  return generatorStore.backendAvailable || browserSupportsWebGPU.value
})

const generatorModeLabel = computed(() => {
  if (generatorStore.useBackend) {
    return generatorStore.trainingMode === 'gpu' ? 'GPU (OpenSplat)' : 
           generatorStore.trainingMode === 'cpu' ? 'CPU (OpenSplat)' : 'Auto'
  }
  return 'Browser (WebGPU)'
})

async function recheckBackend() {
  checkingBackend.value = true
  await generatorStore.checkBackendAvailable()
  checkingBackend.value = false
}

// Clean up all object URLs on unmount
onBeforeUnmount(() => {
  for (const url of imageUrls.value.values()) {
    URL.revokeObjectURL(url)
  }
  imageUrls.value.clear()
})

// Auto-load result to scene when generation completes
watch(() => generatorStore.currentStage, async (stage, prevStage) => {
  if (stage === 'complete' && prevStage !== 'complete') {
    console.log('[Generator] Generation complete, auto-loading to scene...')
    try {
      await generator.loadResultToScene('Generated Splats')
      console.log('[Generator] Successfully loaded to scene')
      
      // Wait a frame for the splat to be ready, then focus camera
      setTimeout(() => {
        console.log('[Generator] Focusing camera on generated splat...')
        babylon.focusCamera()
      }, 100)
    } catch (e) {
      console.error('[Generator] Failed to load to scene:', e)
      // Show debug cube on failure
      babylon.showDebugCube(true)
    }
  }
})

const stageLabels: Record<string, string> = {
  idle: 'Ready',
  initializing: 'Initializing',
  preprocessing: 'Processing Images',
  sfm: 'Estimating Cameras',
  point_cloud: 'Generating Points',
  optimizing: 'Optimizing',
  densifying: 'Densifying',
  pruning: 'Pruning',
  finalizing: 'Finalizing',
  complete: 'Complete',
  cancelled: 'Cancelled',
  error: 'Error'
}

const stageLabel = computed(() => {
  return stageLabels[generatorStore.currentStage] || generatorStore.currentStage
})

const progressColor = computed(() => {
  switch (generatorStore.currentStage) {
    case 'complete': return 'success'
    case 'error': return 'error'
    case 'cancelled': return 'warning'
    default: return 'primary'
  }
})

function handleImageUpload() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*'
  input.multiple = true
  input.onchange = (e) => {
    const files = (e.target as HTMLInputElement).files
    if (files) {
      generatorStore.addImages(Array.from(files))
    }
  }
  input.click()
}

const isDragging = ref(false)
const imageUrls = ref<Map<File, string>>(new Map())

// Create object URL for image preview
function getImageUrl(file: File): string {
  if (!imageUrls.value.has(file)) {
    imageUrls.value.set(file, URL.createObjectURL(file))
  }
  return imageUrls.value.get(file)!
}

// Clean up object URLs when images are removed
function cleanupImageUrl(file: File) {
  const url = imageUrls.value.get(file)
  if (url) {
    URL.revokeObjectURL(url)
    imageUrls.value.delete(file)
  }
}

function handleDrop(e: DragEvent) {
  e.preventDefault()
  e.stopPropagation()
  isDragging.value = false
  
  const files = e.dataTransfer?.files
  if (files && files.length > 0) {
    const imageFiles = Array.from(files).filter(f => f.type.startsWith('image/'))
    if (imageFiles.length > 0) {
      generatorStore.addImages(imageFiles)
    }
  }
}

function handleDragOver(e: DragEvent) {
  e.preventDefault()
  e.stopPropagation()
  if (e.dataTransfer) {
    e.dataTransfer.dropEffect = 'copy'
  }
}

function handleDragEnter(e: DragEvent) {
  e.preventDefault()
  e.stopPropagation()
  isDragging.value = true
}

function handleDragLeave(e: DragEvent) {
  e.preventDefault()
  e.stopPropagation()
  isDragging.value = false
}

function removeImageAtIndex(index: number) {
  const file = generatorStore.images[index]
  if (file) {
    cleanupImageUrl(file)
  }
  generatorStore.removeImage(index)
}

function clearAllImages() {
  // Clean up all URLs before clearing
  for (const file of generatorStore.images) {
    cleanupImageUrl(file)
  }
  generatorStore.clearImages()
}

async function loadResultToScene() {
  await generator.loadResultToScene('Generated Splats')
}

function downloadPly() {
  const timestamp = new Date().toISOString().slice(0, 19).replace(/[:-]/g, '')
  generator.downloadAsPly(`splats-${timestamp}.ply`)
}

function downloadSplat() {
  const timestamp = new Date().toISOString().slice(0, 19).replace(/[:-]/g, '')
  generator.downloadAsSplat(`splats-${timestamp}.splat`)
}
</script>

<template>
  <div class="panel">
    <div class="quantum-panel-header">
      Generator
      <v-chip 
        v-if="generatorStore.backendAvailable"
        size="x-small" 
        color="success"
        class="ml-2"
      >
        Backend Connected
      </v-chip>
      <v-chip 
        v-else-if="!checkingBackend"
        size="x-small" 
        color="warning"
        class="ml-2"
      >
        Browser Only
      </v-chip>
      <v-chip 
        v-else-if="webgpuChecked"
        size="x-small" 
        color="error"
        class="ml-2"
      >
        No GPU
      </v-chip>
    </div>
    
    <div class="quantum-panel-content">
      <!-- Loading state -->
      <div v-if="checkingBackend" class="loading-check">
        <v-progress-circular indeterminate size="24" color="primary" />
        <p class="mt-2 text-grey">Checking capabilities...</p>
      </div>

      <!-- Generator available -->
      <template v-else-if="canGenerate">
        <!-- Backend not connected warning -->
        <div v-if="!generatorStore.backendAvailable" class="section backend-warning">
          <v-alert type="info" density="compact" variant="tonal">
            <div class="text-caption">
              <strong>Backend not running</strong> - Using browser mock generator.
              <br>
              For real photogrammetry, start the backend:
              <code class="d-block mt-1">cd backend && npm run dev:local</code>
            </div>
            <v-btn 
              size="x-small" 
              variant="text" 
              class="mt-2"
              @click="recheckBackend"
              :loading="checkingBackend"
            >
              <v-icon size="small" class="mr-1">mdi-refresh</v-icon>
              Re-check Connection
            </v-btn>
          </v-alert>
        </div>

        <!-- Mode Selection (if backend available) -->
        <div v-if="generatorStore.backendAvailable" class="section">
          <div class="section-header">Training Mode</div>
          
          <v-btn-toggle
            :model-value="generatorStore.trainingMode"
            @update:model-value="v => generatorStore.setTrainingMode(v as any)"
            mandatory
            density="compact"
            color="primary"
            class="mode-toggle"
          >
            <v-btn value="auto" size="x-small">
              <v-icon size="x-small">mdi-auto-fix</v-icon>
              Auto
            </v-btn>
            <v-btn value="gpu" size="x-small">
              <v-icon size="x-small">mdi-memory</v-icon>
              GPU
            </v-btn>
            <v-btn value="cpu" size="x-small">
              <v-icon size="x-small">mdi-cpu-64-bit</v-icon>
              CPU
            </v-btn>
          </v-btn-toggle>

          <p class="mode-hint">
            <template v-if="generatorStore.trainingMode === 'auto'">
              Auto: Detects GPU availability, falls back to CPU
            </template>
            <template v-else-if="generatorStore.trainingMode === 'gpu'">
              GPU: Fast (~5-15 min), requires NVIDIA/AMD GPU
            </template>
            <template v-else>
              CPU: Slower (~30-60 min), works on any system
            </template>
          </p>
        </div>
        <!-- Image Upload Section -->
        <div class="section">
          <div class="section-header">
            <span>Input Images</span>
            <span class="image-count mono">{{ generatorStore.images.length }}</span>
          </div>
          
          <div 
            v-if="generatorStore.images.length === 0"
            class="drop-zone"
            :class="{ 'drop-zone--active': isDragging }"
            @click="handleImageUpload"
            @drop="handleDrop"
            @dragover="handleDragOver"
            @dragenter="handleDragEnter"
            @dragleave="handleDragLeave"
          >
            <v-icon size="32" :color="isDragging ? 'primary' : 'grey-darken-1'">mdi-image-multiple</v-icon>
            <p class="mt-2">{{ isDragging ? 'Drop to add images' : 'Drop images here or click to browse' }}</p>
          </div>

          <div v-else class="image-grid">
            <div
              v-for="(img, index) in generatorStore.images"
              :key="index"
              class="image-thumb"
            >
              <img :src="getImageUrl(img)" :alt="img.name" />
              <v-btn
                icon="mdi-close"
                size="x-small"
                variant="flat"
                color="error"
                class="remove-btn"
                @click="removeImageAtIndex(index)"
                :disabled="generatorStore.isGenerating"
              />
            </div>
          </div>
          
          <div class="upload-actions">
            <v-btn
              prepend-icon="mdi-image-plus"
              variant="outlined"
              size="small"
              @click="handleImageUpload"
              :disabled="generatorStore.isGenerating"
            >
              Add Images
            </v-btn>
            <v-btn
              v-if="generatorStore.images.length > 0"
              icon="mdi-delete-outline"
              variant="text"
              size="small"
              color="error"
              @click="clearAllImages"
              :disabled="generatorStore.isGenerating"
            />
          </div>
          
          <p class="hint">
            <v-icon size="12" class="mr-1">mdi-information-outline</v-icon>
            Minimum 3 images required. More images = better results.
          </p>
        </div>
        
        <!-- Settings Section -->
        <div class="section">
          <div class="section-header">Settings</div>
          
          <div class="setting-row">
            <span class="setting-label">Iterations</span>
            <v-text-field
              :model-value="generatorStore.config.iterations"
              @update:model-value="v => generatorStore.updateConfig({ iterations: Number(v) })"
              type="number"
              :min="1000"
              :max="100000"
              :step="5000"
              hide-details
              density="compact"
              class="setting-input mono-input"
              :disabled="generatorStore.isGenerating"
            />
          </div>

          <!-- Cleanup Settings -->
          <div class="subsection-header mt-3">Post-Processing</div>
          
          <div class="setting-row">
            <span class="setting-label">Cleanup</span>
            <v-switch
              :model-value="generatorStore.config.cleanupEnabled !== false"
              @update:model-value="v => generatorStore.updateConfig({ cleanupEnabled: v })"
              hide-details
              density="compact"
              color="primary"
              :disabled="generatorStore.isGenerating"
            />
          </div>

          <div v-if="generatorStore.config.cleanupEnabled !== false">
            <div class="setting-row">
              <span class="setting-label">Min Opacity</span>
              <v-slider
                :model-value="generatorStore.config.cleanupMinOpacity ?? 0.05"
                @update:model-value="v => generatorStore.updateConfig({ cleanupMinOpacity: v })"
                :min="0"
                :max="0.3"
                :step="0.01"
                hide-details
                density="compact"
                thumb-label
                class="setting-slider"
                :disabled="generatorStore.isGenerating"
              />
            </div>

            <div class="setting-row">
              <span class="setting-label">Max Scale %ile</span>
              <v-slider
                :model-value="generatorStore.config.cleanupMaxScalePercentile ?? 99"
                @update:model-value="v => generatorStore.updateConfig({ cleanupMaxScalePercentile: v })"
                :min="90"
                :max="100"
                :step="0.5"
                hide-details
                density="compact"
                thumb-label
                class="setting-slider"
                :disabled="generatorStore.isGenerating"
              />
            </div>

            <div class="setting-row">
              <span class="setting-label">SOR Strength</span>
              <v-slider
                :model-value="generatorStore.config.cleanupSorStdDevs ?? 3.0"
                @update:model-value="v => generatorStore.updateConfig({ cleanupSorStdDevs: v })"
                :min="1"
                :max="5"
                :step="0.5"
                hide-details
                density="compact"
                thumb-label
                class="setting-slider"
                :disabled="generatorStore.isGenerating"
              />
            </div>
          </div>
          
          </div>

        <!-- Progress Section -->
        <div v-if="generatorStore.progress" class="section">
          <div class="section-header">
            Progress
            <v-chip size="x-small" :color="progressColor" class="ml-2">
              {{ stageLabel }}
            </v-chip>
          </div>

          <v-progress-linear
            :model-value="generatorStore.progressPercentage"
            :color="progressColor"
            height="8"
            rounded
            class="mb-3"
          />

          <div class="progress-stats">
            <div class="stat">
              <span class="stat-label">Iteration</span>
              <span class="stat-value mono">
                {{ generatorStore.progress.currentIteration.toLocaleString() }} / {{ generatorStore.progress.totalIterations.toLocaleString() }}
              </span>
            </div>
            <div class="stat">
              <span class="stat-label">Splats</span>
              <span class="stat-value mono">{{ generatorStore.splatCount.toLocaleString() }}</span>
            </div>
            <div class="stat" v-if="generatorStore.progress.loss > 0">
              <span class="stat-label">Loss</span>
              <span class="stat-value mono">{{ generatorStore.progress.loss.toFixed(4) }}</span>
            </div>
          </div>

          <p class="progress-message">{{ generatorStore.progress.message }}</p>
        </div>
        
        <!-- Generation Controls -->
        <div class="section actions">
          <template v-if="generatorStore.isGenerating">
            <v-btn
              prepend-icon="mdi-check-circle"
              variant="flat"
              color="success"
              block
              class="mb-2"
              @click="generatorStore.acceptCurrentResult"
              :disabled="!generatorStore.intermediateResult"
            >
              Good Enough
            </v-btn>
            <v-btn
              prepend-icon="mdi-stop"
              variant="outlined"
              color="error"
              block
              size="small"
              @click="generatorStore.cancelGeneration"
            >
              Cancel
            </v-btn>
          </template>

          <template v-else-if="generatorStore.currentStage === 'complete'">
            <v-btn
              prepend-icon="mdi-cube-scan"
              variant="flat"
              color="success"
              block
              class="mb-2"
              @click="loadResultToScene"
            >
              Load to Scene
            </v-btn>
            
            <div class="export-buttons">
              <v-btn
                prepend-icon="mdi-download"
                variant="outlined"
                size="small"
                @click="downloadPly"
              >
                .PLY
              </v-btn>
              <v-btn
                prepend-icon="mdi-download"
                variant="outlined"
                size="small"
                @click="downloadSplat"
              >
                .SPLAT
              </v-btn>
            </div>

            <v-btn
              prepend-icon="mdi-refresh"
              variant="text"
              block
              class="mt-2"
              @click="generatorStore.reset"
            >
              Generate Again
            </v-btn>
          </template>
          
          <template v-else>
            <v-btn
              prepend-icon="mdi-creation"
              variant="flat"
              color="primary"
              block
              :disabled="!generatorStore.canGenerate"
              @click="generatorStore.startGeneration"
            >
              Generate Splats
            </v-btn>
            
            <p v-if="generatorStore.images.length > 0 && generatorStore.images.length < 3" class="warning-text">
              <v-icon size="12" class="mr-1">mdi-alert</v-icon>
              Need {{ 3 - generatorStore.images.length }} more image(s)
            </p>
          </template>

          <p v-if="generatorStore.error" class="error-text">
            <v-icon size="12" class="mr-1">mdi-alert-circle</v-icon>
            {{ generatorStore.error }}
          </p>
        </div>

        <!-- Debug Section -->
        <div class="section debug-section">
          <div class="section-header">Debug</div>
          <div class="debug-buttons">
            <v-btn
              prepend-icon="mdi-cube-outline"
              variant="text"
              size="small"
              @click="babylon.showDebugCube(true)"
            >
              Test Cube
            </v-btn>
            <v-btn
              prepend-icon="mdi-camera-flip-outline"
              variant="text"
              size="small"
              @click="babylon.focusCamera()"
            >
              Focus Camera
            </v-btn>
          </div>
        </div>
      </template>
      
      <!-- WebGPU Not Supported -->
      <div v-else-if="webgpuChecked" class="not-supported">
        <v-icon size="48" color="warning" class="mb-3">
          mdi-alert-outline
        </v-icon>
        <p class="mb-2">WebGPU Not Available</p>
        <p class="text-caption text-grey">
          Browser-based generation requires WebGPU support.
        </p>
        <v-divider class="my-4" />
        <p class="text-caption text-grey-darken-1">
          Supported browsers:
        </p>
        <ul class="browser-list">
          <li>Chrome 113+</li>
          <li>Edge 113+</li>
          <li>Firefox Nightly (flag enabled)</li>
        </ul>
      </div>

      <!-- Loading WebGPU check -->
      <div v-else class="loading-check">
        <v-progress-circular indeterminate size="24" color="primary" />
        <p class="mt-2 text-grey">Checking WebGPU support...</p>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.panel {
  height: 100%;
  max-height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.quantum-panel-header {
  flex-shrink: 0;
}

.quantum-panel-content {
  flex: 1 1 0;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 12px;
  padding-bottom: 48px; /* Extra padding at bottom for scroll */
}

.section {
  margin-bottom: 20px;
  padding-bottom: 20px;
  border-bottom: 1px solid #3A3A4A;
  
  &:last-child, &.actions {
    border-bottom: none;
  }
}

.section-header {
  display: flex;
  align-items: center;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: #9898A8;
  margin-bottom: 12px;
}

.subsection-header {
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  color: #7878A8;
  margin-bottom: 8px;
  padding-top: 8px;
  border-top: 1px solid rgba(255, 255, 255, 0.05);
}

.setting-slider {
  flex: 1;
  min-width: 100px;
}

.image-count {
  margin-left: auto;
  color: #6B8AFF;
}

.drop-zone {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 32px;
  border: 2px dashed #3A3A4A;
  border-radius: 8px;
  color: #5A5A6A;
  cursor: pointer;
  transition: border-color 0.2s ease, background 0.2s ease;
  margin-bottom: 12px;

  &:hover {
    border-color: #6B8AFF;
    background: rgba(#6B8AFF, 0.05);
  }

  &--active {
    border-color: #6B8AFF;
    background: rgba(#6B8AFF, 0.1);
    color: #6B8AFF;
  }
}

.image-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  margin-bottom: 12px;
}

.image-thumb {
  position: relative;
  aspect-ratio: 1;
  border-radius: 6px;
  overflow: hidden;
  background: #252532;
  
  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  
  .remove-btn {
    position: absolute;
    top: 2px;
    right: 2px;
    opacity: 0;
    transition: opacity 0.15s ease;
  }
  
  &:hover .remove-btn {
    opacity: 1;
  }
}

.upload-actions {
  display: flex;
  gap: 8px;
}

.hint {
  display: flex;
  align-items: center;
  font-size: 0.75rem;
  color: #5A5A6A;
  margin-top: 8px;
}

.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.setting-label {
  font-size: 0.875rem;
  color: #9898A8;
}

.setting-input {
  max-width: 120px;
}

.mono-input :deep(input) {
  font-family: 'JetBrains Mono', 'Consolas', monospace;
}

.progress-stats {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px;
  margin-bottom: 12px;
}

.stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.stat-label {
  font-size: 0.625rem;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: #5A5A6A;
}

.stat-value {
  font-size: 0.875rem;
  color: #E8E8F0;
}

.progress-message {
  font-size: 0.75rem;
  color: #9898A8;
  font-style: italic;
}

.warning-text {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.75rem;
  color: #FFB347;
  margin-top: 8px;
}

.error-text {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.75rem;
  color: #FF6B6B;
  margin-top: 8px;
}

.export-buttons {
  display: flex;
  gap: 8px;
  justify-content: center;
}

.not-supported {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 48px 24px;
  color: #9898A8;
}

.browser-list {
  list-style: none;
  padding: 0;
  margin-top: 8px;
  
  li {
    font-size: 0.75rem;
    color: #5A5A6A;
    padding: 4px 0;
  }
}

.loading-check {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 48px;
}

.debug-section {
  border-top: 1px dashed #3A3A4A;
  margin-top: auto;
  padding-top: 12px;
}

.debug-buttons {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.mode-toggle {
  width: 100%;
  display: flex !important;
  flex-wrap: nowrap !important;
  
  :deep(.v-btn-group) {
    display: flex;
    flex-wrap: nowrap;
    width: 100%;
  }
  
  :deep(.v-btn) {
    flex: 1;
    min-width: 0 !important;
    padding: 0 6px !important;
    font-size: 0.65rem !important;
    
    .v-icon {
      margin-right: 2px !important;
    }
  }
}

.mode-hint {
  font-size: 0.7rem;
  color: #5A5A6A;
  margin-top: 8px;
  line-height: 1.4;
}

.backend-warning {
  code {
    background: rgba(107, 138, 255, 0.1);
    padding: 4px 8px;
    border-radius: 4px;
    font-size: 0.75rem;
    color: #6B8AFF;
  }
}

</style>
