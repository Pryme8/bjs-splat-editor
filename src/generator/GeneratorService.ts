/**
 * Generator Service - Main thread interface to the generation worker
 */

import type {
  GenerationConfig,
  GenerationProgress,
  WorkerMessage,
  ProgressMessage,
  CompleteMessage,
  ErrorMessage,
  ReadyMessage
} from './types'
import { DefaultConfig } from './types'

export interface GenerationResult {
  positions: Float32Array
  scales: Float32Array
  rotations: Float32Array
  colors: Float32Array
  opacities: Float32Array
}

export type ProgressCallback = (progress: GenerationProgress) => void
export type CompleteCallback = (result: GenerationResult) => void
export type ErrorCallback = (error: { message: string; stage: string }) => void

export class GeneratorService {
  private worker: Worker | null = null
  private isReady = false
  private webgpuSupported = false
  
  private onProgress: ProgressCallback | null = null
  private onComplete: CompleteCallback | null = null
  private onError: ErrorCallback | null = null

  constructor() {
    this.initWorker()
  }

  private initWorker() {
    try {
      // Create worker from module
      this.worker = new Worker(
        new URL('./generator.worker.ts', import.meta.url),
        { type: 'module' }
      )

      this.worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
        this.handleMessage(e.data)
      }

      this.worker.onerror = (e) => {
        console.error('Generator worker error:', e)
        this.onError?.({
          message: e.message || 'Worker error',
          stage: 'worker'
        })
      }

      // Initialize WebGPU in worker
      this.worker.postMessage({ type: 'init' })
    } catch (e) {
      console.error('Failed to create generator worker:', e)
    }
  }

  private handleMessage(msg: WorkerMessage) {
    switch (msg.type) {
      case 'ready':
        const readyMsg = msg as ReadyMessage
        this.isReady = true
        this.webgpuSupported = readyMsg.payload.webgpuSupported
        break

      case 'progress':
        const progressMsg = msg as ProgressMessage
        this.onProgress?.(progressMsg.payload)
        break

      case 'complete':
        const completeMsg = msg as CompleteMessage
        this.onComplete?.(completeMsg.payload)
        break

      case 'error':
        const errorMsg = msg as ErrorMessage
        this.onError?.(errorMsg.payload)
        break
    }
  }

  /**
   * Check if WebGPU is supported
   */
  IsWebGPUSupported(): boolean {
    return this.webgpuSupported
  }

  /**
   * Check if worker is ready
   */
  IsReady(): boolean {
    return this.isReady
  }

  /**
   * Start generation from images
   */
  async Generate(
    images: File[],
    config: Partial<GenerationConfig> = {},
    callbacks: {
      onProgress?: ProgressCallback
      onComplete?: CompleteCallback
      onError?: ErrorCallback
    } = {}
  ): Promise<void> {
    if (!this.worker) {
      throw new Error('Generator worker not initialized')
    }

    if (images.length < 3) {
      throw new Error('At least 3 images required for generation')
    }

    // Set callbacks
    this.onProgress = callbacks.onProgress ?? null
    this.onComplete = callbacks.onComplete ?? null
    this.onError = callbacks.onError ?? null

    // Merge config with defaults
    const finalConfig: GenerationConfig = {
      ...DefaultConfig,
      ...config
    }

    // Convert files to ImageBitmaps for transfer
    const imageBitmaps = await Promise.all(
      images.map(file => createImageBitmap(file))
    )

    // Send to worker with transferable bitmaps
    this.worker.postMessage(
      {
        type: 'generate',
        payload: {
          images: imageBitmaps,
          config: finalConfig
        }
      },
      { transfer: imageBitmaps }
    )
  }

  /**
   * Cancel ongoing generation
   */
  Cancel(): void {
    this.worker?.postMessage({ type: 'cancel' })
  }

  /**
   * Terminate worker
   */
  Dispose(): void {
    this.worker?.terminate()
    this.worker = null
    this.isReady = false
  }
}

// Singleton instance
let generatorInstance: GeneratorService | null = null

export function GetGeneratorService(): GeneratorService {
  if (!generatorInstance) {
    generatorInstance = new GeneratorService()
  }
  return generatorInstance
}
