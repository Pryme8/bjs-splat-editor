/**
 * Type definitions for the backend
 */

export type JobStatus = 
  | 'pending'
  | 'uploading'
  | 'preprocessing'
  | 'sfm_features'
  | 'sfm_matching'
  | 'sfm_reconstruction'
  | 'training_init'
  | 'training'
  | 'exporting'
  | 'complete'
  | 'failed'
  | 'cancelled'

export type TrainingMode = 'gpu' | 'cpu' | 'auto'

export interface JobConfig {
  trainingMode: TrainingMode
  iterations?: number
  resolution?: number
  shDegree?: number
  // Cleanup options
  cleanupEnabled?: boolean        // Enable/disable post-processing cleanup (default: true)
  cleanupMinOpacity?: number      // Remove splats with opacity below this (0-1, default: 0.05)
  cleanupMaxScalePercentile?: number  // Remove splats larger than this percentile (0-100, default: 99)
  cleanupSorStdDevs?: number      // Remove outliers beyond N standard deviations (default: 3.0)
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
