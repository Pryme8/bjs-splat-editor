/**
 * Training Worker - Orchestrates the full pipeline
 * 
 * Pipeline:
 * 1. Preprocess images
 * 2. (Optional) Run Depth Anything for depth estimation
 * 3. Run COLMAP for Structure from Motion (camera poses)
 * 4. Run OpenSplat for Gaussian Splatting training
 * 5. (Optional) Depth-based floater filtering
 * 6. Standard cleanup
 */

import path from 'path'
import fs from 'fs/promises'
import type { Job, JobConfig, JobProgress, TrainingResult, CameraInfo } from '../types/index.js'
import { updateJobStatus, completeJob, failJob, updateJob } from './jobManager.js'
import { runColmapPipeline, checkColmapAvailable } from './colmap.js'
import { trainWithOpenSplat, checkOpenSplatAvailable, checkOpenSplatGPU, getOpenSplatGPUInfo, isDockerMode } from './opensplat.js'
import { trainWithGsplat, checkGsplatAvailable } from './gsplatTrainer.js'
import { cleanupPly, DefaultCleanupConfig, type CleanupConfig } from './plyCleanup.js'
import { checkDepthEstimationAvailable, estimateDepth, type DepthSummary } from './depthEstimation.js'
import { detectFloaters, removeFloatersFromPly, type Camera } from './depthFloaterFilter.js'
import type { TrainerEngine } from '../types/index.js'

// Cache for resolved capabilities
let cachedGpuAvailable: boolean | null = null
let cachedOpenSplatAvailable: boolean | null = null

/**
 * Extract splat positions from PLY file
 * Returns Float32Array with [x0,y0,z0, x1,y1,z1, ...] format
 */
