import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import { BackendApi, type JobConfig as BackendJobConfig } from '@/services/BackendApi'
import { GetGeneratorService, type GenerationResult } from '@/generator/GeneratorService'
import type { GenerationConfig, GenerationProgress, GenerationStage, QualityPreset } from '@/generator/types'
import { DefaultConfig, QualityPresetConfigs } from '@/generator/types'
import { useAppStore } from './appStore'
import { useSceneStore } from './sceneStore'
import { useNotificationStore } from './notificationStore'
import { useBabylon } from '@/composables/useBabylon'

export type GeneratorMode = 'backend' | 'browser' | 'auto'

export const useGeneratorStore = defineStore('generator', () => {
  const browserService = GetGeneratorService()

  // State
  const images = ref<File[]>([])
  const qualityPreset = ref<QualityPreset>('balanced')
  const config = ref<GenerationConfig>({ ...DefaultConfig })
  const progress = ref<GenerationProgress | null>(null)
  const result = ref<GenerationResult | null>(null)
  const error = ref<string | null>(null)
  
  // Backend state
  const backendAvailable = ref<boolean | null>(null)
  const backendHealth = ref<any>(null)
  const currentJobId = ref<string | null>(null)
  const generatorMode = ref<GeneratorMode>('auto')
  const trainingMode = ref<'gpu' | 'cpu' | 'auto'>('auto')
  
  // Intermediate result for live preview
  const intermediateResult = ref<{ blob: Blob; iteration: number } | null>(null)
  const lastIntermediateIteration = ref<number>(0)
  const lastIntermediateFetchTime = ref<number>(0)
  const INTERMEDIATE_THROTTLE_MS = 2000  // Only load a new preview every 2 seconds max
  
  // COLMAP preview state
  const colmapPreviewFetched = ref(false)
  
  // Device info for current processing step
  const currentDeviceType = ref<'gpu' | 'cpu' | null>(null)
  const currentDeviceName = ref<string | null>(null)
  
  // Timer for tracking generation duration
  const startTime = ref<number | null>(null)
  const elapsedTime = ref<number>(0)
  let timerInterval: ReturnType<typeof setInterval> | null = null
  
  // Watch intermediate results and update the 3D view
  watch(intermediateResult, async (newResult) => {
    if (newResult) {
      // Don't load intermediate results if generation has completed
      const stage = progress.value?.stage
      if (stage === 'complete' || stage === 'error' || stage === 'cancelled') {
        console.log('[GeneratorStore] Skipping intermediate load - generation already ended:', stage)
        return
      }
      console.log('[GeneratorStore] Loading intermediate result into viewer, iteration:', newResult.iteration, 'blob size:', newResult.blob.size, 'bytes')
      const appStore = useAppStore()
      await appStore.loadFromBlob(newResult.blob, `preview_${newResult.iteration}.ply`)
      console.log('[GeneratorStore] ✓ Intermediate result loaded successfully')
    }
  })

  // Computed
  const isGenerating = computed(() => {
    const stage = progress.value?.stage
    return stage !== undefined && 
           stage !== 'idle' && 
           stage !== 'complete' && 
           stage !== 'cancelled' && 
           stage !== 'error'
  })

  const canGenerate = computed(() => {
    return images.value.length >= 3 && !isGenerating.value
  })

  const progressPercentage = computed(() => {
    return progress.value?.percentage ?? 0
  })

  const currentStage = computed((): GenerationStage => {
    return progress.value?.stage ?? 'idle'
  })

  const splatCount = computed(() => {
    return progress.value?.splatCount ?? 0
  })

  const isWebGPUSupported = computed(() => {
    return browserService.IsWebGPUSupported()
  })

  const useBackend = computed(() => {
    if (generatorMode.value === 'backend') return true
    if (generatorMode.value === 'browser') return false
    // Auto mode: use backend if available
    return backendAvailable.value === true
  })
  
  const formattedElapsedTime = computed(() => {
    const ms = elapsedTime.value
    const seconds = Math.floor(ms / 1000)
    const minutes = Math.floor(seconds / 60)
    const hours = Math.floor(minutes / 60)
    
    if (hours > 0) {
      return `${hours}h ${minutes % 60}m ${seconds % 60}s`
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`
    } else {
      return `${seconds}s`
    }
  })

  // Timer helpers
  function startTimer() {
    console.log('[GeneratorStore] Starting timer...')
    if (timerInterval) {
      clearInterval(timerInterval)
    }
    startTime.value = Date.now()
    elapsedTime.value = 0
    timerInterval = setInterval(() => {
      if (startTime.value) {
        elapsedTime.value = Date.now() - startTime.value
      }
    }, 1000)
    console.log('[GeneratorStore] Timer started, initial elapsed:', elapsedTime.value)
  }
  
  function stopTimer() {
    console.log('[GeneratorStore] Stopping timer at:', formattedElapsedTime.value)
    if (timerInterval) {
      clearInterval(timerInterval)
      timerInterval = null
    }
  }

  // Actions
  async function checkBackendAvailable(retries = 2) {
    console.log('[GeneratorStore] Checking backend availability...')
    
    for (let attempt = 0; attempt <= retries; attempt++) {
      const health = await BackendApi.CheckHealth()
      backendHealth.value = health
      backendAvailable.value = health?.status === 'ok'
      
      if (backendAvailable.value) {
        console.log('[GeneratorStore] Backend available:', health)
        // Connect WebSocket for progress updates
        BackendApi.ConnectWebSocket()
        return
      }
      
      // Wait a bit before retrying
      if (attempt < retries) {
        console.log(`[GeneratorStore] Backend check failed, retrying in 500ms... (${attempt + 1}/${retries})`)
        await new Promise(resolve => setTimeout(resolve, 500))
      }
    }
    
    console.log('[GeneratorStore] Backend not available, using browser mode')
  }

  function addImages(files: File[]) {
    const validFiles = files.filter(f => f.type.startsWith('image/'))
    images.value = [...images.value, ...validFiles]
  }

  function removeImage(index: number) {
    images.value.splice(index, 1)
  }

  function clearImages() {
    images.value = []
  }

  function updateConfig(updates: Partial<GenerationConfig>) {
    config.value = { ...config.value, ...updates }
  }

  function applyPreset(preset: QualityPreset) {
    qualityPreset.value = preset
    if (preset !== 'custom') {
      const presetConfig = QualityPresetConfigs[preset]
      updateConfig({
        iterations: presetConfig.iterations,
        resolution: presetConfig.resolution,
        shDegree: presetConfig.shDegree
      })
    }
  }

  function setGeneratorMode(mode: GeneratorMode) {
    generatorMode.value = mode
  }

  function setTrainingMode(mode: 'gpu' | 'cpu' | 'auto') {
    trainingMode.value = mode
  }

  async function startGeneration() {
    if (!canGenerate.value) return

    error.value = null
    result.value = null
    startTimer()
    
    if (useBackend.value) {
      await startBackendGeneration()
    } else {
      await startBrowserGeneration()
    }
  }

  async function startBackendGeneration() {
    console.log('[GeneratorStore] Starting backend generation with', images.value.length, 'images')
    
    progress.value = {
      stage: 'initializing',
      currentIteration: 0,
      totalIterations: config.value.iterations,
      loss: 0,
      splatCount: 0,
      message: 'Uploading images to server...',
      percentage: 0
    }

    try {
      // Create job on backend
      const jobConfig: BackendJobConfig = {
        trainingMode: trainingMode.value,
        iterations: config.value.iterations,
        resolution: config.value.resolution,
        // Scene type for COLMAP optimization
        sceneType: config.value.sceneType,
        // Cleanup settings
        cleanupEnabled: config.value.cleanupEnabled,
        cleanupMinOpacity: config.value.cleanupMinOpacity,
        cleanupMaxScalePercentile: config.value.cleanupMaxScalePercentile,
        cleanupSorStdDevs: config.value.cleanupSorStdDevs,
        // AI Enhancement: Depth Anything
        depthEstimationEnabled: config.value.depthEstimationEnabled,
        depthModelSize: config.value.depthModelSize,
        depthFloaterFilterEnabled: config.value.depthFloaterFilterEnabled,
        depthFloaterThreshold: config.value.depthFloaterThreshold,
        // AI Enhancement: Learned Features (DISK + LightGlue)
        learnedFeaturesEnabled: config.value.learnedFeaturesEnabled,
        learnedFeaturesMaxKeypoints: config.value.learnedFeaturesMaxKeypoints,
        // Trainer engine
        trainerEngine: config.value.trainerEngine
      }

      const response = await BackendApi.CreateJob(images.value, jobConfig)
      
      if (!response) {
        throw new Error('Failed to create job on backend')
      }

      currentJobId.value = response.jobId
      console.log('[GeneratorStore] Job created:', response.jobId)

      // Subscribe to progress updates
      BackendApi.SubscribeToJob(response.jobId, async (p) => {
        console.log('[GeneratorStore] Received progress update:', p.status, p.progress, p.message)
        
        // Show toast notification if the backend flagged one
        if (p.notification) {
          const notifStore = useNotificationStore()
          notifStore.Push(p.notification, p.notificationDuration ?? 2600)
        }

        // Update device info if provided
        if (p.deviceType) {
          currentDeviceType.value = p.deviceType
          currentDeviceName.value = p.deviceName || null
        }
        
        // Don't update progress to 'complete' until we've downloaded the result
        if (p.status === 'complete') {
          console.log('[GeneratorStore] *** COMPLETE status received! Starting download...')
          
          // Show downloading state
          progress.value = {
            stage: 'finalizing',
            currentIteration: config.value.iterations,
            totalIterations: config.value.iterations,
            loss: 0,
            splatCount: p.splatCount || 0,
            message: 'Downloading result...',
            percentage: 98
          }
          
          // Download result, then set complete
          try {
            await handleBackendComplete(response.jobId)
            console.log('[GeneratorStore] handleBackendComplete finished successfully')
          } catch (e) {
            console.error('[GeneratorStore] handleBackendComplete threw:', e)
          }
        } else if (p.status === 'failed') {
          stopTimer()
          progress.value = {
            stage: mapBackendStatus(p.status),
            currentIteration: p.iteration || 0,
            totalIterations: p.totalIterations || config.value.iterations,
            loss: 0,
            splatCount: p.splatCount || 0,
            message: p.message,
            percentage: p.progress
          }
          error.value = p.message
        } else {
          // Preserve previous splatCount if not provided in update
          const prevSplatCount = progress.value?.splatCount || 0
          progress.value = {
            stage: mapBackendStatus(p.status),
            currentIteration: p.iteration || 0,
            totalIterations: p.totalIterations || config.value.iterations,
            loss: 0,
            splatCount: p.splatCount || prevSplatCount,
            message: p.message,
            percentage: p.progress
          }
          
          // Handle COLMAP preview ready
          if (p.colmapPreviewReady && !colmapPreviewFetched.value) {
            console.log('[GeneratorStore] COLMAP preview ready, fetching...')
            fetchColmapPreview(response.jobId)
          }
          
          // Handle intermediate results for live preview
          if (p.intermediateReady && p.iteration && p.iteration > lastIntermediateIteration.value) {
            console.log('[GeneratorStore] Intermediate result ready at iteration', p.iteration)
            fetchIntermediateResult(response.jobId, p.iteration)
          }
        }
      })

      progress.value.message = 'Job queued, waiting for processing...'
      progress.value.percentage = 5

    } catch (e) {
      console.error('[GeneratorStore] Backend generation failed:', e)
      stopTimer()
      error.value = (e as Error).message
      progress.value = {
        stage: 'error',
        currentIteration: 0,
        totalIterations: config.value.iterations,
        loss: 0,
        splatCount: 0,
        message: (e as Error).message,
        percentage: 0
      }
    }
  }

  async function fetchIntermediateResult(jobId: string, iteration: number) {
    // Don't fetch if we already have this iteration or a newer one
    if (iteration <= lastIntermediateIteration.value) return
    
    // Throttle preview loading to avoid overwhelming the browser/GPU
    const now = Date.now()
    if (now - lastIntermediateFetchTime.value < INTERMEDIATE_THROTTLE_MS) {
      // Skip logging for throttled fetches - too noisy
      return
    }
    
    try {
      const blob = await BackendApi.DownloadIntermediate(jobId)
      if (blob && blob.size > 0) {
        console.log('[GeneratorStore] Intermediate result downloaded:', blob.size, 'bytes at iteration', iteration)
        lastIntermediateIteration.value = iteration
        lastIntermediateFetchTime.value = now
        intermediateResult.value = { blob, iteration }
      }
    } catch (e) {
      console.warn('[GeneratorStore] Failed to fetch intermediate result:', e)
    }
  }

  async function fetchColmapPreview(jobId: string) {
    if (colmapPreviewFetched.value) return
    
    try {
      const previewData = await BackendApi.GetColmapPreview(jobId)
      if (previewData) {
        console.log('[GeneratorStore] COLMAP preview data fetched:', previewData.cameras.length, 'cameras,', previewData.points3D.length, 'points')
        colmapPreviewFetched.value = true
        
        // Load preview into Babylon scene
        const babylon = useBabylon()
        await babylon.loadColmapPreview(previewData, (imageName) => 
          BackendApi.GetImageUrl(jobId, imageName)
        )
      }
    } catch (e) {
      console.warn('[GeneratorStore] Failed to fetch COLMAP preview:', e)
    }
  }

  async function handleBackendComplete(jobId: string) {
    console.log('[GeneratorStore] handleBackendComplete called for job:', jobId)
    
    try {
      // Small delay to ensure file is fully written and renamed
      console.log('[GeneratorStore] Waiting 500ms for file operations...')
      await new Promise(resolve => setTimeout(resolve, 500))
      console.log('[GeneratorStore] Starting download...')
      
      // Download result as blob - try PLY first
      let blob: Blob | null = null
      
      console.log('[GeneratorStore] Attempting PLY download...')
      try {
        blob = await BackendApi.DownloadResult(jobId, 'ply')
        console.log('[GeneratorStore] PLY download result:', blob ? `${blob.size} bytes` : 'null')
      } catch (e) {
        console.error('[GeneratorStore] PLY download error:', e)
      }
      
      // If PLY failed, try splat
      if (!blob || blob.size === 0) {
        console.log('[GeneratorStore] PLY failed, trying splat format...')
        try {
          blob = await BackendApi.DownloadResult(jobId, 'splat')
          console.log('[GeneratorStore] Splat download result:', blob ? `${blob.size} bytes` : 'null')
        } catch (e) {
          console.error('[GeneratorStore] Splat download error:', e)
        }
      }
      
      console.log('[GeneratorStore] Final blob status:', blob ? `${blob.size} bytes` : 'null/empty')
      
      if (blob && blob.size > 0) {
        // Create result object compatible with browser generator
        const arrayBuffer = await blob.arrayBuffer()
        const splatCount = Math.floor(arrayBuffer.byteLength / 32)
        console.log('[GeneratorStore] Splat count from file:', splatCount)
        
        // Clear preview state and intermediate results
        const sceneStore = useSceneStore()
        intermediateResult.value = null
        lastIntermediateIteration.value = 0
        lastIntermediateFetchTime.value = 0
        
        // Clear COLMAP preview visualization and dispose preview splat mesh
        const babylon = useBabylon()
        babylon.clearColmapPreview()
        colmapPreviewFetched.value = false
        
        // Explicitly dispose the preview splat mesh before loading final result
        babylon.removeSplat('preview')
        
        // Load final result as non-preview
        const appStore = useAppStore()
        await appStore.loadFromBlob(blob, `generated_${jobId}.ply`, false)
        
        // Final defensive cleanup - ensure no preview mesh remains
        // (handles race condition with concurrent intermediate loads)
        babylon.removeSplat('preview')
        sceneStore.clearPreview()
        
        // Extra defensive cleanup to catch any orphaned meshes
        babylon.cleanupOrphanedSplats()
        
        // Parse splat data (simplified - just store blob URL)
        result.value = {
          positions: new Float32Array(0), // Will load from blob
          scales: new Float32Array(0),
          rotations: new Float32Array(0),
          colors: new Float32Array(0),
          opacities: new Float32Array(0),
          // Store blob for loading
          _blob: blob,
          _splatCount: splatCount
        } as any

        stopTimer()
        
        progress.value = {
          stage: 'complete',
          currentIteration: config.value.iterations,
          totalIterations: config.value.iterations,
          loss: 0,
          splatCount: splatCount,
          message: `Complete! Generated ${splatCount.toLocaleString()} splats`,
          percentage: 100
        }
        
        console.log('[GeneratorStore] Result ready, stage set to complete')
      } else {
        console.error('[GeneratorStore] Downloaded blob is empty or null')
        stopTimer()
        error.value = 'Downloaded result file is empty'
        progress.value = {
          stage: 'error',
          currentIteration: config.value.iterations,
          totalIterations: config.value.iterations,
          loss: 0,
          splatCount: 0,
          message: 'Download failed - empty result',
          percentage: 0
        }
      }
    } catch (e) {
      console.error('[GeneratorStore] Failed to download result:', e)
      stopTimer()
      error.value = 'Failed to download result: ' + (e as Error).message
      progress.value = {
        stage: 'error',
        currentIteration: config.value.iterations,
        totalIterations: config.value.iterations,
        loss: 0,
        splatCount: 0,
        message: 'Download failed: ' + (e as Error).message,
        percentage: 0
      }
    }
  }

  async function startBrowserGeneration() {
    console.log('[GeneratorStore] Starting browser generation with', images.value.length, 'images')
    
    progress.value = {
      stage: 'initializing',
      currentIteration: 0,
      totalIterations: config.value.iterations,
      loss: 0,
      splatCount: 0,
      message: 'Starting generation...',
      percentage: 0
    }

    try {
      await browserService.Generate(images.value, config.value, {
        onProgress: (p) => {
          progress.value = p
          if (p.currentIteration % 500 === 0) {
            console.log('[GeneratorStore] Progress:', p.stage, p.currentIteration, '/', p.totalIterations)
          }
        },
        onComplete: (r) => {
          console.log('[GeneratorStore] Generation complete!', {
            splatCount: r.opacities.length
          })
          
          stopTimer()
          result.value = r
          progress.value = {
            stage: 'complete',
            currentIteration: config.value.iterations,
            totalIterations: config.value.iterations,
            loss: 0,
            splatCount: r.opacities.length,
            message: `Complete! Generated ${r.opacities.length.toLocaleString()} splats`,
            percentage: 100
          }
        },
        onError: (e) => {
          console.error('[GeneratorStore] Generation error:', e)
          stopTimer()
          error.value = e.message
          progress.value = {
            stage: 'error',
            currentIteration: progress.value?.currentIteration ?? 0,
            totalIterations: config.value.iterations,
            loss: 0,
            splatCount: 0,
            message: e.message,
            percentage: 0
          }
        }
      })
    } catch (e) {
      console.error('[GeneratorStore] Exception:', e)
      stopTimer()
      error.value = (e as Error).message
    }
  }

  function cancelGeneration() {
    stopTimer()
    if (currentJobId.value) {
      BackendApi.CancelJob(currentJobId.value)
      BackendApi.UnsubscribeFromJob(currentJobId.value)
      currentJobId.value = null
    }
    browserService.Cancel()
  }

  /**
   * Accept the current intermediate result as "good enough" and stop generation
   */
  async function acceptCurrentResult() {
    console.log('[GeneratorStore] Accepting current result as good enough')
    
    // Cancel the job first
    if (currentJobId.value) {
      BackendApi.CancelJob(currentJobId.value)
      BackendApi.UnsubscribeFromJob(currentJobId.value)
    }
    browserService.Cancel()
    
    // If we have an intermediate result, use it as the final
    if (intermediateResult.value) {
      const blob = intermediateResult.value.blob
      const iteration = intermediateResult.value.iteration
      
      console.log('[GeneratorStore] Using intermediate result from iteration', iteration, 'size:', blob.size)
      
      // Clear preview state
      const sceneStore = useSceneStore()
      sceneStore.clearPreview()
      
      // Clear COLMAP preview visualization
      const babylon = useBabylon()
      babylon.clearColmapPreview()
      colmapPreviewFetched.value = false
      
      // Load as final (non-preview) result
      const appStore = useAppStore()
      await appStore.loadFromBlob(blob, `accepted_iter${iteration}.ply`, false)
      
      // Dispose the preview mesh explicitly (the loaded blob WAS the preview, now it's final)
      babylon.removeSplat('preview')
      sceneStore.clearPreview()
      
      // Extra defensive cleanup to catch any orphaned meshes
      babylon.cleanupOrphanedSplats()
      
      // Estimate splat count from blob size
      const arrayBuffer = await blob.arrayBuffer()
      const splatCount = Math.floor(arrayBuffer.byteLength / 250)
      
      stopTimer()
      
      // Update progress to complete
      progress.value = {
        stage: 'complete',
        currentIteration: iteration,
        totalIterations: config.value.iterations,
        loss: 0,
        splatCount: splatCount,
        message: `Accepted at iteration ${iteration} (${splatCount.toLocaleString()} splats)`,
        percentage: 100
      }
      
      // Create result object
      result.value = {
        positions: new Float32Array(0),
        scales: new Float32Array(0),
        rotations: new Float32Array(0),
        colors: new Float32Array(0),
        opacities: new Float32Array(0),
        _blob: blob,
        _splatCount: splatCount
      } as any
      
      // Clear intermediate state
      intermediateResult.value = null
      lastIntermediateIteration.value = 0
      lastIntermediateFetchTime.value = 0
      currentJobId.value = null
      
    } else {
      // No intermediate result available, just cancel
      console.warn('[GeneratorStore] No intermediate result available, cancelling')
      stopTimer()
      progress.value = {
        stage: 'cancelled',
        currentIteration: 0,
        totalIterations: config.value.iterations,
        loss: 0,
        splatCount: 0,
        message: 'Cancelled - no intermediate result available',
        percentage: 0
      }
      currentJobId.value = null
    }
  }

  function reset() {
    stopTimer()
    if (currentJobId.value) {
      BackendApi.UnsubscribeFromJob(currentJobId.value)
      currentJobId.value = null
    }
    progress.value = null
    result.value = null
    error.value = null
    intermediateResult.value = null
    lastIntermediateIteration.value = 0
    lastIntermediateFetchTime.value = 0
    colmapPreviewFetched.value = false
    currentDeviceType.value = null
    currentDeviceName.value = null
    startTime.value = null
    elapsedTime.value = 0
    
    // Clear preview from scene store and dispose preview mesh
    const sceneStore = useSceneStore()
    const babylon = useBabylon()
    babylon.removeSplat('preview')
    sceneStore.clearPreview()
    
    // Clear COLMAP preview visualization
    babylon.clearColmapPreview()
    
    // Extra defensive cleanup to catch any orphaned meshes
    babylon.cleanupOrphanedSplats()
  }

  // Map backend status to frontend stage
  function mapBackendStatus(status: string): GenerationStage {
    const mapping: Record<string, GenerationStage> = {
      'pending': 'idle',
      'uploading': 'initializing',
      'preprocessing': 'preprocessing',
      'sfm_features': 'sfm',
      'sfm_matching': 'sfm',
      'sfm_reconstruction': 'sfm',
      'learned_features': 'sfm',
      'training_init': 'initializing',
      'training': 'optimizing',
      'depth_filtering': 'finalizing',
      'exporting': 'finalizing',
      'complete': 'complete',
      'failed': 'error',
      'cancelled': 'cancelled'
    }
    return mapping[status] || 'optimizing'
  }

  return {
    // State
    images,
    config,
    progress,
    result,
    error,
    backendAvailable,
    backendHealth,
    currentJobId,
    generatorMode,
    trainingMode,
    qualityPreset,
    intermediateResult,
    currentDeviceType,
    currentDeviceName,
    elapsedTime,
    
    // Computed
    isGenerating,
    canGenerate,
    progressPercentage,
    currentStage,
    splatCount,
    isWebGPUSupported,
    useBackend,
    formattedElapsedTime,

    // Actions
    checkBackendAvailable,
    addImages,
    removeImage,
    clearImages,
    updateConfig,
    applyPreset,
    setGeneratorMode,
    setTrainingMode,
    startGeneration,
    cancelGeneration,
    acceptCurrentResult,
    reset
  }
})
