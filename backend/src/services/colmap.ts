/**
 * COLMAP Service - Structure from Motion pipeline
 */

import { spawn } from 'child_process'
import path from 'path'
import fs from 'fs/promises'
import type { ColmapResult, CameraInfo, JobProgress, Point3D, SceneType } from '../types/index.js'
import { registerProcess } from './processTracker.js'

// Read env vars dynamically to ensure dotenv has loaded
function getColmapPath(): string {
  return process.env.COLMAP_PATH || 'colmap'
}

function getMaxImageSize(): number {
  return parseInt(process.env.MAX_IMAGE_SIZE || '1600')
}

function getColmapQuality(): string {
  return process.env.COLMAP_QUALITY || 'medium'
}

function getGlobalMapperSetting(): string {
  return (process.env.COLMAP_USE_GLOBAL_MAPPER || 'auto').toLowerCase()
}

// Cache for global mapper availability
let cachedGlobalMapperAvailable: boolean | null = null

/**
 * Detect COLMAP version by running `colmap --version` or `colmap help`
 * Returns version string like "3.11" or null if unable to detect
 */
async function detectColmapVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    const colmapPath = getColmapPath()
    const proc = spawn(`"${colmapPath}"`, ['help'], { shell: true, timeout: 10000 })
    let output = ''
    proc.stdout.on('data', (data) => { output += data.toString() })
    proc.stderr.on('data', (data) => { output += data.toString() })
    proc.on('close', () => {
      const match = output.match(/COLMAP\s+(\d+\.\d+(?:\.\d+)?)/i)
      resolve(match ? match[1] : null)
    })
    proc.on('error', () => resolve(null))
  })
}

/**
 * Check if the global mapper (GLOMAP) is available.
 * GLOMAP is integrated into COLMAP as `global_mapper`.
 * We test by checking if the command exists in the help output.
 */
async function checkGlobalMapperAvailable(): Promise<boolean> {
  if (cachedGlobalMapperAvailable !== null) return cachedGlobalMapperAvailable

  const setting = getGlobalMapperSetting()
  if (setting === 'false') {
    cachedGlobalMapperAvailable = false
    return false
  }
  if (setting === 'true') {
    cachedGlobalMapperAvailable = true
    return true
  }

  // Auto-detect: check if global_mapper appears in the command list from `colmap help`
  return new Promise((resolve) => {
    const colmapPath = getColmapPath()
    const proc = spawn(`"${colmapPath}"`, ['help'], {
      shell: true,
      timeout: 15000
    })
    let output = ''
    proc.stdout.on('data', (data) => { output += data.toString() })
    proc.stderr.on('data', (data) => { output += data.toString() })
    proc.on('close', () => {
      const lines = output.split('\n').map(l => l.trim())
      const available = lines.some(l => l === 'global_mapper')
      cachedGlobalMapperAvailable = available
      if (available) {
        console.log('[COLMAP] Global mapper (GLOMAP) detected and available')
      } else {
        console.log('[COLMAP] Global mapper not available in this COLMAP version')
      }
      resolve(available)
    })
    proc.on('error', () => {
      cachedGlobalMapperAvailable = false
      resolve(false)
    })
  })
}

interface ColmapOptions {
  jobId: string
  imagesDir: string
  outputDir: string
  sceneType?: SceneType
  resolution?: number  // Max image size for feature extraction (matches frontend resolution)
  onProgress: (progress: Partial<JobProgress>) => void
  // Learned features (DISK + LightGlue)
  learnedFeaturesEnabled?: boolean
  learnedFeaturesMaxKeypoints?: number
}

/**
 * Scene-specific COLMAP settings
 */
interface SceneSettings {
  // Feature extraction
  siftMaxFeatures: number
  siftFirstOctave: number
  siftPeakThreshold: number
  siftEdgeThreshold: number
  siftDomainSizePooling: boolean
  siftEstimateAffineShape: boolean
  // Matching
  matcherType: 'exhaustive' | 'sequential' | 'vocab_tree'
  sequentialOverlap: number
  sequentialLoopDetection: boolean
  sequentialLoopDetectionNumImages: number  // How many images to check for loop closure
  sequentialLoopDetectionNumNNImages: number  // Nearest neighbors for loop matching
  // Mapper
  mapperMinNumMatches: number
  mapperInitMinNumInliers: number
  mapperAbsPoseMinNumInliers: number
  mapperAbsPoseMinInlierRatio: number
  mapperMaxRegTrials: number
  mapperFilterMaxReprojError: number
}

/**
 * Get scene-specific COLMAP settings
 */
