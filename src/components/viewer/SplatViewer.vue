<template>
  <div class="splat-viewer" ref="containerRef">
    <canvas ref="canvasRef" class="viewer-canvas"></canvas>
    
    <!-- Loading overlay -->
    <div v-if="viewer.isLoading.value" class="viewer-overlay">
      <v-progress-circular indeterminate color="primary"></v-progress-circular>
      <div class="mt-2">Loading splats...</div>
    </div>

    <!-- Error overlay -->
    <div v-if="viewer.error.value" class="viewer-overlay error">
      <v-icon size="large" color="error">mdi-alert-circle</v-icon>
      <div class="mt-2 text-error">{{ viewer.error.value }}</div>
    </div>

    <!-- Waypoint controls (only if waypoints exist and controls are shown) -->
    <WaypointControls
      v-if="showControls && sqpzData && sqpzData.waypoints.length > 0"
      :waypoints="sqpzData.waypoints"
      :current-index="viewer.currentWaypointIndex.value"
      :is-animating="viewer.isAnimating.value"
      @go-to="handleGoToWaypoint"
      @next="handleNext"
      @prev="handlePrev"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import { useViewer } from '@/composables/useViewer'
import WaypointControls from './WaypointControls.vue'
import type { SqpzFile } from '@/types/sqpz'

interface Props {
  sqpzData: SqpzFile | null
  splatBuffers?: ArrayBuffer[]
  showControls?: boolean
  autoRotate?: boolean
  initialWaypoint?: number
}

const props = withDefaults(defineProps<Props>(), {
  showControls: true,
  autoRotate: false,
  initialWaypoint: 0
})

const containerRef = ref<HTMLDivElement | null>(null)
const canvasRef = ref<HTMLCanvasElement | null>(null)
const viewer = useViewer()
let resizeObserver: ResizeObserver | null = null
let isInitialized = ref(false)

onMounted(() => {
  if (canvasRef.value && props.sqpzData && props.splatBuffers) {
    initializeViewer()
  }
  
  // Setup resize observer to handle panel open/close
  if (containerRef.value) {
    resizeObserver = new ResizeObserver(() => {
      // Trigger viewer engine resize
      viewer.resizeEngine()
    })
    resizeObserver.observe(containerRef.value)
  }
})

onBeforeUnmount(() => {
  console.log('[SplatViewer] Unmounting, disposing viewer')
  if (resizeObserver) {
    resizeObserver.disconnect()
    resizeObserver = null
  }
  viewer.dispose()
  isInitialized.value = false
})

watch(() => [props.sqpzData, props.splatBuffers], ([newData, newBuffers]) => {
  if (newData && newBuffers && canvasRef.value && !isInitialized.value) {
    initializeViewer()
  }
})

async function initializeViewer() {
  if (!canvasRef.value || !props.sqpzData || !props.splatBuffers) return
  if (isInitialized.value) {
    console.log('[SplatViewer] Already initialized, skipping')
    return
  }

  console.log('[SplatViewer] Initializing viewer with', props.sqpzData.splats.length, 'splats and', props.sqpzData.waypoints.length, 'waypoints')
  
  viewer.initScene(canvasRef.value, props.sqpzData)
  await viewer.loadSplats(props.sqpzData, props.splatBuffers)
  
  isInitialized.value = true

  // Don't automatically jump to a waypoint - start with the camera position from metadata
  // Users can manually navigate to waypoints using the controls
  console.log('[SplatViewer] Viewer initialized, staying at metadata camera position')
}

function handleGoToWaypoint(index: number) {
  if (props.sqpzData) {
    viewer.goToWaypoint(index, props.sqpzData.waypoints)
  }
}

function handleNext() {
  if (props.sqpzData) {
    viewer.nextWaypoint(props.sqpzData.waypoints)
  }
}

function handlePrev() {
  if (props.sqpzData) {
    viewer.prevWaypoint(props.sqpzData.waypoints)
  }
}
</script>

<style scoped>
.splat-viewer {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: #0D0D12;
}

.viewer-canvas {
  width: 100% !important;
  height: 100% !important;
  display: block;
  outline: none;
  touch-action: none;
}

.viewer-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.7);
  color: white;
  z-index: 10;
}

.viewer-overlay.error {
  background: rgba(139, 0, 0, 0.7);
}
</style>
