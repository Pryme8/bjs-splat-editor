<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useVideoFrameStore } from '@/stores/videoFrameStore'
import DragNumberInput from '@/components/common/DragNumberInput.vue'

const props = defineProps<{
  duration: number
  videoSrc?: string | null
}>()

const emit = defineEmits<{
  (e: 'seek', time: number): void
  (e: 'rangeComplete', startTime: number, endTime: number): void
}>()

const store = useVideoFrameStore()

const trackRef = ref<HTMLElement | null>(null)
const previewVideoRef = ref<HTMLVideoElement | null>(null)
const isDraggingPlayhead = ref(false)
const isDraggingRange = ref(false)
const rangeEndTime = ref<number | null>(null)
const showRangePopup = ref(false)
const rangeInterval = ref(1)
const presetInterval = ref<number | null>(1)  // Track which preset is selected

// Computed to validate interval
const isValidInterval = computed(() => {
  return rangeInterval.value > 0 && rangeInterval.value <= 60
})

// Select a preset interval
function selectPresetInterval(value: number | null) {
  if (value !== null) {
    presetInterval.value = value
    rangeInterval.value = value
  }
}

// Clear preset selection when using custom input
function clearPresetSelection() {
  presetInterval.value = null
}

// Hover preview state
const isHovering = ref(false)
const hoverTime = ref(0)
const hoverScreenX = ref(0)  // Screen X position for fixed positioning
const hoverScreenY = ref(0)  // Screen Y position for fixed positioning
const previewVideoReady = ref(false)
let seekDebounceTimer: ReturnType<typeof setTimeout> | null = null

// Visible time range based on zoom
const visibleDuration = computed(() => props.duration / store.zoomLevel)
const pixelsPerSecond = computed(() => {
  if (!trackRef.value) return 100
  return trackRef.value.clientWidth / visibleDuration.value
})

// Time markers for the ruler
const timeMarkers = computed(() => {
  const markers: { time: number; label: string; major: boolean }[] = []
  const { start, end } = store.visibleTimeRange
  
  // Determine marker interval based on zoom
  let interval = 1
  if (visibleDuration.value > 120) interval = 30
  else if (visibleDuration.value > 60) interval = 10
  else if (visibleDuration.value > 30) interval = 5
  else if (visibleDuration.value > 10) interval = 2
  else if (visibleDuration.value > 5) interval = 1
  else interval = 0.5
  
  const startMarker = Math.ceil(start / interval) * interval
  
  for (let t = startMarker; t <= end; t += interval) {
    markers.push({
      time: t,
      label: formatTime(t),
      major: t % (interval * 2) === 0 || interval >= 5
    })
  }
  
  return markers
})

// Convert time to pixel position
function timeToPixel(time: number): number {
  const relativeTime = time - store.scrollOffset
  return relativeTime * pixelsPerSecond.value
}

// Convert pixel position to time
function pixelToTime(pixel: number): number {
  return (pixel / pixelsPerSecond.value) + store.scrollOffset
}

// Format time as MM:SS.ms
function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  if (visibleDuration.value < 10) {
    return `${mins}:${secs.toFixed(1).padStart(4, '0')}`
  }
  return `${mins}:${Math.floor(secs).toString().padStart(2, '0')}`
}

// Handle track click
function handleTrackClick(e: MouseEvent) {
  if (isDraggingPlayhead.value || isDraggingRange.value) return
  
  const rect = trackRef.value!.getBoundingClientRect()
  const x = e.clientX - rect.left
  const time = Math.max(0, Math.min(pixelToTime(x), props.duration))
  
  if (store.activeTool === 'flag') {
    store.toggleFlag(time)
  } else if (store.activeTool === 'range') {
    if (store.activeRangeStart === null) {
      store.startRangeSelection(time)
    }
  } else {
    emit('seek', time)
  }
}

// Handle track mouse down for drag operations
function handleTrackMouseDown(e: MouseEvent) {
  if (store.activeTool === 'scrub') {
    isDraggingPlayhead.value = true
    handleTrackDrag(e)
  } else if (store.activeTool === 'range' && store.activeRangeStart !== null) {
    isDraggingRange.value = true
    handleRangeDrag(e)
  }
}

