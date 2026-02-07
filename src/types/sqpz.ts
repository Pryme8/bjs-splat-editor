/**
 * SQPZ (Splat Quartz Packaged Zip) File Format Types
 * A gzip-compressed container format for saving/loading splat workspaces
 */

/**
 * Vector3 position/scale representation
 */
export interface Vector3Data {
  x: number
  y: number
  z: number
}

/**
 * Individual splat file within the workspace
 */
export interface SqpzSplat {
  name: string          // Original filename (e.g., "bike.ply", "floor.splat")
  data: string          // Base64 encoded binary blob of the splat file
  type: 'ply' | 'splat' | 'spz'  // File type
  wasFlipped: boolean   // Whether this splat was Y-flipped during editing
}

/**
 * Transform data for each splat (same order as splats array)
 */
export interface SqpzTransform {
  position: Vector3Data
  rotation: Vector3Data  // Euler angles in radians
  scale: Vector3Data
}

/**
 * Camera waypoint for viewer navigation
 */
export interface SqpzWaypoint {
  name: string           // User-friendly name (e.g., "Front View")
  alpha: number          // ArcRotateCamera alpha (rotation around Y axis)
  beta: number           // ArcRotateCamera beta (vertical rotation)
  radius: number         // Distance from target
  target: Vector3Data    // Camera look-at target
}

/**
 * Project metadata
 */
export interface SqpzMetadata {
  projectName: string
  created: string        // ISO timestamp
  modified: string       // ISO timestamp
  appVersion: string     // Version of the editor that created this file
  camera: {
    alpha: number
    beta: number
    radius: number
    target: Vector3Data
  }
  scene: {
    backgroundColor: string
    showGrid: boolean
    showAxes: boolean
  }
}

/**
 * Editor-specific data (only included in development exports)
 * Only includes state that makes sense to preserve between sessions
 */
export interface SqpzEditorData {
  clipSphere?: {
    enabled: boolean
    center: Vector3Data
    radius: number
  }
  clipBox?: {
    enabled: boolean
    center: Vector3Data
    size: Vector3Data
  }
  activeObjectId?: string | null
}

/**
 * Complete SQPZ file structure
 */
export interface SqpzFile {
  version: string
  splats: SqpzSplat[]
  transforms: SqpzTransform[]
  waypoints: SqpzWaypoint[]
  metadata: SqpzMetadata
  editorData?: SqpzEditorData  // Optional, only in development mode
}

/**
 * Export options
 */
export interface SqpzExportOptions {
  developmentMode: boolean  // Include editor data for re-editing
  projectName?: string
}

/**
 * Import result
 */
export interface SqpzImportResult {
  file: SqpzFile
  isDevelopmentFile: boolean  // Whether editorData is present
}
