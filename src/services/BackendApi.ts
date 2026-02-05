/**
 * Backend API Service - Connects frontend to the real photogrammetry backend
 */

export interface JobStatus {
  id: string
  status: string
  progress: number
  message: string
  imageCount: number
  createdAt: string
  updatedAt: string
  completedAt?: string
  error?: string
  resultUrl?: string
}

export interface JobConfig {
  trainingMode: 'gpu' | 'cpu' | 'auto'
  iterations?: number
  resolution?: number
  shDegree?: number
  // Cleanup options
  cleanupEnabled?: boolean
  cleanupMinOpacity?: number
  cleanupMaxScalePercentile?: number
  cleanupSorStdDevs?: number
}

export interface BackendHealth {
  status: string
  services: {
    api: boolean
    colmap: boolean
    redis: boolean
    opensplat: boolean
  }
}

// COLMAP Preview types
export interface Point3D {
  x: number
  y: number
  z: number
  r: number
  g: number
  b: number
}

export interface CameraPreview {
  id: number
  position: [number, number, number]
  rotation: [number, number, number, number]
  focalLength: number
  width: number
  height: number
  imageName: string
}

export interface ColmapPreviewData {
  cameras: CameraPreview[]
  points3D: Point3D[]
  points3DCount: number
  imageBaseUrl: string
}

type ProgressCallback = (progress: {
  status: string
  progress: number
  message: string
  iteration?: number
  totalIterations?: number
  splatCount?: number
  intermediateReady?: boolean
  colmapPreviewReady?: boolean
}) => void

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4270'
const WS_URL = API_URL.replace('http', 'ws')

class BackendApiService {
  private ws: WebSocket | null = null
  private progressCallbacks: Map<string, ProgressCallback> = new Map()
  private reconnectTimeout: number | null = null

  /**
   * Check if backend is available
   */
  async CheckHealth(): Promise<BackendHealth | null> {
    try {
      const response = await fetch(`${API_URL}/api/health`, {
        signal: AbortSignal.timeout(5000)
      })
      if (response.ok) {
        return await response.json()
      }
    } catch (error) {
      console.warn('[BackendApi] Health check failed:', error)
    }
    return null
  }

  /**
   * Check if backend is running
   */
  async IsAvailable(): Promise<boolean> {
    const health = await this.CheckHealth()
    return health?.status === 'ok'
  }

  /**
   * Create a new training job with images
   */
  async CreateJob(
    images: File[],
    config: JobConfig
  ): Promise<{ jobId: string; status: string } | null> {
    try {
      const formData = new FormData()
      
      // Add images
      for (const image of images) {
        formData.append('images', image)
      }

      // Add config
      formData.append('trainingMode', config.trainingMode)
      if (config.iterations) formData.append('iterations', config.iterations.toString())
      if (config.resolution) formData.append('resolution', config.resolution.toString())
      if (config.shDegree !== undefined) formData.append('shDegree', config.shDegree.toString())
      
      // Cleanup config
      if (config.cleanupEnabled !== undefined) formData.append('cleanupEnabled', config.cleanupEnabled.toString())
      if (config.cleanupMinOpacity !== undefined) formData.append('cleanupMinOpacity', config.cleanupMinOpacity.toString())
      if (config.cleanupMaxScalePercentile !== undefined) formData.append('cleanupMaxScalePercentile', config.cleanupMaxScalePercentile.toString())
      if (config.cleanupSorStdDevs !== undefined) formData.append('cleanupSorStdDevs', config.cleanupSorStdDevs.toString())

      const response = await fetch(`${API_URL}/api/jobs`, {
        method: 'POST',
        body: formData
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || 'Failed to create job')
      }

      return await response.json()
    } catch (error) {
      console.error('[BackendApi] Failed to create job:', error)
      throw error
    }
  }

  /**
   * Get job status
   */
  async GetJob(jobId: string): Promise<JobStatus | null> {
    try {
      const response = await fetch(`${API_URL}/api/jobs/${jobId}`)
      if (response.ok) {
        const data = await response.json()
        return data.job
      }
    } catch (error) {
      console.error('[BackendApi] Failed to get job:', error)
    }
    return null
  }

  /**
   * Get all jobs
   */
  async GetJobs(): Promise<JobStatus[]> {
    try {
      const response = await fetch(`${API_URL}/api/jobs`)
      if (response.ok) {
        const data = await response.json()
        return data.jobs
      }
    } catch (error) {
      console.error('[BackendApi] Failed to get jobs:', error)
    }
    return []
  }

  /**
   * Cancel a job
   */
  async CancelJob(jobId: string): Promise<boolean> {
    try {
      const response = await fetch(`${API_URL}/api/jobs/${jobId}`, {
        method: 'DELETE'
      })
      return response.ok
    } catch (error) {
      console.error('[BackendApi] Failed to cancel job:', error)
      return false
    }
  }