function handleTrackDrag(e: MouseEvent) {
  if (!trackRef.value) return
  
  const rect = trackRef.value.getBoundingClientRect()
  const x = e.clientX - rect.left
  const time = Math.max(0, Math.min(pixelToTime(x), props.duration))
  
  emit('seek', time)
}

function handleRangeDrag(e: MouseEvent) {
  if (!trackRef.value || store.activeRangeStart === null) return
  
  const rect = trackRef.value.getBoundingClientRect()
  const x = e.clientX - rect.left
  rangeEndTime.value = Math.max(0, Math.min(pixelToTime(x), props.duration))
}

function handleMouseUp() {
  if (isDraggingPlayhead.value) {
    isDraggingPlayhead.value = false
  }
  
  if (isDraggingRange.value && rangeEndTime.value !== null) {
    isDraggingRange.value = false
    showRangePopup.value = true
  }
}

function handleMouseMove(e: MouseEvent) {
  if (isDraggingPlayhead.value) {
    handleTrackDrag(e)
  } else if (isDraggingRange.value) {
    handleRangeDrag(e)
  }
}

// Confirm range selection
function confirmRange() {
  if (store.activeRangeStart !== null && rangeEndTime.value !== null) {
    store.completeRangeSelection(rangeEndTime.value, rangeInterval.value)
    emit('rangeComplete', store.activeRangeStart, rangeEndTime.value)
  }
  
  showRangePopup.value = false
  rangeEndTime.value = null
  rangeInterval.value = 1
}

function cancelRange() {
  store.cancelRangeSelection()
  showRangePopup.value = false
  rangeEndTime.value = null
}

// Mouse wheel zoom
function handleWheel(e: WheelEvent) {
  e.preventDefault()
  
  if (e.ctrlKey || e.metaKey) {
    // Zoom
    const delta = e.deltaY > 0 ? -1 : 1
    store.setZoomLevel(store.zoomLevel + delta * 0.5)
  } else {
    // Scroll horizontally
    const scrollDelta = e.deltaY * 0.1 * (visibleDuration.value / 10)
    store.setScrollOffset(store.scrollOffset + scrollDelta)
  }
}

// Preview video handlers
function onPreviewVideoLoaded() {
  previewVideoReady.value = true
}

// Hover preview handlers
function handleTrackMouseEnter() {
  isHovering.value = true
}

function handleTrackMouseLeave() {
  isHovering.value = false
  if (seekDebounceTimer) {
    clearTimeout(seekDebounceTimer)
    seekDebounceTimer = null
  }
}

function handleTrackMouseMovePreview(e: MouseEvent) {
  if (!trackRef.value || isDraggingPlayhead.value || isDraggingRange.value) return
  
  const rect = trackRef.value.getBoundingClientRect()
  const x = e.clientX - rect.left
  const time = Math.max(0, Math.min(pixelToTime(x), props.duration))
  
  // Store screen coordinates for fixed positioning
  hoverScreenX.value = e.clientX
  hoverScreenY.value = rect.top  // Top of the track
  hoverTime.value = time
  
  // Debounce seeking the preview video
  if (seekDebounceTimer) {
    clearTimeout(seekDebounceTimer)
  }
  
  seekDebounceTimer = setTimeout(() => {
    seekPreviewVideo(time)
  }, 50)
}

function seekPreviewVideo(time: number) {
  if (!previewVideoRef.value || !previewVideoReady.value) return
  previewVideoRef.value.currentTime = time
}

// Format hover time for display
const hoverTimeFormatted = computed(() => {
  const mins = Math.floor(hoverTime.value / 60)
  const secs = hoverTime.value % 60
  return `${mins}:${secs.toFixed(2).padStart(5, '0')}`
})

// Compute preview tooltip position using fixed positioning
const previewStyle = computed(() => {
  const tooltipWidth = 168 // 160px + borders
  const tooltipHeight = 120 // thumbnail 90px + time label + padding
  const halfWidth = tooltipWidth * 0.5
  
  // Clamp X to viewport edges
  let left = Math.max(halfWidth + 8, Math.min(hoverScreenX.value, window.innerWidth - halfWidth - 8))
  
  // Position above the track
  const top = hoverScreenY.value - tooltipHeight - 8
  
  return {
    left: `${left}px`,
    top: `${Math.max(8, top)}px`  // Ensure at least 8px from top of viewport
  }
})

