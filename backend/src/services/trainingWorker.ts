/**
 * Training Worker - Orchestrates the full pipeline
 * 
 * Pipeline:
 * 1. Preprocess images
 * 2. Run COLMAP for Structure from Motion (camera poses)
 * 3. Run OpenSplat for Gaussian Splatting training
 */

import path from 'path'
import fs from 'fs/promises'
import type { Job, JobConfig, JobProgress, TrainingResult } from '../types/index.js'
import { updateJobStatus, completeJob, failJob, updateJob } from './jobManager.js'
import { runColmapPipeline, checkColmapAvailable } from './colmap.js'
import { trainWithOpenSplat, checkOpenSplatAvailable, checkOpenSplatGPU } from './opensplat.js'
import { cleanupPly, DefaultCleanupConfig, type CleanupConfig } from './plyCleanup.js'

// Cache for resolved capabilities
let cachedGpuAvailable: boolean | null = null
let cachedOpenSplatAvailable: boolean | null = null

interface TrainingJobData {
  jobId: string
  imagesDir: string
  outputDir: string
  config: JobConfig
}

type ProgressCallback = (progress: JobProgress) => void

/**
 * Process a training job through the full pipeline
 */
export async function processTrainingJob(
  data: TrainingJobData,
  onProgress: ProgressCallback
): Promise<TrainingResult> {
  const { jobId, imagesDir, outputDir, config } = data
  const startTime = Date.now()

  try {
    // Report starting
    onProgress({
      jobId,
      status: 'preprocessing',
      progress: 0,
      message: 'Starting processing pipeline...'
    })

    // Check prerequisites
    const [colmapAvailable, opensplatAvailable] = await Promise.all([
      checkColmapAvailable(),
      checkOpenSplatAvailable()
    ])

    if (!colmapAvailable) {
      throw new Error(
        'COLMAP is required for photogrammetry but was not found.\n' +
        'Please install COLMAP and set COLMAP_PATH environment variable.\n' +
        'Download from: https://github.com/colmap/colmap/releases'
      )
    }

    if (!opensplatAvailable) {
      throw new Error(
        'OpenSplat is required for Gaussian Splat training but was not found.\n' +
        'Please install OpenSplat and set OPENSPLAT_PATH environment variable.\n' +
        'Download from: https://github.com/pierotofy/OpenSplat'
      )
    }

    // Verify images exist
    const images = await fs.readdir(imagesDir)
    const imageFiles = images.filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f))
    
    if (imageFiles.length < 3) {
      throw new Error(`Need at least 3 images, found ${imageFiles.length}`)
    }

    onProgress({
      jobId,
      status: 'preprocessing',
      progress: 5,
      message: `Found ${imageFiles.length} images, preparing...`
    })

    // Create images symlink/copy for COLMAP (it expects images in specific location)
    const colmapImagesDir = path.join(outputDir, 'images')
    await fs.mkdir(colmapImagesDir, { recursive: true })
    
    // Copy images to COLMAP expected location
    for (const file of imageFiles) {
      const src = path.join(imagesDir, file)
      const dest = path.join(colmapImagesDir, file)
      await fs.copyFile(src, dest)
    }

    onProgress({
      jobId,
      status: 'preprocessing',
      progress: 10,
      message: `Prepared ${imageFiles.length} images for processing`
    })

    // Run COLMAP SfM pipeline
    onProgress({
      jobId,
      status: 'sfm_features',
      progress: 15,
      message: 'Running Structure from Motion (COLMAP)...'
    })

    const colmapResult = await runColmapPipeline({
      jobId,
      imagesDir: colmapImagesDir,
      outputDir,
      onProgress: (partial) => {
        onProgress({
          jobId,
          status: partial.status || 'sfm_features',
          progress: partial.progress || 15,
          message: partial.message || 'Processing...'
        })
      }
    })

    // Save COLMAP result to job
    await updateJob(jobId, { colmapData: colmapResult })

    onProgress({
      jobId,
      status: 'training_init',
      progress: 75,
      message: `SfM complete: ${colmapResult.cameras.length} cameras, ${colmapResult.points3DCount} points`,
      colmapPreviewReady: true  // Signal frontend to fetch and display COLMAP preview
    })

    // Determine if GPU is available
    const gpuAvailable = await checkOpenSplatGPU()
    const useGpu = config.trainingMode === 'gpu' || (config.trainingMode === 'auto' && gpuAvailable)
    
    const modeLabel = useGpu ? 'GPU' : 'CPU'
    
    onProgress({
      jobId,
      status: 'training_init',
      progress: 78,
      message: `Starting OpenSplat training (${modeLabel})...`
    })

    // Run OpenSplat training
    const result = await trainWithOpenSplat({
      jobId,
      imagesDir: colmapImagesDir,
      outputDir,
      colmapData: colmapResult,
      config,
      onProgress: (partial) => {
        onProgress({
          jobId,
          status: 'training',
          progress: partial.progress || 80,
          message: partial.message || 'Training...',
          iteration: partial.iteration,
          totalIterations: partial.totalIterations,
          splatCount: partial.splatCount,
          intermediateReady: (partial as any).intermediateReady
        })
      }
    })

    // Post-processing: Cleanup PLY to remove floaters
    onProgress({
      jobId,
      status: 'exporting',
      progress: 96,
      message: 'Cleaning up splats (removing floaters)...',
      splatCount: result.splatCount
    })

    let finalSplatCount = result.splatCount
    const cleanupConfig: CleanupConfig = {
      minOpacity: config.cleanupMinOpacity ?? DefaultCleanupConfig.minOpacity,
      maxScalePercentile: config.cleanupMaxScalePercentile ?? DefaultCleanupConfig.maxScalePercentile,
      sorStdDevs: config.cleanupSorStdDevs ?? DefaultCleanupConfig.sorStdDevs,
      enabled: config.cleanupEnabled !== false  // Enabled by default
    }

    if (cleanupConfig.enabled && result.plyPath) {
      try {
        const cleanedPath = result.plyPath.replace('.ply', '_cleaned.ply')
        const cleanupStats = await cleanupPly(result.plyPath, cleanedPath, cleanupConfig)
        
        // Replace original with cleaned version
        await fs.rename(cleanedPath, result.plyPath)
        finalSplatCount = cleanupStats.finalCount
        
        console.log(`[TrainingWorker] Cleanup complete: ${cleanupStats.originalCount} -> ${finalSplatCount} splats`)
        
        onProgress({
          jobId,
          status: 'exporting',
          progress: 98,
          message: `Cleanup removed ${cleanupStats.originalCount - finalSplatCount} floaters`,
          splatCount: finalSplatCount
        })
      } catch (cleanupError) {
        console.warn(`[TrainingWorker] Cleanup failed, using original:`, cleanupError)
        // Continue with original file if cleanup fails
      }
    }

    // Finalize
    onProgress({
      jobId,
      status: 'exporting',
      progress: 99,
      message: 'Finalizing results...',
      splatCount: finalSplatCount
    })

    const trainingTime = (Date.now() - startTime) * 0.001

    // Mark job complete
    const resultUrl = `/results/${jobId}/result.ply`
    await completeJob(jobId, resultUrl)

    onProgress({
      jobId,
      status: 'complete',
      progress: 100,
      message: `Training complete! ${finalSplatCount.toLocaleString()} splats generated in ${Math.round(trainingTime)}s`,
      splatCount: finalSplatCount
    })

    return {
      ...result,
      trainingTime
    }

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    console.error(`[TrainingWorker] Job ${jobId} failed:`, errorMessage)
    
    await failJob(jobId, errorMessage)
    
    onProgress({
      jobId,
      status: 'failed',
      progress: 0,
      message: errorMessage
    })

    throw error
  }
}
