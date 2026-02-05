/**
 * COLMAP Service - Structure from Motion pipeline
 */

import { spawn } from 'child_process'
import path from 'path'
import fs from 'fs/promises'
import type { ColmapResult, CameraInfo, JobProgress, Point3D } from '../types/index.js'
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

interface ColmapOptions {
  jobId: string
  imagesDir: string
  outputDir: string
  onProgress: (progress: Partial<JobProgress>) => void
}

/**
 * Run a COLMAP command
 */
async function runColmap(
  command: string,
  args: string[],
  onOutput?: (line: string) => void,
  jobId?: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const colmapPath = getColmapPath()
    console.log(`[COLMAP] Running: ${colmapPath} ${command} ${args.join(' ')}`)
    // Use shell: true for Windows batch file compatibility
    const proc = spawn(`"${colmapPath}"`, [command, ...args], { shell: true })
    
    // Register process for cancellation tracking
    if (jobId) {
      registerProcess(jobId, proc)
    }

    proc.stdout.on('data', (data) => {
      const lines = data.toString().split('\n')
      for (const line of lines) {
        if (line.trim()) {
          onOutput?.(line)
        }
      }
    })

    proc.stderr.on('data', (data) => {
      const lines = data.toString().split('\n')
      for (const line of lines) {
        if (line.trim()) {
          onOutput?.(line)
        }
      }
    })

    proc.on('close', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`COLMAP ${command} failed with code ${code}`))
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
  const { jobId, imagesDir, outputDir, onProgress } = options
  
  // Create working directories
  const databasePath = path.join(outputDir, 'database.db')
  const sparseDir = path.join(outputDir, 'sparse')
  
  await fs.mkdir(sparseDir, { recursive: true })

  // Quality presets
  const qualitySettings = {
    low: { siftMaxFeatures: 4096, matcherType: 'exhaustive' },
    medium: { siftMaxFeatures: 8192, matcherType: 'exhaustive' },
    high: { siftMaxFeatures: 16384, matcherType: 'exhaustive' }
  }
  const colmapQuality = getColmapQuality()
  const quality = qualitySettings[colmapQuality as keyof typeof qualitySettings] || qualitySettings.medium

  // Step 1: Feature Extraction
  onProgress({
    status: 'sfm_features',
    message: 'Extracting image features...',
    progress: 10
  })

  await runColmap('feature_extractor', [
    '--database_path', databasePath,
    '--image_path', imagesDir,
    '--ImageReader.single_camera', '1',
    '--ImageReader.camera_model', 'SIMPLE_RADIAL',
    '--SiftExtraction.max_image_size', getMaxImageSize().toString(),
    '--SiftExtraction.max_num_features', (quality.siftMaxFeatures * 2).toString(),  // Double max features
    '--SiftExtraction.first_octave', '-1',  // More features at fine scales
    '--SiftExtraction.peak_threshold', '0.002',  // Even lower = more features (default 0.0067)
    '--SiftExtraction.edge_threshold', '20',  // Higher = more features kept (default 10)
  ], (line) => {
    if (line.includes('Processed')) {
      onProgress({ message: `Feature extraction: ${line}` })
    }
  }, jobId)

  // Step 2: Feature Matching
  onProgress({
    status: 'sfm_matching',
    message: 'Matching features between images...',
    progress: 30
  })

  await runColmap('exhaustive_matcher', [
    '--database_path', databasePath,
  ], (line) => {
    if (line.includes('Matching')) {
      onProgress({ message: `Feature matching: ${line}` })
    }
  }, jobId)

  // Step 3: Sparse Reconstruction (Mapping)
  onProgress({
    status: 'sfm_reconstruction',
    message: 'Running sparse reconstruction...',
    progress: 50
  })

  await runColmap('mapper', [
    '--database_path', databasePath,
    '--image_path', imagesDir,
    '--output_path', sparseDir,
    '--Mapper.ba_global_max_num_iterations', '50',
    '--Mapper.ba_global_max_refinements', '5',
    '--Mapper.min_num_matches', '8',  // Even lower (default 15)
    '--Mapper.init_min_num_inliers', '30',  // Lower init threshold (default 100)
    '--Mapper.abs_pose_min_num_inliers', '15',  // Lower pose threshold (default 30)
    '--Mapper.abs_pose_min_inlier_ratio', '0.1',  // Lower ratio (default 0.25)
    '--Mapper.max_reg_trials', '10',  // More attempts to register each image
    '--Mapper.multiple_models', '0',  // Force single model (all images together)
  ], (line) => {
    if (line.includes('Registering') || line.includes('Bundle adjustment')) {
      onProgress({ message: `Reconstruction: ${line}` })
    }
  }, jobId)

  // Check if reconstruction succeeded
  const sparseModels = await fs.readdir(sparseDir)
  if (sparseModels.length === 0) {
    throw new Error('COLMAP reconstruction failed - no models created. Try with more images or better coverage.')
  }

  // Use the first (usually best) model
  const modelDir = path.join(sparseDir, sparseModels[0])

  // Step 4: Export to text format for easier parsing
  onProgress({
    status: 'sfm_reconstruction',
    message: 'Exporting camera data...',
    progress: 70
  })

  const textDir = path.join(outputDir, 'sparse_text')
  await fs.mkdir(textDir, { recursive: true })

  await runColmap('model_converter', [
    '--input_path', modelDir,
    '--output_path', textDir,
    '--output_type', 'TXT'
  ], undefined, jobId)

  // Parse results
  const cameras = await parseCamerasFile(path.join(textDir, 'cameras.txt'))
  const images = await parseImagesFile(path.join(textDir, 'images.txt'))
  
  // Pass registered image count to scale point limit
  const registeredImageCount = images.length
  const { points: points3D, count: points3DCount } = await parsePoints3DFile(
    path.join(textDir, 'points3D.txt'),
    registeredImageCount
  )

  // Combine camera and image data
  const cameraInfos: CameraInfo[] = images.map((img, idx) => ({
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