function getSceneSettings(sceneType: SceneType = 'auto'): SceneSettings {
  const baseSettings: SceneSettings = {
    // Feature extraction defaults
    siftMaxFeatures: 8192,
    siftFirstOctave: -1,
    siftPeakThreshold: 0.002,
    siftEdgeThreshold: 20,
    siftDomainSizePooling: false,
    siftEstimateAffineShape: false,
    // Matching defaults
    matcherType: 'exhaustive',
    sequentialOverlap: 10,
    sequentialLoopDetection: false,
    sequentialLoopDetectionNumImages: 30,
    sequentialLoopDetectionNumNNImages: 5,
    // Mapper defaults
    mapperMinNumMatches: 8,
    mapperInitMinNumInliers: 30,
    mapperAbsPoseMinNumInliers: 15,
    mapperAbsPoseMinInlierRatio: 0.1,
    mapperMaxRegTrials: 10,
    mapperFilterMaxReprojError: 4.0
  }

  switch (sceneType) {
    case 'building360':
      // Optimized for 360° captures around buildings/objects
      return {
        ...baseSettings,
        // More features for detailed structures
        siftMaxFeatures: 16384,
        siftDomainSizePooling: true,  // Better for repetitive textures (brick, siding)
        siftEstimateAffineShape: true,  // More robust features
        // Sequential matching with aggressive loop detection (crucial for 360°)
        matcherType: 'sequential',
        sequentialOverlap: 30,  // Higher overlap to ensure good coverage
        sequentialLoopDetection: true,  // Detect when we come back to start
        sequentialLoopDetectionNumImages: 100,  // Check more images for loop closure
        sequentialLoopDetectionNumNNImages: 10,  // More nearest neighbors for matching
        // More lenient mapper settings to register all images
        mapperMinNumMatches: 6,  // Lower threshold to accept more matches
        mapperInitMinNumInliers: 20,  // Easier initialization
        mapperAbsPoseMinNumInliers: 10,  // Lower threshold for pose estimation
        mapperAbsPoseMinInlierRatio: 0.08,  // More lenient ratio
        mapperMaxRegTrials: 20,  // Try much harder to register each image
        mapperFilterMaxReprojError: 4.0  // Slightly more lenient filtering
      }

    case 'interior':
      // Optimized for indoor room scans
      return {
        ...baseSettings,
        // More features for low-texture walls
        siftMaxFeatures: 16384,
        siftPeakThreshold: 0.001,  // Lower threshold = more features
        siftEdgeThreshold: 25,  // Keep more edge features
        // Exhaustive matching for rooms (views may not be sequential)
        matcherType: 'exhaustive',
        // More lenient matching for challenging indoor scenes
        mapperMinNumMatches: 6,
        mapperInitMinNumInliers: 20,
        mapperAbsPoseMinNumInliers: 10,
        mapperAbsPoseMinInlierRatio: 0.08
      }

    case 'landscape':
      // Optimized for outdoor scenes with distant features
      return {
        ...baseSettings,
        // Standard features, higher quality
        siftMaxFeatures: 12000,
        siftFirstOctave: 0,  // Skip finest octave for speed
        // Exhaustive for potentially non-sequential views
        matcherType: 'exhaustive',
        // Standard mapper settings
        mapperFilterMaxReprojError: 4.0
      }

    case 'auto':
    default:
      // Default balanced settings
      return baseSettings
  }
}

/**
 * Run COLMAP mapper and parse results (shared by SIFT and learned features paths)
 */
