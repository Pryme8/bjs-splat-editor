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
  maxResolution?: number  // Cap longest edge to this resolution (maintains aspect ratio)
  sharpFrameSelection?: boolean  // Enable sharpness-based frame selection
  sharpnessWindowSize?: number  // Number of adjacent frames to analyze (default: 5)
  onProgress?: (current: number, total: number) => void
}

export function useFrameExtraction() {
  const store = useVideoFrameStore()
  
  const isExtracting = ref(false)
  const extractionError = ref<string | null>(null)
  const canvas = ref<HTMLCanvasElement | null>(null)
  const ctx = ref<CanvasRenderingContext2D | null>(null)
  
  // Small analysis canvas for sharpness computation
  const analysisCanvas = ref<HTMLCanvasElement | null>(null)
  const analysisCtx = ref<CanvasRenderingContext2D | null>(null)
  const ANALYSIS_MAX_SIZE = 512  // Max resolution for sharpness analysis
  
  /**
   * Initialize canvas for frame extraction
   */
  function initCanvas(width: number, height: number) {
    if (!canvas.value) {
      canvas.value = document.createElement('canvas')
    }
    // Setting canvas dimensions clears it and resets the context state
    canvas.value.width = width
    canvas.value.height = height
    // Always get a fresh context after dimension changes
    ctx.value = canvas.value.getContext('2d', { alpha: false })
  }
  
  /**
   * Initialize analysis canvas for sharpness computation
   */
  function initAnalysisCanvas(width: number, height: number) {
    if (!analysisCanvas.value) {
      analysisCanvas.value = document.createElement('canvas')
    }
    analysisCanvas.value.width = width
    analysisCanvas.value.height = height
    analysisCtx.value = analysisCanvas.value.getContext('2d', { willReadFrequently: true })
  }
  
  /**
   * Compute sharpness score using Laplacian variance
   * Higher score = sharper image
   */
  function computeSharpnessScore(imageData: ImageData): number {
    const { data, width, height } = imageData
    
    // Convert to grayscale and store in array
    const gray: number[] = []
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i]
      const g = data[i + 1]
      const b = data[i + 2]
      // Standard grayscale conversion
      const grayValue = 0.299 * r + 0.587 * g + 0.114 * b
      gray.push(grayValue)
    }
    
    // Apply Laplacian kernel: [[0,1,0],[1,-4,1],[0,1,0]]
    const laplacian: number[] = []
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const idx = y * width + x
        const center = gray[idx]
        const top = gray[idx - width]
        const bottom = gray[idx + width]
        const left = gray[idx - 1]
        const right = gray[idx + 1]
        
        const lap = top + bottom + left + right - 4 * center
        laplacian.push(lap)
      }
    }
    
    // Compute variance of Laplacian
    if (laplacian.length === 0) return 0
    
    const mean = laplacian.reduce((sum, val) => sum + val, 0) / laplacian.length
    const variance = laplacian.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / laplacian.length
    
    return variance
  }
  
  /**
   * Capture frame at timestamp and compute sharpness score
   */
  async function captureAndScoreFrame(
    video: HTMLVideoElement,
    time: number
  ): Promise<{ time: number; score: number }> {
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
    
    // Calculate analysis dimensions (scaled down for speed)
    let width = video.videoWidth
    let height = video.videoHeight
    if (Math.max(width, height) > ANALYSIS_MAX_SIZE) {
      const scale = ANALYSIS_MAX_SIZE / Math.max(width, height)
      width = Math.round(width * scale)
      height = Math.round(height * scale)
    }
    
    // Ensure analysis canvas is initialized
    if (!analysisCanvas.value || analysisCanvas.value.width !== width || analysisCanvas.value.height !== height) {
      initAnalysisCanvas(width, height)
    }
    
    if (!analysisCtx.value) {
      throw new Error('Analysis canvas context not available')
    }
    
    // Draw frame to analysis canvas
    analysisCtx.value.drawImage(video, 0, 0, width, height)
    
    // Get image data and compute sharpness
    const imageData = analysisCtx.value.getImageData(0, 0, width, height)
    const score = computeSharpnessScore(imageData)
    
    return { time, score }
  }
  
  /**
   * Find the sharpest frame in a window around the target time
   */
  async function findSharpestFrame(
    video: HTMLVideoElement,
    targetTime: number,
    windowSize: number
  ): Promise<number> {
    // Generate candidate timestamps centered on target
    // Space them at 1/30s intervals (assuming 30fps - works for most videos)
    const frameInterval = 1 / 30
    const halfWindow = Math.floor(windowSize / 2)
    
    const candidates: number[] = []
    for (let i = -halfWindow; i <= halfWindow; i++) {
      const candidateTime = targetTime + i * frameInterval
      // Clamp to valid video range
      if (candidateTime >= 0 && candidateTime <= video.duration) {
        candidates.push(candidateTime)
      }
    }
    
    // If no valid candidates, return target time
    if (candidates.length === 0) return targetTime
    
    // Score all candidates
    const scores: Array<{ time: number; score: number }> = []
    for (const time of candidates) {
      try {
        const result = await captureAndScoreFrame(video, time)
        scores.push(result)
      } catch (e) {
        console.warn(`Failed to score frame at ${time}s:`, e)
      }
    }
    
    // Find the sharpest frame
    if (scores.length === 0) return targetTime
    
    scores.sort((a, b) => b.score - a.score)
    return scores[0].time
  }
  
  /**
   * Extract a single frame at a specific time
   */
  async function extractFrameAtTime(
    video: HTMLVideoElement,
    time: number,
    options: ExtractionOptions = {}
  ): Promise<File> {
    const { quality = 1.0, format = 'image/png', maxResolution } = options
    
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
    
    // Calculate target dimensions (with optional resolution cap)
    let width = video.videoWidth
    let height = video.videoHeight
    
    // Safety check: ensure video has valid dimensions
    if (width === 0 || height === 0) {
      throw new Error(`Invalid video dimensions: ${width}x${height}`)
    }
    
    const originalAspect = width / height
    
    if (maxResolution && Math.max(width, height) > maxResolution) {
      const scale = maxResolution / Math.max(width, height)
      width = Math.round(width * scale)
      height = Math.round(height * scale)
    }
    
    const targetAspect = width / height
    
    // Debug: log if aspect ratio changed (shouldn't happen)
    if (Math.abs(originalAspect - targetAspect) > 0.01) {
      console.warn(`Aspect ratio mismatch! Original: ${originalAspect.toFixed(3)}, Target: ${targetAspect.toFixed(3)}`)
      console.warn(`Video: ${video.videoWidth}x${video.videoHeight}, Target: ${width}x${height}`)
    }
    
    // Only reinitialize canvas if dimensions changed
    if (!canvas.value || canvas.value.width !== width || canvas.value.height !== height) {
      console.log(`Initializing canvas: ${width}x${height} (video: ${video.videoWidth}x${video.videoHeight})`)
      initCanvas(width, height)
    }
    
    if (!ctx.value) {
      throw new Error('Canvas context not available')
    }
    
    // Draw frame to canvas at exact target dimensions
    // The canvas is already sized correctly, this will scale the video frame
    ctx.value.drawImage(video, 0, 0, width, height)
    
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
    
    const file = new File([blob], filename, { type: format })
    console.log(`Extracted frame: ${filename} (${width}x${height}, ${(blob.size * 0.001).toFixed(1)}KB)`)
    
    return file
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
    
    const { sharpFrameSelection = false, sharpnessWindowSize = 5 } = options
    
    // If sharpness selection is enabled, find the sharpest frame for each timestamp
    let finalTimestamps = timestamps
    if (sharpFrameSelection && sharpnessWindowSize > 1) {
      isExtracting.value = true
      store.setExtracting(true)
      
      try {
        // Pause video during analysis
        const wasPlaying = !video.paused
        video.pause()
        
        console.log(`Analyzing ${timestamps.length} timestamps for sharpness...`)
        const analyzedTimestamps: number[] = []
        
        for (let i = 0; i < timestamps.length; i++) {
          try {
            const sharpestTime = await findSharpestFrame(video, timestamps[i], sharpnessWindowSize)
            analyzedTimestamps.push(sharpestTime)
            
            // Report progress
            const progress = ((i + 1) / timestamps.length) * 50  // First 50% is analysis
            store.setExtractionProgress(progress)
            
            // Yield to UI every 10 frames
            if (i % 10 === 0) {
              await new Promise(resolve => setTimeout(resolve, 0))
            }
          } catch (e) {
            console.warn(`Sharpness analysis failed for timestamp ${timestamps[i]}:`, e)
            // Fall back to original timestamp
            analyzedTimestamps.push(timestamps[i])
          }
        }
        
        finalTimestamps = analyzedTimestamps
        console.log('Sharpness analysis complete')
        
        // Restore playback state
        if (wasPlaying) {
          video.play()
        }
      } catch (e) {
        console.error('Sharpness analysis failed:', e)
        // Fall back to original timestamps
        finalTimestamps = timestamps
      } finally {
        store.setExtracting(false)
        isExtracting.value = false
      }
    }
    
    return extractFrames(video, finalTimestamps, options)
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
    analysisCanvas.value = null
    analysisCtx.value = null
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
