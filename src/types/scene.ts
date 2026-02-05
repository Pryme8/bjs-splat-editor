/**
 * Scene and object types
 */

import type { SplatCloud, SplatTransform } from './splat'

/**
 * Scene object representing a loaded splat cloud
 */
export interface SceneObject {
  id: string
  name: string
  visible: boolean
  locked: boolean
  cloud: SplatCloud
  transform: SplatTransform
}

/**
 * Camera state for serialization
 */
export interface CameraState {
  alpha: number
  beta: number
  radius: number
  target: {
    x: number
    y: number
    z: number
  }
}

/**
 * Complete scene state for save/load
 */
export interface SceneState {
  version: string
  objects: SceneObject[]
  camera: CameraState
  settings: SceneSettings
}

/**
 * Scene rendering settings
 */
export interface SceneSettings {
  backgroundColor: string
  showGrid: boolean
  showAxes: boolean
  splatSize: number
}

/**
 * Edit action for undo/redo
 */
export interface EditAction {
  type: 'transform' | 'delete' | 'add' | 'modify'
  objectId: string
  splatIndices?: number[]
  before: unknown
  after: unknown
  timestamp: number
}
