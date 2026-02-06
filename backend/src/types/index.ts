/**
 * Type definitions for the backend
 */

export type JobStatus = 
  | 'pending'
  | 'uploading'
  | 'preprocessing'
  | 'depth_estimation'
  | 'learned_features'  // DISK + LightGlue extraction
  | 'sfm_features'
  | 'sfm_matching'
  | 'sfm_reconstruction'
  | 'training_init'
  | 'training'
  | 'depth_filtering'
  | 'exporting'
  | 'complete'
  | 'failed'
  | 'cancelled'

export type TrainingMode = 'gpu' | 'cpu' | 'auto'

// Scene type for COLMAP optimization
export type SceneType = 'auto' | 'building360' | 'interior' | 'landscape'

export type QualityPreset = 'fast' | 'medium' | 'high'

export type DepthModelSize = 'small' | 'base' | 'large'

// Learned feature matching options
export type LearnedFeaturesMode = 'off' | 'superpoint_lightglue'

export interface JobConfig {
  trainingMode: TrainingMode
  iterations?: number
  resolution?: number
  shDegree?: number               // Spherical harmonics degree (1-3, default: 3)
  // Scene type for COLMAP optimization
  sceneType?: SceneType
  // Quality preset (affects densification behavior)
  qualityPreset?: QualityPreset   // 'fast' | 'medium' | 'high' - controls splat density
  // Cleanup options
  cleanupEnabled?: boolean        // Enable/disable post-processing cleanup (default: true)
  cleanupMinOpacity?: number      // Remove splats with opacity below this (0-1, default: 0.05)
  cleanupMaxScalePercentile?: number  // Remove splats larger than this percentile (0-100, default: 99)
  cleanupSorStdDevs?: number      // Remove outliers beyond N standard deviations (default: 3.0)
  // Depth estimation options (AI-enhanced)
  depthEstimationEnabled?: boolean  // Run Depth Anything for depth maps (default: false)
  depthModelSize?: DepthModelSize   // 'small' | 'base' | 'large' (default: 'small')
  depthFloaterFilterEnabled?: boolean  // Use depth maps to filter floaters (default: true when depth enabled)
  depthFloaterThreshold?: number    // Depth difference threshold for floater detection (default: 0.15)
  // Learned feature matching options (AI-enhanced)
  learnedFeaturesEnabled?: boolean  // Use DISK + LightGlue instead of SIFT (default: false)
  learnedFeaturesMaxKeypoints?: number  // Max keypoints per image (default: 2048)
}

export interface Job {
  id: string
  status: JobStatus
  progress: number
  message: string
  config: JobConfig
  imageCount: number
  createdAt: Date
  updatedAt: Date
  completedAt?: Date
  error?: string
  resultUrl?: string
  colmapData?: ColmapResult
}

export interface JobProgress {
  jobId: string
  status: JobStatus
  progress: number
  message: string
  stage?: string
  iteration?: number
  totalIterations?: number
  loss?: number
  splatCount?: number
  intermediateReady?: boolean  // Signals a new intermediate PLY is available
  colmapPreviewReady?: boolean  // Signals COLMAP data is available for preview
}

export interface Point3D {
  x: number
  y: number
  z: number
  r: number  // 0-255
  g: number
  b: number
}

export interface ColmapResult {
  cameras: CameraInfo[]
  points3D: Point3D[]
  points3DCount: number  // Keep count for quick access
  sparse: string // Path to sparse reconstruction
}

export interface CameraInfo {
  id: number
  model: string
  width: number
  height: number
  params: number[]
  position: [number, number, number]
  rotation: [number, number, number, number]
  imageName: string
}

export interface UploadedImage {
  originalName: string
  filename: string
  path: string
  size: number
}

export interface TrainingResult {
  plyPath: string
  splatPath?: string
  splatCount: number
  trainingTime: number
  finalLoss?: number
}
