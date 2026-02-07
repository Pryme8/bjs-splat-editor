<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useVideoFrameStore } from '@/stores/videoFrameStore'
import { useFrameExtraction } from '@/composables/useFrameExtraction'
import TimelineEditor from '@/components/editors/TimelineEditor.vue'

const emit = defineEmits<{
  (e: 'frames-extracted', files: File[]): void
  (e: 'close'): void
}>()

const store = useVideoFrameStore()
const frameExtraction = useFrameExtraction()

const videoRef = ref<HTMLVideoElement | null>(null)
const videoContainerRef = ref<HTMLElement | null>(null)

// Video state
const videoReady = ref(false)

// Tool labels
const toolLabels = {
  flag: 'Add Flags',
  range: 'Range Select',
  scrub: 'Scrub'
}

// Computed
const canExport = computed(() => store.totalFlagCount > 0 && !store.isExtracting)

const currentTimeFormatted = computed(() => {
  return formatTime(store.currentTime)
})

const durationFormatted = computed(() => {
  return formatTime(store.videoDuration)
})

// Format time as MM:SS
function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
}

// Video event handlers
function onVideoLoaded() {
  if (!videoRef.value) return
  
  store.setVideoMetadata(
    videoRef.value.duration,
    videoRef.value.videoWidth,
    videoRef.value.videoHeight
  )
  videoReady.value = true
}

function onVideoError(e: Event) {
  console.error('Video error:', e)
  store.setVideoError('Failed to load video. Format may not be supported.')
}

function onTimeUpdate() {
  if (!videoRef.value) return
  store.setCurrentTime(videoRef.value.currentTime)
}

function onPlayPause() {
  if (!videoRef.value) return
  store.setIsPlaying(!videoRef.value.paused)
}

// Playback controls
function togglePlay() {
  if (!videoRef.value) return
  
  if (videoRef.value.paused) {
    videoRef.value.play()
  } else {
    videoRef.value.pause()
  }
}

function seekTo(time: number) {
  if (!videoRef.value) return
  videoRef.value.currentTime = time
  store.setCurrentTime(time)
}

function stepFrame(direction: number) {
  // Approximate frame step (assuming 30fps)
  const frameTime = 1 / 30
  seekTo(Math.max(0, Math.min(store.currentTime + direction * frameTime, store.videoDuration)))
}

function skipSeconds(seconds: number) {
  seekTo(Math.max(0, Math.min(store.currentTime + seconds, store.videoDuration)))
}

// Add flag at current time
function addFlagAtCurrentTime() {
  store.addFlag(store.currentTime)
}

// Handle seek from timeline
function handleTimelineSeek(time: number) {
  seekTo(time)
}

// Export frames
async function exportFrames() {
  if (!videoRef.value || !canExport.value) return
  
  try {
    // Pause during extraction
    videoRef.value.pause()
    
    const files = await frameExtraction.extractAllFromStore(videoRef.value, {
      quality: 1.0,
      format: 'image/png',
      onProgress: (current, total) => {
        console.log(`Extracting frame ${current}/${total}`)
      }
    })
    
    emit('frames-extracted', files)
    handleClose()
  } catch (e) {
    console.error('Frame extraction failed:', e)
  }
}

// Close modal
function handleClose() {
  if (store.isExtracting) return
  
  // Cleanup
  frameExtraction.cleanup()
  store.closeModal()
  emit('close')
}

// Clear all selections
function clearAll() {
  store.clearSelections()
}

// Keyboard shortcuts
function handleKeydown(e: KeyboardEvent) {
  if (!store.isModalOpen) return
  
  switch (e.key) {
    case ' ':
      e.preventDefault()
      togglePlay()
      break
    case 'ArrowLeft':
      e.preventDefault()
      if (e.shiftKey) skipSeconds(-5)
      else stepFrame(-1)
      break
    case 'ArrowRight':
      e.preventDefault()
      if (e.shiftKey) skipSeconds(5)
      else stepFrame(1)
      break
    case 'f':
    case 'F':
      e.preventDefault()
      addFlagAtCurrentTime()
      break
    case 'Escape':
      if (!store.isExtracting) handleClose()
      break
  }
}

onMounted(() => {
  window.addEventListener('keydown', handleKeydown)
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown)
})

// Sync video playback state
watch(() => store.isPlaying, (playing) => {
  if (!videoRef.value) return
  if (playing && videoRef.value.paused) {
    videoRef.value.play()
  } else if (!playing && !videoRef.value.paused) {
    videoRef.value.pause()
  }
})
</script>