async function runColmapMapper(
  jobId: string,
  databasePath: string,
  imagesDir: string,
  outputDir: string,
  sparseDir: string,
  settings: SceneSettings,
  sceneType: SceneType | undefined,
  onProgress: (progress: Partial<JobProgress>) => void
): Promise<ColmapResult> {
  // Step 3: Sparse Reconstruction (Mapping)
  onProgress({
    status: 'sfm_reconstruction',
    message: 'Running sparse reconstruction...',
    progress: 50
  })

  // Try global mapper (GLOMAP) first if available -- 10-100x faster than incremental
  const globalMapperAvailable = await checkGlobalMapperAvailable()
  let usedGlobalMapper = false

  if (globalMapperAvailable) {
    try {
      console.log('[COLMAP] Attempting global mapper (GLOMAP) for faster reconstruction...')
      onProgress({
        status: 'sfm_reconstruction',
        message: 'Running global reconstruction (GLOMAP)...',
        progress: 50
      })

      const glomapArgs = [
        '--database_path', databasePath,
        '--image_path', imagesDir,
        '--output_path', sparseDir,
      ]

      await runColmap('global_mapper', glomapArgs, (line) => {
        if (line.includes('Registering') || line.includes('Bundle') || line.includes('Position') || line.includes('Rotation')) {
          onProgress({ message: `Global reconstruction: ${line}` })
        }
      }, jobId)

      // Verify it produced output
      const models = await fs.readdir(sparseDir)
      if (models.length > 0) {
        usedGlobalMapper = true
        console.log('[COLMAP] Global mapper (GLOMAP) succeeded')
      }
    } catch (glomapErr) {
      console.warn(`[COLMAP] Global mapper failed, falling back to incremental mapper: ${glomapErr}`)
      onProgress({
        status: 'sfm_reconstruction',
        message: 'Global mapper failed, using incremental mapper...',
        progress: 50,
        notification: 'Global mapper (GLOMAP) failed, using incremental mapper',
        notificationDuration: 0
      })
      // Clean up any partial output from failed glomap attempt
      try {
        const partialModels = await fs.readdir(sparseDir)
        for (const model of partialModels) {
          await fs.rm(path.join(sparseDir, model), { recursive: true, force: true })
        }
      } catch { /* ignore cleanup errors */ }
    }
  }

  // Fall back to incremental mapper if global mapper not available or failed
  if (!usedGlobalMapper) {
    const is360Scene = sceneType === 'building360'
    const mapperArgs = [
      '--database_path', databasePath,
      '--image_path', imagesDir,
      '--output_path', sparseDir,
      // GPU-accelerated bundle adjustment
      '--Mapper.ba_use_gpu', '1',
      // Global bundle adjustment - run frequently for GPU utilization
      '--Mapper.ba_global_max_num_iterations', is360Scene ? '100' : '50',
      '--Mapper.ba_global_max_refinements', is360Scene ? '5' : '3',
      '--Mapper.ba_global_points_freq', '5000',   // Every 5K points (was 250K)
      '--Mapper.ba_global_frames_freq', '10',     // Every 10 images (was 500)
      // Local bundle adjustment - more iterations for better quality
      '--Mapper.ba_local_max_num_iterations', '25',
      // Core mapper settings
      '--Mapper.min_num_matches', settings.mapperMinNumMatches.toString(),
      '--Mapper.init_min_num_inliers', settings.mapperInitMinNumInliers.toString(),
      '--Mapper.abs_pose_min_num_inliers', settings.mapperAbsPoseMinNumInliers.toString(),
      '--Mapper.abs_pose_min_inlier_ratio', settings.mapperAbsPoseMinInlierRatio.toString(),
      '--Mapper.max_reg_trials', settings.mapperMaxRegTrials.toString(),
      '--Mapper.filter_max_reproj_error', settings.mapperFilterMaxReprojError.toString(),
      '--Mapper.multiple_models', '0',  // Force single model (all images together)
      // Performance optimizations
      '--Mapper.tri_ignore_two_view_tracks', '1',  // Skip expensive 2-view tracks
    ]

    // For 360° scenes, try harder to complete the loop
    if (is360Scene) {
      mapperArgs.push(
        '--Mapper.tri_complete_max_transitivity', '10',
        '--Mapper.tri_re_max_trials', '5'
      )
      console.log(`[COLMAP] 360° scene: Enhanced BA (every 10 frames, GPU-accelerated)`)
    } else {
      console.log(`[COLMAP] Incremental mapper: GPU-accelerated BA (local + global every 10 frames)`)
    }

    await runColmap('mapper', mapperArgs, (line) => {
      if (line.includes('Registering') || line.includes('Bundle adjustment')) {
        onProgress({ message: `Reconstruction: ${line}` })
      }
    }, jobId)
  }

  // Check if reconstruction succeeded
  const sparseModels = await fs.readdir(sparseDir)
  if (sparseModels.length === 0) {
    throw new Error('COLMAP reconstruction failed - no models created. This usually means COLMAP could not find a good initial image pair. Try with more overlapping images or better scene coverage.')
  }

  // Use the first (usually best) model
  const modelDir = path.join(sparseDir, sparseModels[0])

  // Step 4: Point filtering - remove noisy/outlier 3D points for cleaner reconstruction
  onProgress({
    status: 'sfm_reconstruction',
    message: 'Filtering outlier points...',
    progress: 65
  })

  const filteredDir = path.join(sparseDir, 'filtered')
  await fs.mkdir(filteredDir, { recursive: true })
  let exportModelDir = modelDir

  try {
    await runColmap('point_filtering', [
      '--input_path', modelDir,
      '--output_path', filteredDir,
      '--min_track_len', '3',        // Points must be seen in >= 3 images
      '--max_reproj_error', '4',     // Max reprojection error in pixels
      '--min_tri_angle', '1.5',      // Min triangulation angle in degrees
    ], (line) => {
      if (line.includes('Filtered') || line.includes('points')) {
        onProgress({ message: `Point filtering: ${line}` })
      }
    }, jobId)

    // Check if filtering produced output, use filtered model going forward
    const filteredFiles = await fs.readdir(filteredDir)
    if (filteredFiles.length > 0) {
      console.log('[COLMAP] Point filtering complete, using filtered model')
      exportModelDir = filteredDir
    } else {
      console.log('[COLMAP] Point filtering produced no output, using original model')
    }
  } catch (filterErr) {
    console.warn(`[COLMAP] Point filtering failed, using unfiltered model: ${filterErr}`)
    onProgress({
      status: 'sfm_reconstruction',
      message: 'Point filtering skipped, using unfiltered model',
      progress: 66,
      notification: 'Point filtering failed, using unfiltered model',
      notificationDuration: 2600
    })
  }

  // Step 5: Export to text format for parsing
  onProgress({
    status: 'sfm_reconstruction',
    message: 'Exporting camera data...',
    progress: 70
  })

  const textDir = path.join(outputDir, 'sparse_text')
  await fs.mkdir(textDir, { recursive: true })

  await runColmap('model_converter', [
    '--input_path', exportModelDir,
    '--output_path', textDir,
    '--output_type', 'TXT'
  ], undefined, jobId)

  // Parse results
  const cameras = await parseCamerasFile(path.join(textDir, 'cameras.txt'))
  const images = await parseImagesFile(path.join(textDir, 'images.txt'))
  
  // Log camera dimensions from COLMAP
  for (const [cameraId, camera] of Object.entries(cameras)) {
    console.log(`[COLMAP] Camera ${cameraId}: ${camera.model} ${camera.width}x${camera.height}, params: [${camera.params.join(', ')}]`)
    const aspectRatio = camera.width / camera.height
    console.log(`[COLMAP] Camera ${cameraId} aspect ratio: ${aspectRatio.toFixed(3)} (${camera.width / camera.height > 1 ? 'landscape' : 'portrait'})`)
  }
  
  const registeredImageCount = images.length
  const { points: points3D, count: points3DCount } = await parsePoints3DFile(
    path.join(textDir, 'points3D.txt'),
    registeredImageCount
  )

  // Combine camera and image data
  const cameraInfos: CameraInfo[] = images.map((img) => ({
    id: img.id,
    model: cameras[img.cameraId]?.model || 'SIMPLE_RADIAL',
    width: cameras[img.cameraId]?.width || 1920,
    height: cameras[img.cameraId]?.height || 1080,
    params: cameras[img.cameraId]?.params || [],
    position: img.position,
    rotation: img.rotation,
    imageName: img.name
  }))

  onProgress({
    status: 'sfm_reconstruction',
    message: `SfM complete: ${cameraInfos.length} cameras, ${points3DCount} points`,
    progress: 75
  })

  return {
    cameras: cameraInfos,
    points3D,
    points3DCount,
    sparse: modelDir
  }
}