// Remove a flag when clicked
function handleFlagClick(time: number, e: MouseEvent) {
  e.stopPropagation()
  store.removeFlag(time)
}

// Jump to flag time
function handleFlagDoubleClick(time: number) {
  emit('seek', time)
}

// Range position calculations
function getRangeStyle(range: { startTime: number; endTime: number }) {
  const startPx = timeToPixel(range.startTime)
  const endPx = timeToPixel(range.endTime)
  const width = endPx - startPx
  
  return {
    left: `${startPx}px`,
    width: `${Math.max(width, 2)}px`
  }
}

// Active range preview style
const activeRangeStyle = computed(() => {
  if (store.activeRangeStart === null) return null
  
  const end = rangeEndTime.value ?? store.currentTime
  const startPx = timeToPixel(Math.min(store.activeRangeStart, end))
  const endPx = timeToPixel(Math.max(store.activeRangeStart, end))
  
  return {
    left: `${startPx}px`,
    width: `${Math.max(endPx - startPx, 2)}px`
  }
})

// Count frames in preview range
const activeRangeFrameCount = computed(() => {
  if (store.activeRangeStart === null || rangeEndTime.value === null) return 0
  
  const start = Math.min(store.activeRangeStart, rangeEndTime.value)
  const end = Math.max(store.activeRangeStart, rangeEndTime.value)
  
  return Math.floor((end - start) / rangeInterval.value) + 1
})

// Setup global mouse handlers
onMounted(() => {
  window.addEventListener('mousemove', handleMouseMove)
  window.addEventListener('mouseup', handleMouseUp)
})

onUnmounted(() => {
  window.removeEventListener('mousemove', handleMouseMove)
  window.removeEventListener('mouseup', handleMouseUp)
  
  // Cleanup seek timer
  if (seekDebounceTimer) {
    clearTimeout(seekDebounceTimer)
  }
})
</script>