<template>
  <v-dialog
    :model-value="store.isModalOpen"
    fullscreen
    persistent
    transition="dialog-bottom-transition"
    class="video-frame-modal"
  >
    <div class="modal-backdrop" @click.self="handleClose">
      <div class="modal-container">
        <!-- Header -->
        <div class="modal-header">
          <div class="header-title">
            <v-icon size="small" class="mr-2">mdi-movie-filter</v-icon>
            Video Frame Selector
          </div>
          <div class="header-info mono">
            {{ store.videoFile?.name }}
          </div>
          <v-btn
            icon="mdi-close"
            variant="text"
            size="small"
            :disabled="store.isExtracting"
            @click="handleClose"
          />
        </div>
        
        <!-- Main content -->
        <div class="modal-content">
          <!-- Video player hero -->
          <div ref="videoContainerRef" class="video-container">
            <!-- Loading state -->
            <div v-if="!videoReady && !store.videoError" class="video-loading">
              <v-progress-circular indeterminate color="primary" size="48" />
              <p class="mt-3 text-secondary">Loading video...</p>
            </div>
            
            <!-- Error state -->
            <div v-else-if="store.videoError" class="video-error">
              <v-icon size="48" color="error">mdi-alert-circle</v-icon>
              <p class="mt-3">{{ store.videoError }}</p>
            </div>
            
            <!-- Video element -->
            <video
              v-show="videoReady"
              ref="videoRef"
              :src="store.videoUrl ?? undefined"
              class="video-player"
              @loadedmetadata="onVideoLoaded"
              @error="onVideoError"
              @timeupdate="onTimeUpdate"
              @play="onPlayPause"
              @pause="onPlayPause"
            />
          </div>
          
          <!-- Playback controls -->
          <div class="playback-controls">
            <div class="controls-left">
              <v-btn
                icon="mdi-skip-backward"
                variant="text"
                size="small"
                :disabled="!videoReady"
                @click="skipSeconds(-5)"
              />
              <v-btn
                icon="mdi-skip-previous"
                variant="text"
                size="small"
                :disabled="!videoReady"
                @click="stepFrame(-1)"
              />
              <v-btn
                :icon="store.isPlaying ? 'mdi-pause' : 'mdi-play'"
                variant="flat"
                color="primary"
                size="default"
                :disabled="!videoReady"
                @click="togglePlay"
              />
              <v-btn
                icon="mdi-skip-next"
                variant="text"
                size="small"
                :disabled="!videoReady"
                @click="stepFrame(1)"
              />
              <v-btn
                icon="mdi-skip-forward"
                variant="text"
                size="small"
                :disabled="!videoReady"
                @click="skipSeconds(5)"
              />
            </div>
            
            <div class="controls-center">
              <span class="time-display mono">
                {{ currentTimeFormatted }} / {{ durationFormatted }}
              </span>
            </div>
            
            <div class="controls-right">
              <v-btn
                prepend-icon="mdi-flag-plus"
                variant="tonal"
                size="small"
                :disabled="!videoReady"
                @click="addFlagAtCurrentTime"
              >
                Add Flag (F)
              </v-btn>
            </div>
          </div>
          
          <!-- Timeline editor -->
          <div class="timeline-section">
            <TimelineEditor
              v-if="videoReady"
              :duration="store.videoDuration"
              :video-src="store.videoUrl"
              @seek="handleTimelineSeek"
            />
          </div>
          
          <!-- Tools and status -->
          <div class="tools-section">
            <div class="tools-left">
              <span class="section-label">Tool:</span>
              <v-btn-toggle
                :model-value="store.activeTool"
                @update:model-value="v => store.setActiveTool(v as any)"
                mandatory
                density="compact"
                color="primary"
              >
                <v-btn value="flag" size="small">
                  <v-icon size="small" class="mr-1">mdi-flag</v-icon>
                  Flag
                </v-btn>
                <v-btn value="range" size="small">
                  <v-icon size="small" class="mr-1">mdi-selection-drag</v-icon>
                  Range
                </v-btn>
                <v-btn value="scrub" size="small">
                  <v-icon size="small" class="mr-1">mdi-cursor-default</v-icon>
                  Scrub
                </v-btn>
              </v-btn-toggle>
              
              <v-btn
                prepend-icon="mdi-delete-sweep"
                variant="text"
                size="small"
                color="error"
                :disabled="store.totalFlagCount === 0"
                @click="clearAll"
              >
                Clear All
              </v-btn>
            </div>
            
            <div class="tools-right">
              <div class="selection-info">
                <v-icon size="small" class="mr-1">mdi-image-multiple</v-icon>
                <span class="mono">{{ store.totalFlagCount }}</span>
                <span class="text-secondary ml-1">frames selected</span>
              </div>
            </div>
          </div>
        </div>
        
        <!-- Footer -->
        <div class="modal-footer">
          <div class="footer-hints text-secondary">
            <span><kbd>Space</kbd> Play/Pause</span>
            <span><kbd>←</kbd><kbd>→</kbd> Step frame</span>
            <span><kbd>Shift</kbd>+<kbd>←</kbd><kbd>→</kbd> Skip 5s</span>
            <span><kbd>F</kbd> Add flag</span>
          </div>
          
          <div class="footer-actions">
            <v-btn
              variant="text"
              :disabled="store.isExtracting"
              @click="handleClose"
            >
              Cancel
            </v-btn>
            <v-btn
              color="primary"
              variant="flat"
              :disabled="!canExport"
              :loading="store.isExtracting"
              @click="exportFrames"
            >
              <v-icon class="mr-2">mdi-export</v-icon>
              Export {{ store.totalFlagCount }} Frames
            </v-btn>
          </div>
        </div>
        
        <!-- Extraction progress overlay -->
        <div v-if="store.isExtracting" class="extraction-overlay">
          <div class="extraction-content">
            <v-progress-circular
              :model-value="store.extractionProgress"
              :size="80"
              :width="6"
              color="primary"
            >
              <span class="mono">{{ Math.round(store.extractionProgress) }}%</span>
            </v-progress-circular>
            <p class="mt-4">Extracting frames...</p>
          </div>
        </div>
      </div>
    </div>
  </v-dialog>
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

