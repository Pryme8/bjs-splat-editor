<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useBabylon } from '@/composables/useBabylon'
import { useAppStore } from '@/stores/appStore'
import { useGeneratorStore } from '@/stores/generatorStore'
import { useSplatEditor } from '@/composables/useSplatEditor'
import SplatViewer from '@/components/viewer/SplatViewer.vue'

const canvasRef = ref<HTMLCanvasElement | null>(null)
const appStore = useAppStore()
const generatorStore = useGeneratorStore()
const editor = useSplatEditor()

const { initScene, dispose } = useBabylon()

// Hide empty state when we have content OR we're generating (COLMAP preview shows during generation)
const showEmptyState = computed(() => {
  return !appStore.hasScene && !generatorStore.isGenerating && !appStore.viewerMode
})

// Show editor canvas (hide in viewer mode)
const showEditorCanvas = computed(() => !appStore.viewerMode)

onMounted(() => {
  if (canvasRef.value) {
    initScene(canvasRef.value)
  }
})

onBeforeUnmount(() => {
  dispose()
})

function handleDragOver(e: DragEvent) {
  e.preventDefault()
  e.dataTransfer!.dropEffect = 'copy'
}

async function handleDrop(e: DragEvent) {
  e.preventDefault()
  const file = e.dataTransfer?.files[0]
  if (file && /\.(ply|splat|spz)$/i.test(file.name)) {
    await appStore.loadFile(file)
  }
}

// Note: Selection brush pointer events are now handled automatically by
// Babylon's scene.onPointerObservable when the brush is enabled
</script>

<template>
  <div 
    class="canvas-container"
    @dragover="handleDragOver"
    @drop="handleDrop"
  >
    <!-- Editor Canvas -->
    <canvas v-show="showEditorCanvas" ref="canvasRef" />
    
    <!-- Viewer Component -->
    <SplatViewer
      v-if="appStore.viewerMode && appStore.currentSqpzData"
      :sqpz-data="appStore.currentSqpzData"
      :splat-buffers="appStore.currentSqpzBuffers"
      :show-controls="true"
    />
    
    <transition name="fade">
      <div v-if="appStore.isLoading" class="loading-overlay">
        <v-progress-circular
          indeterminate
          color="primary"
          size="48"
        />
      </div>
    </transition>
    
    <div v-if="showEmptyState" class="empty-state">
      <v-icon size="64" color="grey-darken-1">mdi-cube-scan</v-icon>
      <p class="mt-4 text-grey">Drop a .ply, .splat, or .spz file here</p>
      <p class="text-grey-darken-1 text-caption">or use Import from the toolbar</p>
    </div>

    <!-- Camera Controls Overlay (only in editor mode) -->
    <div v-if="showEditorCanvas" class="camera-overlay">
      <div class="camera-buttons">
        <v-btn
          :icon="editor.cameraMode.value === 'orbit' ? 'mdi-orbit' : 'mdi-orbit-variant'"
          size="small"
          :variant="editor.cameraMode.value === 'orbit' ? 'flat' : 'text'"
          :color="editor.cameraMode.value === 'orbit' ? 'primary' : undefined"
          @click="editor.setCameraMode('orbit')"
          title="Orbit Camera (rotate around target)"
        />
        <v-btn
          :icon="editor.cameraMode.value === 'fly' ? 'mdi-airplane' : 'mdi-airplane-off'"
          size="small"
          :variant="editor.cameraMode.value === 'fly' ? 'flat' : 'text'"
          :color="editor.cameraMode.value === 'fly' ? 'primary' : undefined"
          @click="editor.setCameraMode('fly')"
          title="Fly Camera (6DOF drone mode - WASD+QE+RF)"
        />
        <v-divider vertical class="mx-1" />
        <v-btn
          icon="mdi-crosshairs-gps"
          size="small"
          variant="text"
          :disabled="!appStore.hasScene"
          @click="editor.focusOnSplat"
          title="Focus on Splat"
        />
        <v-divider vertical class="mx-1" />
        <v-btn
          icon="mdi-debug-step-over"
          size="small"
          variant="text"
          @click="editor.toggleInspector"
          title="Toggle Inspector (Ctrl+Shift+I)"
        />
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.canvas-container {
  flex: 1;
  min-width: 0;
  min-height: 0;
  position: relative;
  overflow: hidden;
  background: #0D0D12;
  contain: strict;
  
  canvas {
    width: 100% !important;
    height: 100% !important;
    outline: none;
    display: block;
    touch-action: none;
  }
}

.loading-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(#0D0D12, 0.8);
  backdrop-filter: blur(4px);
  z-index: 100;
}

.empty-state {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}

.camera-overlay {
  position: absolute;
  top: 12px;
  right: 12px;
  z-index: 50;
}

.camera-buttons {
  display: flex;
  align-items: center;
  gap: 2px;
  background: rgba(26, 26, 36, 0.85);
  backdrop-filter: blur(8px);
  border-radius: 8px;
  padding: 4px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  
  .v-btn {
    min-width: 32px;
    width: 32px;
    height: 32px;
  }
  
  .v-divider {
    height: 20px;
    opacity: 0.3;
  }
}
</style>