/**
 * Run a COLMAP command
 */
async function runColmap(
  command: string,
  args: string[],
  onOutput?: (line: string) => void,
  jobId?: string,
  env?: Record<string, string>
): Promise<void> {
  return new Promise((resolve, reject) => {
    const colmapPath = getColmapPath()
    console.log(`[COLMAP] Running: ${colmapPath} ${command} ${args.join(' ')}`)
    // Use shell: true for Windows batch file compatibility
    const proc = spawn(`"${colmapPath}"`, [command, ...args], { 
      shell: true,
      env: env ? { ...process.env, ...env } : undefined
    })
    
    // Register process for cancellation tracking
    if (jobId) {
      registerProcess(jobId, proc)
    }

    // Capture ALL output for error reporting
    const outputLines: string[] = []
    const errorLines: string[] = []

    proc.stdout.on('data', (data) => {
      const lines = data.toString().split('\n')
      for (const line of lines) {
        if (line.trim()) {
          outputLines.push(line)
          console.log(`[COLMAP ${command}]`, line)
          onOutput?.(line)
        }
      }
    })

    proc.stderr.on('data', (data) => {
      const lines = data.toString().split('\n')
      for (const line of lines) {
        if (line.trim()) {
          errorLines.push(line)
          console.error(`[COLMAP ${command} ERROR]`, line)
          onOutput?.(line)
        }
      }
    })

    proc.on('close', (code) => {
      if (code === 0) {
        resolve()
      } else {
        // Include captured output in error message
        const lastErrors = errorLines.slice(-10).join('\n') || outputLines.slice(-10).join('\n')
        const errorMsg = `COLMAP ${command} failed with code ${code}${lastErrors ? `\n\nLast output:\n${lastErrors}` : ''}`
        reject(new Error(errorMsg))
      }
    })

    proc.on('error', (err) => {
      reject(new Error(`Failed to run COLMAP: ${err.message}`))
    })
  })
}

/**
 * Run the full COLMAP SfM pipeline
 */