.video-frame-modal {
  :deep(.v-overlay__content) {
    width: 100%;
    height: 100%;
    max-width: 100%;
    max-height: 100%;
  }
}

.modal-backdrop {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba($background-deep, 0.95);
  backdrop-filter: blur(12px);
  padding: 24px;
}

.modal-container {
  position: relative;
  width: 100%;
  max-width: 1200px;
  max-height: 100%;
  display: flex;
  flex-direction: column;
  background: $background-surface;
  border: 1px solid $border-subtle;
  border-radius: 12px;
  overflow: hidden;
}

.modal-header {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 12px 16px;
  border-bottom: 1px solid $border-subtle;
  
  .header-title {
    display: flex;
    align-items: center;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    font-size: 0.875rem;
    color: $text-secondary;
  }
  
  .header-info {
    flex: 1;
    font-size: 0.75rem;
    color: $text-muted;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.modal-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: 16px;
  gap: 16px;
}

.video-container {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: $background-deep;
  border-radius: 8px;
  overflow: hidden;
}

.video-player {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}

.video-loading,
.video-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: $text-secondary;
}

.playback-controls {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 16px;
  background: $background-elevated;
  border-radius: 8px;
  
  .controls-left,
  .controls-right {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  
  .controls-center {
    .time-display {
      font-size: 0.875rem;
      color: $text-primary;
    }
  }
}

.timeline-section {
  padding: 0 8px;
}

.tools-section {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 16px;
  background: $background-elevated;
  border-radius: 8px;
  
  .tools-left {
    display: flex;
    align-items: center;
    gap: 12px;
    
    .section-label {
      font-size: 0.75rem;
      color: $text-secondary;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
  }
  
  .tools-right {
    .selection-info {
      display: flex;
      align-items: center;
      font-size: 0.875rem;
    }
  }
}

.modal-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-top: 1px solid $border-subtle;
  
  .footer-hints {
    display: flex;
    gap: 16px;
    font-size: 0.75rem;
    
    kbd {
      display: inline-block;
      padding: 2px 6px;
      background: $background-elevated;
      border: 1px solid $border-subtle;
      border-radius: 4px;
      font-family: inherit;
      font-size: 0.625rem;
    }
  }
  
  .footer-actions {
    display: flex;
    gap: 8px;
  }
}

.extraction-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba($background-deep, 0.9);
  backdrop-filter: blur(8px);
  z-index: 100;
  
  .extraction-content {
    display: flex;
    flex-direction: column;
    align-items: center;
    color: $text-primary;
  }
}

.mono {
  font-family: 'JetBrains Mono', 'Fira Code', 'Consolas', monospace;
}
</style>
