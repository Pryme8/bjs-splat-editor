import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export type TimelineTool = 'flag' | 'range' | 'scrub'

export interface RangeSelection {
  id: string
  startTime: number
  endTime: number
  interval: number  // Extraction interval in seconds
}

export const useVideoFrameStore = defineStore('videoFrame', () => {
  // Video state
  const videoFile = ref<File | null>(null)
  const videoUrl = ref<string | null>(null)
  const videoDuration = ref(0)
  const videoWidth = ref(0)
  const videoHeight = ref(0)
  const isVideoLoaded = ref(false)
  const videoError = ref<string | null>(null)
  
  // Playback state
  const currentTime = ref(0)
  const isPlaying = ref(false)
  
  // Timeline state
  const zoomLevel = ref(1)  // 1 = full duration visible, higher = more zoom
  const scrollOffset = ref(0)  // Scroll position in seconds
  const activeTool = ref<TimelineTool>('flag')
  
  // Frame flags (individual timestamps)
  const frameFlags = ref<number[]>([])
  
  // Range selections
  const rangeSelections = ref<RangeSelection[]>([])
  const activeRangeStart = ref<number | null>(null)  // For in-progress range selection
  
  // Modal state
  const isModalOpen = ref(false)
  const isExtracting = ref(false)
  const extractionProgress = ref(0)
  
  // Computed
  const hasVideo = computed(() => videoFile.value !== null && isVideoLoaded.value)
  
  const totalFlagCount = computed(() => {
    let count = frameFlags.value.length
    
    // Add frames from range selections
    for (const range of rangeSelections.value) {
      const rangeFrames = Math.floor((range.endTime - range.startTime) / range.interval) + 1
      count += rangeFrames
    }
    
    return count
  })
  
  const visibleTimeRange = computed(() => {
    const visibleDuration = videoDuration.value / zoomLevel.value
    return {
      start: scrollOffset.value,
      end: Math.min(scrollOffset.value + visibleDuration, videoDuration.value),
      duration: visibleDuration
    }
  })
  
  const sortedFlags = computed(() => {
    return [...frameFlags.value].sort((a, b) => a - b)
  })
  
  // Get all frame timestamps (flags + expanded ranges)
  const allFrameTimestamps = computed(() => {
    const timestamps = new Set<number>()
    
    // Add individual flags
    for (const flag of frameFlags.value) {
      timestamps.add(flag)
    }
    
    // Add frames from ranges
    for (const range of rangeSelections.value) {
      for (let t = range.startTime; t <= range.endTime; t += range.interval) {
        timestamps.add(Math.round(t * 1000) / 1000)  // Round to ms precision
      }
    }
    
    return Array.from(timestamps).sort((a, b) => a - b)
  })
  
  // Actions
  function setVideo(file: File) {
    // Clean up previous video URL
    if (videoUrl.value) {
      URL.revokeObjectURL(videoUrl.value)
    }
    
    // Reset state
    reset()
    
    videoFile.value = file
    videoUrl.value = URL.createObjectURL(file)
    videoError.value = null
  }
  
  function setVideoMetadata(duration: number, width: number, height: number) {
    videoDuration.value = duration
    videoWidth.value = width
    videoHeight.value = height
    isVideoLoaded.value = true
  }
  
  function setVideoError(error: string) {
    videoError.value = error
    isVideoLoaded.value = false
  }
  
  function setCurrentTime(time: number) {
    currentTime.value = Math.max(0, Math.min(time, videoDuration.value))
  }
  
  function setIsPlaying(playing: boolean) {
    isPlaying.value = playing
  }
  
  function setZoomLevel(level: number) {
    // Clamp between 1 (full duration) and 20 (5% of duration visible)
    zoomLevel.value = Math.max(1, Math.min(20, level))
    
    // Adjust scroll offset to keep current time visible
    ensureTimeVisible(currentTime.value)
  }
  
  function setScrollOffset(offset: number) {
    const maxOffset = videoDuration.value - (videoDuration.value / zoomLevel.value)
    scrollOffset.value = Math.max(0, Math.min(offset, maxOffset))
  }
  
  function ensureTimeVisible(time: number) {
    const { start, end } = visibleTimeRange.value
    
    if (time < start) {
      setScrollOffset(time)
    } else if (time > end) {
      setScrollOffset(time - (videoDuration.value / zoomLevel.value))
    }
  }
  
  function setActiveTool(tool: TimelineTool) {
    activeTool.value = tool
    // Clear active range when switching tools
    if (tool !== 'range') {
      activeRangeStart.value = null
    }
  }
  
  // Flag management
  function addFlag(time: number) {
    const roundedTime = Math.round(time * 1000) / 1000  // Round to ms
    if (!frameFlags.value.includes(roundedTime)) {
      frameFlags.value.push(roundedTime)
    }
  }
  
  function removeFlag(time: number) {
    const roundedTime = Math.round(time * 1000) / 1000
    const index = frameFlags.value.findIndex(t => Math.abs(t - roundedTime) < 0.001)
    if (index !== -1) {
      frameFlags.value.splice(index, 1)
    }
  }
  
  function toggleFlag(time: number) {
    const roundedTime = Math.round(time * 1000) / 1000
    const exists = frameFlags.value.some(t => Math.abs(t - roundedTime) < 0.001)
    if (exists) {
      removeFlag(roundedTime)
    } else {
      addFlag(roundedTime)
    }
  }
  
  function clearAllFlags() {
    frameFlags.value = []
  }
  
  // Range management
  function startRangeSelection(time: number) {
    activeRangeStart.value = Math.round(time * 1000) / 1000
  }
  
  function completeRangeSelection(endTime: number, interval: number = 1) {
    if (activeRangeStart.value === null) return
    
    const start = Math.min(activeRangeStart.value, endTime)
    const end = Math.max(activeRangeStart.value, endTime)
    
    rangeSelections.value.push({
      id: `range-${Date.now()}`,
      startTime: start,
      endTime: end,
      interval
    })
    
    activeRangeStart.value = null
  }
  
  function cancelRangeSelection() {
    activeRangeStart.value = null
  }
  
  function removeRange(id: string) {
    const index = rangeSelections.value.findIndex(r => r.id === id)
    if (index !== -1) {
      rangeSelections.value.splice(index, 1)
    }
  }
  
  function updateRangeInterval(id: string, interval: number) {
    const range = rangeSelections.value.find(r => r.id === id)
    if (range) {
      range.interval = interval
    }
  }
  
  function clearAllRanges() {
    rangeSelections.value = []
  }
  
  // Modal actions
  function openModal() {
    isModalOpen.value = true
  }
  
  function closeModal() {
    isModalOpen.value = false
  }
  
  function setExtracting(extracting: boolean) {
    isExtracting.value = extracting
  }
  
  function setExtractionProgress(progress: number) {
    extractionProgress.value = progress
  }
  
  // Full reset
  function reset() {
    if (videoUrl.value) {
      URL.revokeObjectURL(videoUrl.value)
    }
    
    videoFile.value = null
    videoUrl.value = null
    videoDuration.value = 0
    videoWidth.value = 0
    videoHeight.value = 0
    isVideoLoaded.value = false
    videoError.value = null
    
    currentTime.value = 0
    isPlaying.value = false
    
    zoomLevel.value = 1
    scrollOffset.value = 0
    activeTool.value = 'flag'
    
    frameFlags.value = []
    rangeSelections.value = []
    activeRangeStart.value = null
    
    isExtracting.value = false
    extractionProgress.value = 0
  }
  
  // Clear selections but keep video
  function clearSelections() {
    frameFlags.value = []
    rangeSelections.value = []
    activeRangeStart.value = null
  }
  
  return {
    // State
    videoFile,
    videoUrl,
    videoDuration,
    videoWidth,
    videoHeight,
    isVideoLoaded,
    videoError,
    currentTime,
    isPlaying,
    zoomLevel,
    scrollOffset,
    activeTool,
    frameFlags,
    rangeSelections,
    activeRangeStart,
    isModalOpen,
    isExtracting,
    extractionProgress,
    
    // Computed
    hasVideo,
    totalFlagCount,
    visibleTimeRange,
    sortedFlags,
    allFrameTimestamps,
    
    // Actions
    setVideo,
    setVideoMetadata,
    setVideoError,
    setCurrentTime,
    setIsPlaying,
    setZoomLevel,
    setScrollOffset,
    ensureTimeVisible,
    setActiveTool,
    addFlag,
    removeFlag,
    toggleFlag,
    clearAllFlags,
    startRangeSelection,
    completeRangeSelection,
    cancelRangeSelection,
    removeRange,
    updateRangeInterval,
    clearAllRanges,
    openModal,
    closeModal,
    setExtracting,
    setExtractionProgress,
    reset,
    clearSelections
  }
})