function extractSplatPositions(plyContent: Buffer): Float32Array | null {
  try {
    // Find header end
    const headerEnd = plyContent.indexOf(Buffer.from('end_header\n'))
    if (headerEnd === -1) return null
    
    const headerStr = plyContent.slice(0, headerEnd).toString('utf-8')
    const dataStart = headerEnd + 'end_header\n'.length
    
    // Parse vertex count
    const vertexMatch = headerStr.match(/element vertex (\d+)/)
    if (!vertexMatch) return null
    const vertexCount = parseInt(vertexMatch[1], 10)
    
    // Check if binary or ASCII
    const isBinary = headerStr.includes('binary_little_endian')
    
    if (isBinary) {
      // Parse property offsets - positions are typically first 3 floats
      const dataLength = plyContent.length - dataStart
      const bytesPerVertex = Math.floor(dataLength / vertexCount)
      
      // Assume positions are first 3 float32 values (standard PLY format)
      const positions = new Float32Array(vertexCount * 3)
      const view = new DataView(plyContent.buffer, plyContent.byteOffset + dataStart)
      
      for (let i = 0; i < vertexCount; i++) {
        const offset = i * bytesPerVertex
        positions[i * 3] = view.getFloat32(offset, true)
        positions[i * 3 + 1] = view.getFloat32(offset + 4, true)
        positions[i * 3 + 2] = view.getFloat32(offset + 8, true)
      }
      
      return positions
    } else {
      // ASCII format
      const dataStr = plyContent.slice(dataStart).toString('utf-8')
      const lines = dataStr.trim().split('\n')
      const positions = new Float32Array(vertexCount * 3)
      
      for (let i = 0; i < Math.min(vertexCount, lines.length); i++) {
        const parts = lines[i].trim().split(/\s+/)
        positions[i * 3] = parseFloat(parts[0])
        positions[i * 3 + 1] = parseFloat(parts[1])
        positions[i * 3 + 2] = parseFloat(parts[2])
      }
      
      return positions
    }
  } catch (e) {
    console.error('[TrainingWorker] Failed to extract splat positions:', e)
    return null
  }
}

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
      message: 'Starting processing pipeline...',
      deviceType: 'cpu',
      deviceName: 'CPU'
    })

    // Check prerequisites
    const [colmapAvailable, opensplatAvailable, gsplatAvailable] = await Promise.all([
      checkColmapAvailable(),
      checkOpenSplatAvailable(),
      checkGsplatAvailable()
    ])

    if (!colmapAvailable) {
      throw new Error(
        'COLMAP is required for photogrammetry but was not found.\n' +
        'Please install COLMAP and set COLMAP_PATH environment variable.\n' +
        'Download from: https://github.com/colmap/colmap/releases'
      )
    }

    // Resolve which trainer engine to use
    const requestedEngine: TrainerEngine = config.trainerEngine || 'auto'
    let resolvedEngine: 'opensplat' | 'gsplat'

    if (requestedEngine === 'gsplat') {
      if (!gsplatAvailable) {
        throw new Error(
          'gsplat trainer requested but not available.\n' +
          'Install with: pip install gaussian-splatting\n' +
          'Note: RTX 50xx GPUs require CUDA Toolkit 12.8+ for source build.'
        )
      }
      resolvedEngine = 'gsplat'
    } else if (requestedEngine === 'opensplat') {
      if (!opensplatAvailable) {
        throw new Error(
          'OpenSplat trainer requested but not found.\n' +
          'Please install OpenSplat and set OPENSPLAT_PATH environment variable.\n' +
          'Download from: https://github.com/pierotofy/OpenSplat'
        )
      }
      resolvedEngine = 'opensplat'
    } else {
      // Auto mode: prefer gsplat (Python/PyTorch native GPU), fall back to OpenSplat
      if (gsplatAvailable) {
        resolvedEngine = 'gsplat'
      } else if (opensplatAvailable) {
        resolvedEngine = 'opensplat'
      } else {
        throw new Error(
          'No Gaussian Splat trainer available.\n' +
          'Install OpenSplat (set OPENSPLAT_PATH) or gaussian-splatting (pip install gaussian-splatting).'
        )
      }
    }

    console.log(`[TrainingWorker] Trainer engine: requested=${requestedEngine}, resolved=${resolvedEngine}`)

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
      message: `Found ${imageFiles.length} images, preparing...`,
      deviceType: 'cpu',
      deviceName: 'CPU'
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
      message: `Prepared ${imageFiles.length} images for processing`,
      deviceType: 'cpu',
      deviceName: 'CPU'
    })

    // Optional: Run Depth Anything for depth estimation
    let depthSummary: DepthSummary | null = null
    const depthDir = path.join(outputDir, 'depth')
    
    // Debug: Log depth config
    console.log(`[TrainingWorker] Depth AI config: enabled=${config.depthEstimationEnabled}, model=${config.depthModelSize}, filter=${config.depthFloaterFilterEnabled}`)
    
    if (config.depthEstimationEnabled) {
      const depthAvailable = await checkDepthEstimationAvailable()
      
      if (depthAvailable) {
        // Start with unknown device, will be updated once Python reports it
        let depthDeviceType: 'gpu' | 'cpu' | undefined
        let depthDeviceName: string | undefined
        
        onProgress({
          jobId,
          status: 'depth_estimation',
          progress: 11,
          message: 'Running AI depth estimation (Depth Anything)...'
        })
        
        try {
          depthSummary = await estimateDepth(
            colmapImagesDir,
            depthDir,
            {
              modelSize: config.depthModelSize || 'small',
              saveVisualization: true
            },
            (line, deviceInfoUpdate) => {
              // Update device info if provided
              if (deviceInfoUpdate?.deviceType) {
                depthDeviceType = deviceInfoUpdate.deviceType
                depthDeviceName = deviceInfoUpdate.deviceName
              }
              
              if (line.includes('%') || line.includes('Estimating') || line.includes('Device detected')) {
                onProgress({
                  jobId,
                  status: 'depth_estimation',
                  progress: 12,
                  message: line.includes('Device detected') 
                    ? `Depth estimation on ${depthDeviceName || 'unknown'}...`
                    : `Depth estimation: ${line.substring(0, 60)}...`,
                  deviceType: depthDeviceType,
                  deviceName: depthDeviceName
                })
              }
            },
            jobId
          )
          
          // Update device info from result and send final progress
          if (depthSummary) {
            depthDeviceType = depthSummary.device_type
            depthDeviceName = depthSummary.device_name
            
            onProgress({
              jobId,
              status: 'depth_estimation',
              progress: 14,
              message: `Depth estimation complete (${depthSummary.device_name || 'unknown'})`,
              deviceType: depthDeviceType,
              deviceName: depthDeviceName
            })
          }
          
          console.log(`[TrainingWorker] Depth estimation complete: ${depthSummary.successful}/${depthSummary.total_images} images`)
          
          onProgress({
            jobId,
            status: 'depth_estimation',
            progress: 14,
            message: `Depth maps generated for ${depthSummary.successful} images`,
            deviceType: depthDeviceType || 'cpu',
            deviceName: depthDeviceName || 'CPU'
          })
        } catch (depthError) {
          console.warn(`[TrainingWorker] Depth estimation failed, continuing without:`, depthError)
          onProgress({
            jobId,
            status: 'preprocessing',
            progress: 14,
            message: 'Depth estimation failed, continuing without depth filtering',
            deviceType: 'cpu',
            deviceName: 'CPU'
          })
        }
      } else {
        console.log('[TrainingWorker] Depth estimation not available, skipping')
        onProgress({
          jobId,
          status: 'preprocessing',
          progress: 14,
          message: 'Depth estimation not available (Python/dependencies missing)',
          deviceType: 'cpu',
          deviceName: 'CPU'
        })
      }
    }

    // Run COLMAP SfM pipeline
    onProgress({
      jobId,
      status: 'sfm_features',
      progress: 15,
      message: 'Running Structure from Motion (COLMAP)...',
      deviceType: 'cpu',  // COLMAP runs on CPU
      deviceName: 'CPU'
    })

    // Log learned features config
    if (config.learnedFeaturesEnabled) {
      console.log(`[TrainingWorker] Learned features config: enabled=${config.learnedFeaturesEnabled}, maxKeypoints=${config.learnedFeaturesMaxKeypoints || 2048}`)
    }

    const colmapResult = await runColmapPipeline({
      jobId,
      imagesDir: colmapImagesDir,
      outputDir,
      sceneType: config.sceneType,
      // AI Enhancement: Learned Features
      learnedFeaturesEnabled: config.learnedFeaturesEnabled,
      learnedFeaturesMaxKeypoints: config.learnedFeaturesMaxKeypoints,
      onProgress: (partial) => {
        onProgress({
          jobId,
          status: partial.status || 'sfm_features',
          progress: partial.progress || 15,
          message: partial.message || 'Processing...',
          // Use device info from partial if available (for learned features GPU detection),
          // otherwise default to CPU (traditional COLMAP)
          deviceType: partial.deviceType || 'cpu',
          deviceName: partial.deviceName || 'CPU'
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
      colmapPreviewReady: true,  // Signal frontend to fetch and display COLMAP preview
      deviceType: 'cpu',
      deviceName: 'CPU'
    })

    // Get detailed GPU info and set device for all subsequent progress updates
    const gpuInfo = await getOpenSplatGPUInfo()
    const gpuAvailable = gpuInfo.nvidiaGpuDetected
    const useGpu = config.trainingMode === 'gpu' || (config.trainingMode === 'auto' && gpuAvailable)
    
    const modeLabel = useGpu ? 'GPU' : 'CPU'
    const trainingDeviceType: 'gpu' | 'cpu' = useGpu ? 'gpu' : 'cpu'
    const trainingDeviceName = useGpu ? (gpuInfo.gpuName || 'GPU') : 'CPU'
    
    // Log GPU info and any warnings
    if (gpuInfo.gpuName) {
      console.log(`[TrainingWorker] GPU detected: ${gpuInfo.gpuName} (CUDA ${gpuInfo.cudaVersion || 'unknown'})`)
    }
    if (gpuInfo.warning) {
      console.warn(`[TrainingWorker] GPU Warning: ${gpuInfo.warning}`)
    }
    
    console.log(`[TrainingWorker] Training will use: ${trainingDeviceName} (${trainingDeviceType})`)
    
    const engineLabel = resolvedEngine === 'gsplat' ? 'gsplat (Python/PyTorch)' : 
                        isDockerMode() ? 'OpenSplat (Docker GPU)' : `OpenSplat (${modeLabel})`
    let initMessage = `Starting ${engineLabel} training...`
    
    onProgress({
      jobId,
      status: 'training_init',
      progress: 78,
      message: initMessage,
      deviceType: trainingDeviceType,
      deviceName: trainingDeviceName
    })

    // Run training with the resolved engine
    const trainProgressCallback = (partial: Partial<JobProgress>) => {
      onProgress({
        jobId,
        status: 'training',
        progress: partial.progress || 80,
        message: partial.message || 'Training...',
        iteration: partial.iteration,
        totalIterations: partial.totalIterations,
        splatCount: partial.splatCount,
        intermediateReady: (partial as any).intermediateReady,
        deviceType: trainingDeviceType,
        deviceName: trainingDeviceName
      })
    }

    let result: TrainingResult

    if (resolvedEngine === 'gsplat') {
      result = await trainWithGsplat({
        jobId,
        imagesDir: colmapImagesDir,
        outputDir,
        colmapData: colmapResult,
        config,
        onProgress: trainProgressCallback
      })
    } else {
      result = await trainWithOpenSplat({
        jobId,
        imagesDir: colmapImagesDir,
        outputDir,
        colmapData: colmapResult,
        config,
        onProgress: trainProgressCallback
      })
    }

    // Post-processing: Depth-based floater filtering (if depth maps available)
    let finalSplatCount = result.splatCount
    const shouldUseDepthFilter = config.depthEstimationEnabled && 
                                  (config.depthFloaterFilterEnabled !== false) && 
                                  depthSummary && 
                                  depthSummary.successful > 0

    if (shouldUseDepthFilter && result.plyPath && colmapResult.cameras.length > 0) {
      onProgress({
        jobId,
        status: 'depth_filtering',
        progress: 93,
        message: 'Running AI-assisted floater detection...',
        splatCount: result.splatCount,
        deviceType: 'cpu',  // Post-processing runs on CPU
        deviceName: 'CPU'
      })

      try {
        // Read splat positions from PLY
        const plyContent = await fs.readFile(result.plyPath)
        const splatPositions = extractSplatPositions(plyContent)
        
        if (splatPositions) {
          // Convert COLMAP cameras to floater filter format
          const cameras: Camera[] = colmapResult.cameras.map((cam: CameraInfo) => ({
            id: cam.id,
            position: cam.position,
            rotation: cam.rotation,
            focalLength: cam.params[0] || 1000,  // fx from intrinsics
            width: cam.width,
            height: cam.height,
            imageName: cam.imageName
          }))

          const floaterResult = await detectFloaters(
            splatPositions,
            cameras,
            depthDir,
            depthSummary!,
            {
              depthThreshold: config.depthFloaterThreshold || 0.15,
              minCamerasAgreeing: Math.max(2, Math.floor(cameras.length * 0.3))
            }
          )

          if (floaterResult.floatersDetected > 0) {
            const depthFilteredPath = result.plyPath.replace('.ply', '_depth_filtered.ply')
            const filterStats = await removeFloatersFromPly(
              result.plyPath,
              depthFilteredPath,
              new Set(floaterResult.floaterIndices)
            )
            
            // Replace with filtered version
            await fs.rename(depthFilteredPath, result.plyPath)
            finalSplatCount = filterStats.newCount
            
            console.log(`[TrainingWorker] Depth filtering: ${filterStats.originalCount} -> ${finalSplatCount} splats`)
            
            onProgress({
              jobId,
              status: 'depth_filtering',
              progress: 95,
              message: `AI depth filter removed ${floaterResult.floatersDetected} floaters`,
              splatCount: finalSplatCount,
              deviceType: 'cpu',
              deviceName: 'CPU'
            })
          } else {
            console.log('[TrainingWorker] Depth filtering found no floaters')
          }
        }
      } catch (depthFilterError) {
        console.warn(`[TrainingWorker] Depth filtering failed:`, depthFilterError)
        // Continue with original file
      }
    }

    // Post-processing: Standard cleanup to remove remaining floaters
    onProgress({
      jobId,
      status: 'exporting',
      progress: 96,
      message: 'Running standard floater cleanup...',
      splatCount: finalSplatCount,
      deviceType: 'cpu',
      deviceName: 'CPU'
    })

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
        const removedByCleanup = finalSplatCount - cleanupStats.finalCount
        finalSplatCount = cleanupStats.finalCount
        
        console.log(`[TrainingWorker] Cleanup complete: removed ${removedByCleanup} more splats`)
        
        onProgress({
          jobId,
          status: 'exporting',
          progress: 98,
          message: `Cleanup removed ${removedByCleanup} additional floaters`,
          splatCount: finalSplatCount,
          deviceType: 'cpu',
          deviceName: 'CPU'
        })
      } catch (cleanupError) {
        console.warn(`[TrainingWorker] Cleanup failed, using current version:`, cleanupError)
        // Continue with current file if cleanup fails
      }
    }

    // Finalize
    onProgress({
      jobId,
      status: 'exporting',
      progress: 99,
      message: 'Finalizing results...',
      splatCount: finalSplatCount,
      deviceType: 'cpu',
      deviceName: 'CPU'
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
      splatCount: finalSplatCount,
      deviceType: 'cpu',
      deviceName: 'CPU'
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
      message: errorMessage,
      deviceType: 'cpu',
      deviceName: 'CPU'
    })

    throw error
  }
}