export async function runColmapPipeline(options: ColmapOptions): Promise<ColmapResult> {
  const { 
    jobId, 
    imagesDir, 
    outputDir, 
    sceneType, 
    resolution,
    onProgress,
    learnedFeaturesEnabled = false,
    learnedFeaturesMaxKeypoints = 4096
  } = options

  // Use frontend resolution if provided, otherwise fall back to env var
  const maxImageSize = resolution || getMaxImageSize()
  console.log(`[COLMAP] Max image size: ${maxImageSize}${resolution ? ` (from config)` : ` (from env/default)`}`)
  console.log(`[COLMAP] GPU acceleration: Bundle adjustment (local + global every 10 frames)`)
  
  // Create working directories
  const databasePath = path.join(outputDir, 'database.db')
  const sparseDir = path.join(outputDir, 'sparse')
  
  await fs.mkdir(sparseDir, { recursive: true })

  // Get scene-specific settings
  const settings = getSceneSettings(sceneType)
  console.log(`[COLMAP] Using scene type: ${sceneType || 'auto'}`)
  console.log(`[COLMAP] Matcher type: ${settings.matcherType}`)
  console.log(`[COLMAP] Learned features: ${learnedFeaturesEnabled ? 'DISK + LightGlue' : 'disabled (using SIFT)'}`)

  // Check if we should use learned features (DISK + LightGlue)
  if (learnedFeaturesEnabled) {
    // Use DISK + LightGlue for feature extraction and matching
    const { extractLearnedFeatures, checkLearnedFeaturesAvailable } = await import('./learnedFeatures.js')
    
    const available = await checkLearnedFeaturesAvailable()
    if (!available) {
      console.warn('[COLMAP] Learned features requested but kornia not available, falling back to SIFT')
      onProgress({
        status: 'sfm_features',
        message: 'DISK+LightGlue unavailable (Python/kornia missing), using SIFT...',
        progress: 10,
        notification: 'DISK+LightGlue unavailable, falling back to SIFT features',
        notificationDuration: 0
      })
    } else {
      onProgress({
        status: 'learned_features',
        message: 'Loading DISK + LightGlue models...',
        progress: 10
      })

      // Count images to auto-select match strategy
      const imageFiles = await fs.readdir(imagesDir)
      const imageCount = imageFiles.filter(f => /\.(jpg|jpeg|png|bmp|tif|tiff)$/i.test(f)).length

      // Auto-select matching strategy based on scene type and image count:
      // - Sequential scenes use 'window' (sliding window for ordered images)
      // - Small sets (<= 30 images) use 'exhaustive' (fast enough, best quality)
      // - Large sets (> 30 images) use 'retrieval' (top-k by descriptor similarity)
      let autoMatchStrategy: 'exhaustive' | 'window' | 'retrieval'
      if (settings.matcherType === 'sequential') {
        autoMatchStrategy = 'window'
      } else if (imageCount <= 30) {
        autoMatchStrategy = 'exhaustive'
      } else {
        autoMatchStrategy = 'retrieval'
      }
      console.log(`[COLMAP] Auto-selected match strategy: ${autoMatchStrategy} (${imageCount} images)`)

      try {
        const result = await extractLearnedFeatures(imagesDir, databasePath, {
          jobId,
          maxKeypoints: learnedFeaturesMaxKeypoints,
          maxImageSize,
          matchStrategy: autoMatchStrategy,
          matchTopk: 20,
          skipVerification: false,
          onProgress: (message, phase, current, total, deviceInfo) => {
            // Features: 10-25%, Matching: 25-45%
            let progressPct: number
            if (phase === 'features') {
              progressPct = 10 + Math.round((current / total) * 15)  // 10-25%
            } else {
              progressPct = 25 + Math.round((current / total) * 20)  // 25-45%
            }
            onProgress({
              status: 'learned_features',
              message: `DISK + LightGlue: ${message}`,
              progress: progressPct,
              deviceType: deviceInfo?.deviceType,
              deviceName: deviceInfo?.deviceName
            })
          }
        })

        console.log(`[COLMAP] Learned features: ${result.images} images, ${result.total_matches} matches (${result.match_strategy || 'unknown'} strategy, ${result.total_pairs || 0} pairs)`)
        if (result.verified_pairs) {
          console.log(`[COLMAP] Geometric verification: ${result.verified_pairs} pairs, ${result.total_inliers} inliers`)
        }
        if (result.device_type && result.device_name) {
          console.log(`[COLMAP] Device: ${result.device_name} (${result.device_type.toUpperCase()})`)
        }
        if (result.exif_count && result.exif_count > 0) {
          console.log(`[COLMAP] Camera: ${result.camera_make} ${result.camera_model} (${result.exif_count} images with EXIF)`)
          if (result.focal_mm && result.focal_pixels) {
            console.log(`[COLMAP] Focal length: ${result.focal_mm.toFixed(1)}mm (${result.focal_pixels.toFixed(0)}px from EXIF)`)
          }
        }
        
        onProgress({
          status: 'learned_features',
          message: result.verified_pairs 
            ? `Features complete: ${result.verified_pairs} verified pairs, ${result.avg_inliers_per_pair?.toFixed(0) || 0} avg inliers`
            : `Features complete: ${result.pairs_matched} matched pairs, ${result.avg_matches_per_pair.toFixed(0)} avg matches`,
          progress: 45,
          deviceType: result.device_type,
          deviceName: result.device_name
        })

        // Skip to reconstruction (mapper) - features and matches already in database
        return await runColmapMapper(
          jobId, 
          databasePath, 
          imagesDir, 
          outputDir, 
          sparseDir, 
          settings, 
          sceneType, 
          onProgress
        )
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        const errStack = err instanceof Error ? err.stack : ''
        console.error('[COLMAP] *** LEARNED FEATURES FAILED - falling back to SIFT ***')
        console.error('[COLMAP] Error:', errMsg)
        if (errStack) console.error('[COLMAP] Stack:', errStack)
        onProgress({
          status: 'sfm_features',
          message: `DISK+LightGlue failed: ${errMsg.slice(0, 100)} - falling back to SIFT`,
          progress: 10,
          notification: `Learned features failed, falling back to SIFT`,
          notificationDuration: 0
        })
        
        // Delete the database before SIFT fallback to avoid constraint errors
        try {
          await fs.unlink(databasePath)
          console.log('[COLMAP] Deleted database for SIFT fallback')
        } catch (unlinkErr) {
          console.warn('[COLMAP] Could not delete database:', unlinkErr)
        }
        
        // Fall through to SIFT extraction
      }
    }
  }

  // Step 1: Feature Extraction (SIFT)
  onProgress({
    status: 'sfm_features',
    message: `Extracting image features (${sceneType || 'auto'} mode)...`,
    progress: 10
  })
  
  // Log sample image files to verify they exist
  const imageFiles = await fs.readdir(imagesDir)
  console.log(`[COLMAP] Found ${imageFiles.length} images in ${imagesDir}`)
  if (imageFiles.length > 0) {
    console.log(`[COLMAP] First image: ${imageFiles[0]}`)
  }

  const featureArgs = [
    '--database_path', databasePath,
    '--image_path', imagesDir,
    '--ImageReader.single_camera', '1',
    '--ImageReader.camera_model', 'SIMPLE_RADIAL',
    '--SiftExtraction.max_image_size', maxImageSize.toString(),
    '--SiftExtraction.max_num_features', (settings.siftMaxFeatures * 2).toString(),
    '--SiftExtraction.first_octave', settings.siftFirstOctave.toString(),
    '--SiftExtraction.peak_threshold', settings.siftPeakThreshold.toString(),
    '--SiftExtraction.edge_threshold', settings.siftEdgeThreshold.toString(),
  ]
  
  console.log('[COLMAP] Feature extraction: Using COLMAP defaults (older build detected)')

  // Add optional feature extraction settings
  if (settings.siftDomainSizePooling) {
    featureArgs.push('--SiftExtraction.domain_size_pooling', '1')
  }
  if (settings.siftEstimateAffineShape) {
    featureArgs.push('--SiftExtraction.estimate_affine_shape', '1')
  }

  await runColmap('feature_extractor', featureArgs, (line) => {
    if (line.includes('Processed')) {
      onProgress({ message: `Feature extraction: ${line}` })
    }
  }, jobId)

  // Step 2: Feature Matching (scene-type dependent)
  onProgress({
    status: 'sfm_matching',
    message: `Matching features (${settings.matcherType})...`,
    progress: 30
  })

  if (settings.matcherType === 'sequential') {
    // Sequential matching - good for ordered image sequences (building walkarounds)
    const matchArgs = [
      '--database_path', databasePath,
      '--SequentialMatching.overlap', settings.sequentialOverlap.toString(),
    ]
    if (settings.sequentialLoopDetection) {
      matchArgs.push('--SequentialMatching.loop_detection', '1')
      matchArgs.push('--SequentialMatching.loop_detection_num_images', settings.sequentialLoopDetectionNumImages.toString())
      matchArgs.push('--SequentialMatching.loop_detection_num_nearest_neighbors', settings.sequentialLoopDetectionNumNNImages.toString())
    }
    await runColmap('sequential_matcher', matchArgs, (line) => {
      if (line.includes('Matching') || line.includes('Loop')) {
        onProgress({ message: `Sequential matching: ${line}` })
      }
    }, jobId)
  } else {
    // Count images to pick the best matching strategy
    const imageFiles = await fs.readdir(imagesDir)
    const imageCount = imageFiles.filter(f => /\.(jpg|jpeg|png|bmp|tif|tiff)$/i.test(f)).length

    if (imageCount > 30) {
      // Vocab tree matching - O(n) vs O(n²), much faster for large sets
      // COLMAP 3.12+ auto-downloads the vocabulary tree from the default URL
      console.log(`[COLMAP] Vocab tree matching: ${imageCount} images (faster than exhaustive)`)
      onProgress({
        status: 'sfm_matching',
        message: `Vocab tree matching (${imageCount} images)...`,
        progress: 30
      })

      try {
        await runColmap('vocab_tree_matcher', [
          '--database_path', databasePath,
          '--VocabTreeMatching.num_images', Math.min(imageCount, 100).toString(),
          '--VocabTreeMatching.num_nearest_neighbors', '5',
        ], (line) => {
          if (line.includes('Matching') || line.includes('Retriev')) {
            onProgress({ message: `Vocab tree matching: ${line}` })
          }
        }, jobId)
      } catch (vtErr) {
        // Vocab tree failed (maybe can't download tree), fall back to exhaustive
        console.warn(`[COLMAP] Vocab tree matching failed, falling back to exhaustive: ${vtErr}`)
        onProgress({
          status: 'sfm_matching',
          message: 'Vocab tree failed, using exhaustive matching...',
          progress: 30,
          notification: 'Vocab tree matching failed, using exhaustive matching',
          notificationDuration: 2600
        })

        const blockSize = imageCount > 200 ? 25 : imageCount > 100 ? 50 : 100
        await runColmap('exhaustive_matcher', [
          '--database_path', databasePath,
          '--ExhaustiveMatching.block_size', blockSize.toString(),
        ], (line) => {
          if (line.includes('Matching')) {
            onProgress({ message: `Feature matching: ${line}` })
          }
        }, jobId)
      }
    } else {
      // Exhaustive matching - fine for small image sets
      const blockSize = 100
      console.log(`[COLMAP] Exhaustive matching: ${imageCount} images, block_size=${blockSize}`)

      try {
        await runColmap('exhaustive_matcher', [
          '--database_path', databasePath,
          '--ExhaustiveMatching.block_size', blockSize.toString(),
        ], (line) => {
          if (line.includes('Matching')) {
            onProgress({ message: `Feature matching: ${line}` })
          }
        }, jobId)
      } catch (gpuErr) {
        // GPU matching crashed - retry on CPU
        console.warn(`[COLMAP] GPU exhaustive matching failed, retrying with CPU: ${gpuErr}`)
        onProgress({
          status: 'sfm_matching',
          message: 'GPU matching failed, retrying on CPU...',
          progress: 30,
          notification: 'GPU matching failed, retrying on CPU',
          notificationDuration: 2600
        })

        await runColmap('exhaustive_matcher', [
          '--database_path', databasePath,
          '--ExhaustiveMatching.block_size', blockSize.toString(),
        ], (line) => {
          if (line.includes('Matching')) {
            onProgress({ message: `Feature matching (CPU): ${line}` })
          }
        }, jobId, { CUDA_VISIBLE_DEVICES: '' })
      }
    }

    // Spatial matching - supplement with GPS-based matches if images have location data
    // This is fast and only helps, so we try it and ignore failures
    try {
      console.log('[COLMAP] Attempting spatial matching (GPS-based)...')
      await runColmap('spatial_matcher', [
        '--database_path', databasePath,
        '--SpatialMatching.max_num_neighbors', '50',
        '--SpatialMatching.max_distance', '100',
      ], undefined, jobId)
      console.log('[COLMAP] Spatial matching added GPS-based matches')
      onProgress({
        status: 'sfm_matching',
        message: 'Spatial matching added GPS-based matches',
        progress: 35,
        notification: 'GPS data found — added spatial matches',
        notificationDuration: 2600
      })
    } catch {
      // No GPS data or spatial matching failed - that's fine, it's supplementary
      console.log('[COLMAP] Spatial matching skipped (no GPS data or not applicable)')
    }
  }

  // For 360° scenes, run transitive matching to fill in gaps and strengthen loop closure
  // Transitive matching: if A matches B and B matches C, try to match A to C directly
  if (sceneType === 'building360') {
    onProgress({
      status: 'sfm_matching',
      message: 'Running transitive matching for loop closure...',
      progress: 40
    })

    await runColmap('transitive_matcher', [
      '--database_path', databasePath,
    ], (line) => {
      if (line.includes('Matching') || line.includes('Transitive')) {
        onProgress({ message: `Transitive matching: ${line}` })
      }
    }, jobId)
    
    console.log(`[COLMAP] Transitive matching complete for 360° scene`)
  }

  // Step 3+4: Run mapper and parse results (shared with learned features path)
  return await runColmapMapper(
    jobId,
    databasePath,
    imagesDir,
    outputDir,
    sparseDir,
    settings,
    sceneType,
    onProgress
  )
}

