/**
 * Generator types for WebGPU-based splat generation
 */

/**
 * Generation configuration
 */
export interface GenerationConfig {
  iterations: number
  resolution: number
  learningRate: number
  densifyInterval: number
  pruneThreshold: number
}

/**
 * Default generation settings
 */
export const DefaultGenerationConfig: GenerationConfig = {
  iterations: 7000,
  resolution: 512,
  learningRate: 0.0001,
  densifyInterval: 100,
  pruneThreshold: 0.01
}

/**
 * Input image with camera pose (if known)
 */
export interface InputImage {
  id: string
  file: File
  url: string
  width: number
  height: number
  cameraPose?: CameraPose
}

/**
 * Camera pose from SfM
 */
export interface CameraPose {
  position: { x: number; y: number; z: number }
  rotation: { x: number; y: number; z: number; w: number }
  focalLength: number
  principalPoint: { x: number; y: number }
}

/**
 * Generation progress state
 */
export interface GenerationProgress {
  stage: 'idle' | 'preprocessing' | 'sfm' | 'initializing' | 'optimizing' | 'finalizing' | 'complete' | 'error'
  currentIteration: number
  totalIterations: number
  loss: number
  splatCount: number
  message: string
}

/**
 * Feature point for SfM
 */
export interface FeaturePoint {
  x: number
  y: number
  descriptor: Float32Array
}

/**
 * Feature match between two images
 */
export interface FeatureMatch {
  imageId1: string
  imageId2: string
  point1: FeaturePoint
  point2: FeaturePoint
  confidence: number
}

/**
 * WebGPU buffer allocations
 */
export interface GPUBuffers {
  positions: GPUBuffer
  scales: GPUBuffer
  rotations: GPUBuffer
  colors: GPUBuffer
  opacities: GPUBuffer
  gradients: GPUBuffer
}
