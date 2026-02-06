/**
 * Worker message types for WebGPU Generator
 */

export type WorkerMessageType =
  | 'init'
  | 'generate'
  | 'cancel'
  | 'progress'
  | 'complete'
  | 'error'
  | 'ready'

export interface WorkerMessage {
  type: WorkerMessageType
  payload?: unknown
}

export interface InitMessage extends WorkerMessage {
  type: 'init'
}

export interface GenerateMessage extends WorkerMessage {
  type: 'generate'
  payload: {
    images: ImageBitmap[]
    config: GenerationConfig
  }
}

export interface CancelMessage extends WorkerMessage {
  type: 'cancel'
}

export interface ProgressMessage extends WorkerMessage {
  type: 'progress'
  payload: GenerationProgress
}

export interface CompleteMessage extends WorkerMessage {
  type: 'complete'
  payload: {
    positions: Float32Array
    scales: Float32Array
    rotations: Float32Array
    colors: Float32Array
    opacities: Float32Array
  }
}

export interface ErrorMessage extends WorkerMessage {
  type: 'error'
  payload: {
    message: string
    stage: string
  }
}

export interface ReadyMessage extends WorkerMessage {
  type: 'ready'
  payload: {
    webgpuSupported: boolean
  }
}

/**
 * Scene type for COLMAP optimization
 */
export type SceneType = 'auto' | 'building360' | 'interior' | 'landscape'

export const SceneTypeLabels: Record<SceneType, string> = {
  auto: 'Auto Detect',
  building360: '360° Building/Object',
  interior: 'Interior/Room',
  landscape: 'Landscape/Outdoor'
}

export const SceneTypeDescriptions: Record<SceneType, string> = {
  auto: 'Automatically detect best settings',
  building360: 'Optimized for walking around buildings, statues, vehicles',
  interior: 'Optimized for indoor room scans with wide angles',
  landscape: 'Optimized for outdoor scenes with distant features'
}

/**
 * Depth model size options
 */
export type DepthModelSize = 'small' | 'base' | 'large'

/**
 * Generation configuration
 */
export interface GenerationConfig {
  iterations: number
  resolution: number
  learningRate: number
  initialSplatCount: number
  densifyInterval: number
  densifyThreshold: number
  pruneThreshold: number
  shDegree: number
  // Scene type for COLMAP optimization
  sceneType?: SceneType
  // Cleanup options
  cleanupEnabled?: boolean
  cleanupMinOpacity?: number
  cleanupMaxScalePercentile?: number
  cleanupSorStdDevs?: number
  // AI Enhancement: Depth Anything V2
  depthEstimationEnabled?: boolean
  depthModelSize?: DepthModelSize
  depthFloaterFilterEnabled?: boolean
  depthFloaterThreshold?: number
  // AI Enhancement: Learned Feature Matching (SuperPoint + LightGlue)
  learnedFeaturesEnabled?: boolean
  learnedFeaturesMaxKeypoints?: number
}

export const DefaultConfig: GenerationConfig = {
  iterations: 30000,  // OpenSplat default - more iterations = more splats
  resolution: 512,
  learningRate: 0.0016,
  initialSplatCount: 2000,
  densifyInterval: 200,
  densifyThreshold: 0.0002,
  pruneThreshold: 0.01,
  shDegree: 0,
  // Scene type
  sceneType: 'auto',
  // Cleanup defaults
  cleanupEnabled: true,
  cleanupMinOpacity: 0.05,
  cleanupMaxScalePercentile: 99,
  cleanupSorStdDevs: 3.0,
  // AI Enhancement defaults (disabled by default, requires Python setup)
  depthEstimationEnabled: false,
  depthModelSize: 'small',
  depthFloaterFilterEnabled: true,
  depthFloaterThreshold: 0.15,
  // Learned features defaults
  learnedFeaturesEnabled: false,
  learnedFeaturesMaxKeypoints: 2048
}

/**
 * Generation progress state
 */
export interface GenerationProgress {
  stage: GenerationStage
  currentIteration: number
  totalIterations: number
  loss: number
  splatCount: number
  message: string
  percentage: number
}

export type GenerationStage =
  | 'idle'
  | 'initializing'
  | 'preprocessing'
  | 'sfm'
  | 'point_cloud'
  | 'optimizing'
  | 'densifying'
  | 'pruning'
  | 'finalizing'
  | 'complete'
  | 'cancelled'
  | 'error'

/**
 * Camera pose from Structure from Motion
 */
export interface CameraPose {
  position: Float32Array  // vec3
  rotation: Float32Array  // quaternion
  focalLength: number
  width: number
  height: number
}

/**
 * Feature point for matching
 */
export interface FeaturePoint {
  x: number
  y: number
  response: number
  descriptor: Uint8Array
}

/**
 * Point cloud from SfM
 */
export interface PointCloud {
  positions: Float32Array
  colors: Float32Array
  count: number
}