/**
 * Parse COLMAP cameras.txt file
 */
async function parseCamerasFile(filepath: string): Promise<Record<number, {
  model: string
  width: number
  height: number
  params: number[]
}>> {
  const content = await fs.readFile(filepath, 'utf-8')
  const cameras: Record<number, any> = {}

  for (const line of content.split('\n')) {
    if (line.startsWith('#') || !line.trim()) continue
    
    const parts = line.trim().split(/\s+/)
    if (parts.length >= 5) {
      const id = parseInt(parts[0])
      cameras[id] = {
        model: parts[1],
        width: parseInt(parts[2]),
        height: parseInt(parts[3]),
        params: parts.slice(4).map(parseFloat)
      }
    }
  }

  return cameras
}

/**
 * Convert quaternion to rotation matrix
 * Input: [qx, qy, qz, qw] in Babylon.js order
 */
function quaternionToRotationMatrix(qx: number, qy: number, qz: number, qw: number): number[][] {
  const xx = qx * qx, yy = qy * qy, zz = qz * qz
  const xy = qx * qy, xz = qx * qz, yz = qy * qz
  const wx = qw * qx, wy = qw * qy, wz = qw * qz
  
  return [
    [1 - 2 * (yy + zz), 2 * (xy - wz), 2 * (xz + wy)],
    [2 * (xy + wz), 1 - 2 * (xx + zz), 2 * (yz - wx)],
    [2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (xx + yy)]
  ]
}