<template>
  <div class="timeline-editor">
    <!-- Zoom controls -->
    <div class="zoom-controls">
      <v-btn
        icon="mdi-minus"
        size="x-small"
        variant="text"
        :disabled="store.zoomLevel <= 1"
        @click="store.setZoomLevel(store.zoomLevel - 1)"
      />
      <span class="zoom-label mono">{{ Math.round(store.zoomLevel * 100) }}%</span>
      <v-btn
        icon="mdi-plus"
        size="x-small"
        variant="text"
        :disabled="store.zoomLevel >= 20"
        @click="store.setZoomLevel(store.zoomLevel + 1)"
      />
    </div>
    
    <!-- Hover preview tooltip - fixed position to avoid clipping -->
    <Teleport to="body">
      <div
        v-if="isHovering && !isDraggingPlayhead && !isDraggingRange && props.videoSrc"
        :style="{
          position: 'fixed',
          transform: 'translateX(-50%)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          pointerEvents: 'none',
          zIndex: 9999,
          ...previewStyle
        }"
      >
        <div
          :style="{
            width: '160px',
            height: '90px',
            background: '#0D0D12',
            border: '1px solid #3A3A4A',
            borderRadius: '6px',
            overflow: 'hidden',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.5)',
            position: 'relative'
          }"
        >
          <video
            ref="previewVideoRef"
            :src="props.videoSrc"
            :style="{
              width: '100%',
              height: '100%',
              objectFit: 'contain'
            }"
            muted
            preload="metadata"
            @loadedmetadata="onPreviewVideoLoaded"
          />
          <div
            v-if="!previewVideoReady"
            :style="{
              position: 'absolute',
              inset: '0',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: '#0D0D12'
            }"
          >
            <v-progress-circular indeterminate size="20" width="2" color="primary" />
          </div>
        </div>
        <div
          :style="{
            marginTop: '4px',
            padding: '2px 8px',
            background: '#1A1A24',
            border: '1px solid #3A3A4A',
            borderRadius: '4px',
            fontSize: '0.75rem',
            color: '#E8E8F0',
            boxShadow: '0 2px 8px rgba(0, 0, 0, 0.3)',
            fontFamily: 'JetBrains Mono, Fira Code, Consolas, monospace'
          }"
        >
          {{ hoverTimeFormatted }}
        </div>
      </div>
    </Teleport>
    
    <!-- Timeline track -->
    <div class="timeline-wrapper">
      <!-- Time ruler -->
      <div class="time-ruler">
        <div
          v-for="marker in timeMarkers"
          :key="marker.time"
          class="time-marker"
          :class="{ major: marker.major }"
          :style="{ left: `${timeToPixel(marker.time)}px` }"
        >
          <span class="marker-label mono">{{ marker.label }}</span>
        </div>
      </div>
      
      <!-- Main track area -->
      <div
        ref="trackRef"
        class="timeline-track"
        @click="handleTrackClick"
        @mousedown="handleTrackMouseDown"
        @wheel="handleWheel"
        @mouseenter="handleTrackMouseEnter"
        @mouseleave="handleTrackMouseLeave"
        @mousemove="handleTrackMouseMovePreview"
      >
        <!-- Range selections -->
        <div
          v-for="range in store.rangeSelections"
          :key="range.id"
          class="range-selection"
          :style="getRangeStyle(range)"
        >
          <v-btn
            icon="mdi-close"
            size="x-small"
            variant="flat"
            class="range-remove"
            @click.stop="store.removeRange(range.id)"
          />
        </div>
        
        <!-- Active range preview -->
        <div
          v-if="activeRangeStyle && store.activeRangeStart !== null"
          class="range-selection range-preview"
          :style="activeRangeStyle"
        />
        
        <!-- Frame flags -->
        <div
          v-for="flag in store.sortedFlags"
          :key="flag"
          class="frame-flag"
          :style="{ left: `${timeToPixel(flag)}px` }"
          @click.stop="handleFlagClick(flag, $event)"
          @dblclick.stop="handleFlagDoubleClick(flag)"
        >
          <div class="flag-marker" />
        </div>
        
        <!-- Playhead -->
        <div
          class="playhead"
          :style="{ left: `${timeToPixel(store.currentTime)}px` }"
        >
          <div class="playhead-head" />
          <div class="playhead-line" />
        </div>
      </div>
    </div>
    
    <!-- Range interval popup -->
    <v-dialog v-model="showRangePopup" max-width="320" persistent>
      <v-card class="range-popup">
        <v-card-title class="text-body-1">
          <v-icon size="small" class="mr-2">mdi-selection-ellipse-arrow-inside</v-icon>
          Range Selection
        </v-card-title>
        
        <v-card-text>
          <div class="range-info mb-3">
            <span class="text-secondary">Frames to extract:</span>
            <span class="mono ml-2">{{ activeRangeFrameCount }}</span>
          </div>
          
          <div class="interval-setting">
            <span class="text-secondary">Extract every:</span>
            <v-btn-toggle
              :model-value="presetInterval"
              @update:model-value="selectPresetInterval"
              density="compact"
              class="mt-2"
            >
              <v-btn :value="0.5" size="small">0.5s</v-btn>
              <v-btn :value="1" size="small">1s</v-btn>
              <v-btn :value="2" size="small">2s</v-btn>
              <v-btn :value="5" size="small">5s</v-btn>
            </v-btn-toggle>
            
            <div class="custom-interval mt-3">
              <span class="text-secondary">Or custom:</span>
              <DragNumberInput
                v-model="rangeInterval"
                :min="0.1"
                :max="60"
                :step="0.1"
                suffix="sec"
                class="custom-interval-input"
                @focus="clearPresetSelection"
              />
            </div>
          </div>
        </v-card-text>
        
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="cancelRange">Cancel</v-btn>
          <v-btn color="primary" variant="flat" @click="confirmRange" :disabled="!isValidInterval">Add Range</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<style scoped lang="scss">
$background-deep: #0D0D12;
$background-surface: #1A1A24;
$background-elevated: #252532;
$border-subtle: #3A3A4A;
$text-primary: #E8E8F0;
$text-secondary: #9898A8;
$text-muted: #5A5A6A;
$accent-primary: #6B8AFF;

.timeline-editor {
  display: flex;
  flex-direction: column;
  gap: 8px;
  user-select: none;
}

.zoom-controls {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 4px 0;
  
  .zoom-label {
    font-size: 0.75rem;
    color: $text-secondary;
    min-width: 48px;
    text-align: center;
  }
}

.timeline-wrapper {
  position: relative;
  background: $background-elevated;
  border-radius: 6px;
  overflow: hidden;
}