  /**
   * Get result file URL
   */
  GetResultUrl(jobId: string, format: 'ply' | 'splat' = 'ply'): string {
    return `${API_URL}/api/jobs/${jobId}/result?format=${format}`
  }

  /**
   * Download result file as blob
   */
  async DownloadResult(jobId: string, format: 'ply' | 'splat' = 'ply'): Promise<Blob | null> {
    const url = this.GetResultUrl(jobId, format)
    console.log('[BackendApi] Downloading result from:', url)
    
    try {
      const response = await fetch(url)
      console.log('[BackendApi] Download response status:', response.status)
      
      if (response.ok) {
        const blob = await response.blob()
        console.log('[BackendApi] Downloaded blob size:', blob.size)
        return blob
      } else {
        const errorText = await response.text()
        console.error('[BackendApi] Download failed:', response.status, errorText)
      }
    } catch (error) {
      console.error('[BackendApi] Failed to download result:', error)
    }
    return null
  }

  /**
   * Download intermediate result (during training)
   */
  async DownloadIntermediate(jobId: string): Promise<Blob | null> {
    const url = `${API_URL}/api/jobs/${jobId}/intermediate`
    console.log('[BackendApi] Downloading intermediate from:', url)
    
    try {
      const response = await fetch(url)
      console.log('[BackendApi] Intermediate download status:', response.status)
      
      if (response.ok) {
        const blob = await response.blob()
        console.log('[BackendApi] Downloaded intermediate blob size:', blob.size)
        return blob
      }
    } catch (error) {
      console.error('[BackendApi] Failed to download intermediate:', error)
    }
    return null
  }

  /**
   * Get COLMAP preview data (cameras + point cloud)
   */
  async GetColmapPreview(jobId: string): Promise<ColmapPreviewData | null> {
    const url = `${API_URL}/api/jobs/${jobId}/colmap-preview`
    console.log('[BackendApi] Fetching COLMAP preview from:', url)
    
    try {
      const response = await fetch(url)
      console.log('[BackendApi] COLMAP preview response status:', response.status)
      
      if (response.ok) {
        const data = await response.json()
        console.log('[BackendApi] COLMAP preview:', data.cameras?.length, 'cameras,', data.points3D?.length, 'points')
        return data as ColmapPreviewData
      }
    } catch (error) {
      console.error('[BackendApi] Failed to fetch COLMAP preview:', error)
    }
    return null
  }

  /**
   * Get image URL for a job
   */
  GetImageUrl(jobId: string, imageName: string): string {
    return `${API_URL}/api/jobs/${jobId}/images/${encodeURIComponent(imageName)}`
  }

  /**
   * Connect to WebSocket for real-time progress
   */
  ConnectWebSocket(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      return
    }

    try {
      this.ws = new WebSocket(`${WS_URL}/ws`)

      this.ws.onopen = () => {
        console.log('[BackendApi] WebSocket connected')
      }

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data)
          
          if (data.type === 'progress' && data.jobId) {
            console.log('[BackendApi] WS progress:', data.status, data.progress, '%')
            const callback = this.progressCallbacks.get(data.jobId)
            if (callback) {
              // Call callback but don't await - let it run async
              Promise.resolve(callback({
                status: data.status,
                progress: data.progress,
                message: data.message,
                iteration: data.iteration,
                totalIterations: data.totalIterations,
                splatCount: data.splatCount,
                intermediateReady: data.intermediateReady,
                colmapPreviewReady: data.colmapPreviewReady
              })).catch(err => {
                console.error('[BackendApi] Progress callback error:', err)
              })
            } else {
              console.warn('[BackendApi] No callback registered for job:', data.jobId)
            }
          }
        } catch (error) {
          console.warn('[BackendApi] Failed to parse WebSocket message:', error)
        }
      }

      this.ws.onclose = () => {
        console.log('[BackendApi] WebSocket disconnected')
        // Attempt to reconnect after 5 seconds
        this.reconnectTimeout = window.setTimeout(() => {
          this.ConnectWebSocket()
        }, 5000)
      }

      this.ws.onerror = (error) => {
        console.error('[BackendApi] WebSocket error:', error)
      }
    } catch (error) {
      console.error('[BackendApi] Failed to connect WebSocket:', error)
    }
  }

  /**
   * Disconnect WebSocket
   */
  DisconnectWebSocket(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout)
      this.reconnectTimeout = null
    }
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
  }

  /**
   * Subscribe to job progress updates
   */
  SubscribeToJob(jobId: string, callback: ProgressCallback): void {
    this.progressCallbacks.set(jobId, callback)
    
    // Send subscribe message
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'subscribe',
        jobId
      }))
    }
  }

  /**
   * Unsubscribe from job progress updates
   */
  UnsubscribeFromJob(jobId: string): void {
    this.progressCallbacks.delete(jobId)
    
    // Send unsubscribe message
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'unsubscribe',
        jobId
      }))
    }
  }
}

// Singleton instance
export const BackendApi = new BackendApiService()