/**
 * Compute camera center from COLMAP's rotation (world-to-camera) and translation
 * Camera center C = -R^T * t
 */
function computeCameraCenter(qw: number, qx: number, qy: number, qz: number, tx: number, ty: number, tz: number): [number, number, number] {
  // Rotation matrix from quaternion (world-to-camera)
  const R = quaternionToRotationMatrix(qx, qy, qz, qw)
  
  // R^T * t (transpose of R times translation)
  const cx = -(R[0][0] * tx + R[1][0] * ty + R[2][0] * tz)
  const cy = -(R[0][1] * tx + R[1][1] * ty + R[2][1] * tz)
  const cz = -(R[0][2] * tx + R[1][2] * ty + R[2][2] * tz)
  
  return [cx, cy, cz]
}

/**
 * Invert a quaternion (for converting world-to-camera to camera-to-world)
 * For unit quaternion, inverse is conjugate: [qx, qy, qz, qw] -> [-qx, -qy, -qz, qw]
 */
function invertQuaternion(qx: number, qy: number, qz: number, qw: number): [number, number, number, number] {
  return [-qx, -qy, -qz, qw]
}

/**
 * Parse COLMAP images.txt file
 * Returns camera center (actual position in world space) and camera-to-world rotation
 */
async function parseImagesFile(filepath: string): Promise<Array<{
  id: number
  cameraId: number
  rotation: [number, number, number, number]
  position: [number, number, number]
  name: string
}>> {
  const content = await fs.readFile(filepath, 'utf-8')
  const images: any[] = []
  const lines = content.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith('#') || !line.trim()) continue

    const parts = line.trim().split(/\s+/)
    if (parts.length >= 10) {
      // IMAGE_ID, QW, QX, QY, QZ, TX, TY, TZ, CAMERA_ID, NAME
      const id = parseInt(parts[0])
      const qw = parseFloat(parts[1])
      const qx = parseFloat(parts[2])
      const qy = parseFloat(parts[3])
      const qz = parseFloat(parts[4])
      const tx = parseFloat(parts[5])
      const ty = parseFloat(parts[6])
      const tz = parseFloat(parts[7])
      const cameraId = parseInt(parts[8])
      const name = parts[9]

      // Compute actual camera center in world coordinates
      const position = computeCameraCenter(qw, qx, qy, qz, tx, ty, tz)
      
      // Invert quaternion: world-to-camera -> camera-to-world (for Babylon.js)
      const rotation = invertQuaternion(qx, qy, qz, qw)

      images.push({
        id,
        cameraId,
        rotation,
        position,
        name
      })

      // Skip the next line (2D points)
      i++
    }
  }

  return images
}

