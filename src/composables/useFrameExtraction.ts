/**
 * Frame Extraction Composable
 * 
 * Extracts frames from video using Canvas API
 */

import { ref } from 'vue'
import { useVideoFrameStore } from '@/stores/videoFrameStore'

export interface ExtractionOptions {
  quality?: number  // Image quality 0-1, default 1.0 (lossless for PNG)
  format?: 'image/jpeg' | 'image/png'
  onProgress?: (current: number, total: number) => void
}

export function useFrameExtraction() {
  const store = useVideoFrameStore()
  
  const isExtracting = ref(false)
  const extractionError = ref<string | null>(null)
  const canvas = ref<HTMLCanvasElement | null>(null)
  const ctx = ref<CanvasRenderingContext2D | null>(null)
  
  /**
   * Initialize canvas for frame extraction
   */
  function initCanvas(width: number, height: number) {
    if (!canvas.value) {
      canvas.value = document.createElement('canvas')
    }
    canvas.value.width = width
    canvas.value.height = height
    ctx.value = canvas.value.getContext('2d')
  }
  
  /**
   * Extract a single frame at a specific time
   */
  async function extractFrameAtTime(
    video: HTMLVideoElement,
    time: number,
    options: ExtractionOptions = {}
  ): Promise<File> {
    const { quality = 1.0, format = 'image/png' } = options
    
    // Seek to time
    video.currentTime = time
    
    // Wait for seek to complete
    await new Promise<void>((resolve, reject) => {
      const onSeeked = () => {
        video.removeEventListener('seeked', onSeeked)
        video.removeEventListener('error', onError)
        resolve()
      }
      const onError = () => {
        video.removeEventListener('seeked', onSeeked)
        video.removeEventListener('error', onError)
        reject(new Error('Video seek failed'))
      }
      video.addEventListener('seeked', onSeeked)
      video.addEventListener('error', onError)
    })
    
    // Ensure canvas is initialized with video dimensions
    if (!canvas.value || canvas.value.width !== video.videoWidth || canvas.value.height !== video.videoHeight) {
      initCanvas(video.videoWidth, video.videoHeight)
    }
    
    if (!ctx.value) {
      throw new Error('Canvas context not available')
    }
    
    // Draw frame to canvas
    ctx.value.drawImage(video, 0, 0, video.videoWidth, video.videoHeight)
    
    // Convert to blob
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.value!.toBlob(
        (b) => {
          if (b) resolve(b)
          else reject(new Error('Failed to create blob from canvas'))
        },
        format,
        quality
      )
    })
    
    // Create file with timestamp-based name
    const extension = format === 'image/png' ? 'png' : 'jpg'
    const filename = `frame_${time.toFixed(3).replace('.', '_')}.${extension}`
    
    return new File([blob], filename, { type: format })
  }
  
  /**
   * Extract multiple frames at specified timestamps
   */
  async function extractFrames(
    video: HTMLVideoElement,
    timestamps: number[],
    options: ExtractionOptions = {}
  ): Promise<File[]> {
    const { onProgress } = options
    const files: File[] = []
    
    isExtracting.value = true
    extractionError.value = null
    store.setExtracting(true)
    
    try {
      // Pause video during extraction
      const wasPlaying = !video.paused
      video.pause()
      
      // Sort timestamps to minimize seeking
      const sortedTimestamps = [...timestamps].sort((a, b) => a - b)
      
      for (let i = 0; i < sortedTimestamps.length; i++) {
        const time = sortedTimestamps[i]
        
        try {
          const file = await extractFrameAtTime(video, time, options)
          files.push(file)
        } catch (e) {
          console.warn(`Failed to extract frame at ${time}s:`, e)
          // Continue with other frames
        }
        
        // Report progress
        const progress = (i + 1) / sortedTimestamps.length
        store.setExtractionProgress(progress * 100)
        onProgress?.(i + 1, sortedTimestamps.length)
        
        // Small delay to prevent UI freeze
        if (i % 10 === 0) {
          await new Promise(resolve => setTimeout(resolve, 0))
        }
      }
      
      // Restore playback state
      if (wasPlaying) {
        video.play()
      }
      
      return files
    } catch (e) {
      extractionError.value = (e as Error).message
      throw e
    } finally {
      isExtracting.value = false
      store.setExtracting(false)
    }
  }
  
  /**
   * Extract frames from a time range at specified interval
   */
  async function extractFrameRange(
    video: HTMLVideoElement,
    startTime: number,
    endTime: number,
    intervalSeconds: number,
    options: ExtractionOptions = {}
  ): Promise<File[]> {
    const timestamps: number[] = []
    
    for (let t = startTime; t <= endTime; t += intervalSeconds) {
      timestamps.push(Math.round(t * 1000) / 1000)  // Round to ms
    }
    
    return extractFrames(video, timestamps, options)
  }
  
  /**
   * Extract all flagged frames and range selections from store
   */
  async function extractAllFromStore(
    video: HTMLVideoElement,
    options: ExtractionOptions = {}
  ): Promise<File[]> {
    const timestamps = store.allFrameTimestamps
    
    if (timestamps.length === 0) {
      throw new Error('No frames selected for extraction')
    }
    
    return extractFrames(video, timestamps, options)
  }
  
  /**
   * Get a preview thumbnail at a specific time (smaller size for UI)
   */
  async function getThumbnailAtTime(
    video: HTMLVideoElement,
    time: number,
    maxWidth: number = 160,
    maxHeight: number = 90
  ): Promise<string> {
    // Calculate thumbnail dimensions maintaining aspect ratio
    const aspectRatio = video.videoWidth / video.videoHeight
    let width = maxWidth
    let height = maxWidth / aspectRatio
    
    if (height > maxHeight) {
      height = maxHeight
      width = maxHeight * aspectRatio
    }
    
    // Create temporary canvas for thumbnail
    const thumbCanvas = document.createElement('canvas')
    thumbCanvas.width = width
    thumbCanvas.height = height
    const thumbCtx = thumbCanvas.getContext('2d')
    
    if (!thumbCtx) {
      throw new Error('Failed to create thumbnail canvas context')
    }
    
    // Seek to time
    video.currentTime = time
    await new Promise<void>(resolve => {
      const onSeeked = () => {
        video.removeEventListener('seeked', onSeeked)
        resolve()
      }
      video.addEventListener('seeked', onSeeked)
    })
    
    // Draw scaled frame
    thumbCtx.drawImage(video, 0, 0, width, height)
    
    // Return as data URL
    return thumbCanvas.toDataURL('image/jpeg', 0.7)
  }
  
  /**
   * Clean up resources
   */
  function cleanup() {
    canvas.value = null
    ctx.value = null
  }
  
  return {
    // State
    isExtracting,
    extractionError,
    
    // Methods
    extractFrameAtTime,
    extractFrames,
    extractFrameRange,
    extractAllFromStore,
    getThumbnailAtTime,
    cleanup
  }
}
