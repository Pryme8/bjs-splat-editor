/**
 * Gaussian Splat data types
 */

export interface Vector3 {
  x: number
  y: number
  z: number
}

export interface Quaternion {
  x: number
  y: number
  z: number
  w: number
}

export interface Color {
  r: number
  g: number
  b: number
}

/**
 * Individual Gaussian splat data
 */
export interface GaussianSplat {
  position: Vector3
  scale: Vector3
  rotation: Quaternion
  color: Color
  opacity: number
  // Spherical harmonics coefficients (for view-dependent effects)
  sh?: Float32Array
}

/**
 * Splat cloud containing multiple gaussians
 */
export interface SplatCloud {
  splats: GaussianSplat[]
  boundingBox: {
    min: Vector3
    max: Vector3
  }
}

/**
 * Raw splat data as typed arrays (for GPU upload)
 */
export interface SplatBuffers {
  positions: Float32Array    // xyz per splat
  scales: Float32Array       // xyz per splat
  rotations: Float32Array    // xyzw quaternion per splat
  colors: Float32Array       // rgb per splat
  opacities: Float32Array    // single value per splat
  sh?: Float32Array          // spherical harmonics
}

/**
 * PLY file header info
 */
export interface PlyHeader {
  format: 'ascii' | 'binary_little_endian' | 'binary_big_endian'
  vertexCount: number
  properties: PlyProperty[]
  headerLength: number
}

export interface PlyProperty {
  name: string
  type: 'float' | 'double' | 'uchar' | 'int' | 'uint'
  size: number
}

/**
 * Transform operation for editing
 */
export interface SplatTransform {
  position?: Vector3
  rotation?: Quaternion
  scale?: Vector3
  opacity?: number
}

/**
 * Selection state
 */
export interface SplatSelection {
  cloudId: string
  indices: number[]
}