/**
 * Parse points3D.txt file - returns actual point data (XYZ + RGB)
 * Limits points based on number of registered images for performance
 * @param filepath Path to points3D.txt
 * @param registeredImageCount Number of successfully registered images
 */
const BASE_POINTS_LIMIT = 50000  // Minimum points
const POINTS_PER_IMAGE = 30000  // Additional points per registered image

async function parsePoints3DFile(filepath: string, registeredImageCount: number): Promise<{ points: Point3D[], count: number }> {
  // Scale point limit with number of images
  // More images = more valid triangulated points = allow more through
  const maxPoints = BASE_POINTS_LIMIT + (registeredImageCount * POINTS_PER_IMAGE)
  
  const content = await fs.readFile(filepath, 'utf-8')
  const points: Point3D[] = []
  let totalCount = 0
  
  for (const line of content.split('\n')) {
    if (line.startsWith('#') || !line.trim()) continue
    
    totalCount++
    
    // Only parse up to maxPoints for performance
    if (points.length >= maxPoints) continue
    
    // Format: POINT3D_ID X Y Z R G B ERROR TRACK[] (track is pairs of IMAGE_ID POINT2D_IDX)
    const parts = line.trim().split(/\s+/)
    if (parts.length >= 7) {
      points.push({
        x: parseFloat(parts[1]),
        y: parseFloat(parts[2]),
        z: parseFloat(parts[3]),
        r: parseInt(parts[4]),
        g: parseInt(parts[5]),
        b: parseInt(parts[6])
      })
    }
  }

  console.log(`[COLMAP] Parsed ${points.length} points (total: ${totalCount}, limit: ${maxPoints} for ${registeredImageCount} images)`)
  return { points, count: totalCount }
}

/**
 * Check if COLMAP is available
 */
export async function checkColmapAvailable(): Promise<boolean> {
  try {
    await runColmap('help', [])
    return true
  } catch {
    return false
  }
}