.time-ruler {
  position: relative;
  height: 24px;
  background: $background-surface;
  border-bottom: 1px solid $border-subtle;
  overflow: hidden;
  
  .time-marker {
    position: absolute;
    top: 0;
    height: 100%;
    border-left: 1px solid $border-subtle;
    
    &.major {
      border-left-color: $text-muted;
      
      .marker-label {
        opacity: 1;
      }
    }
    
    .marker-label {
      position: absolute;
      top: 4px;
      left: 4px;
      font-size: 0.625rem;
      color: $text-muted;
      opacity: 0.6;
      white-space: nowrap;
    }
  }
}

.timeline-track {
  position: relative;
  height: 48px;
  cursor: crosshair;
  overflow: hidden;
  
  &:active {
    cursor: grabbing;
  }
}

.range-selection {
  position: absolute;
  top: 0;
  height: 100%;
  background: rgba($accent-primary, 0.2);
  border-left: 2px solid $accent-primary;
  border-right: 2px solid $accent-primary;
  pointer-events: auto;
  
  &.range-preview {
    background: rgba($accent-primary, 0.1);
    border-style: dashed;
    pointer-events: none;
  }
  
  .range-remove {
    position: absolute;
    top: 2px;
    right: 2px;
    opacity: 0;
    transition: opacity 0.15s ease;
  }
  
  &:hover .range-remove {
    opacity: 1;
  }
}

.frame-flag {
  position: absolute;
  top: 0;
  height: 100%;
  width: 12px;
  margin-left: -6px;
  cursor: pointer;
  z-index: 10;
  
  .flag-marker {
    position: absolute;
    top: 0;
    left: 50%;
    width: 2px;
    height: 100%;
    background: $accent-primary;
    transform: translateX(-50%);
    
    &::before {
      content: '';
      position: absolute;
      top: 0;
      left: 50%;
      transform: translateX(-50%);
      width: 8px;
      height: 8px;
      background: $accent-primary;
      border-radius: 50%;
    }
  }
  
  &:hover .flag-marker {
    background: #FF6B6B;
    
    &::before {
      background: #FF6B6B;
    }
  }
}

.playhead {
  position: absolute;
  top: 0;
  height: 100%;
  width: 0;
  pointer-events: none;
  z-index: 20;
  
  .playhead-head {
    position: absolute;
    top: -4px;
    left: -6px;
    width: 0;
    height: 0;
    border-left: 6px solid transparent;
    border-right: 6px solid transparent;
    border-top: 8px solid $text-primary;
  }
  
  .playhead-line {
    position: absolute;
    top: 4px;
    left: 0;
    width: 2px;
    height: calc(100% + 24px);
    background: $text-primary;
    transform: translateX(-50%);
  }
}

.hover-preview {
  position: fixed;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  pointer-events: none;
  z-index: 9999;
  
  .preview-thumbnail {
    width: 160px;
    height: 90px;
    background: $background-deep;
    border: 1px solid $border-subtle;
    border-radius: 6px;
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
    position: relative;
    
    .preview-video {
      width: 100%;
      height: 100%;
      object-fit: contain;
    }
    
    .preview-loading {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      background: $background-deep;
    }
  }
  
  .preview-time {
    margin-top: 4px;
    padding: 2px 8px;
    background: $background-surface;
    border: 1px solid $border-subtle;
    border-radius: 4px;
    font-size: 0.75rem;
    color: $text-primary;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  
  // Arrow pointing down
  &::after {
    content: '';
    position: absolute;
    bottom: -6px;
    left: 50%;
    transform: translateX(-50%);
    width: 0;
    height: 0;
    border-left: 6px solid transparent;
    border-right: 6px solid transparent;
    border-top: 6px solid $border-subtle;
  }
}

.range-popup {
  background: $background-surface !important;
  
  .range-info {
    display: flex;
    align-items: center;
  }
  
  .interval-setting {
    display: flex;
    flex-direction: column;
  }
  
  .custom-interval {
    display: flex;
    align-items: center;
    gap: 12px;
    
    .custom-interval-input {
      max-width: 120px;
      
      :deep(input) {
        font-family: 'JetBrains Mono', 'Fira Code', 'Consolas', monospace;
        text-align: right;
      }
    }
  }
}

.mono {
  font-family: 'JetBrains Mono', 'Fira Code', 'Consolas', monospace;
}
</style>
