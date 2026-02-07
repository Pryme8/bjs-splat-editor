/**
 * View Cube Composable - Blender-style camera orientation gizmo
 * 
 * Renders axis indicators in the top-left corner of the viewport.
 * Click an axis tip to snap the camera to that view direction.
 * Click the center sphere to flip the camera 180 degrees.
 */

import {
  Scene,
  Engine,
  Vector3,
  MeshBuilder,
  StandardMaterial,
  Color3,
  Quaternion,
  Matrix,
  TransformNode,
  PointerEventTypes,
  ArcRotateCamera,
  UniversalCamera
} from '@babylonjs/core'
import type { Mesh } from '@babylonjs/core/Meshes/mesh'
import type { Observer } from '@babylonjs/core/Misc/observable'
import type { PointerInfo } from '@babylonjs/core/Events/pointerEvents'

// ============================================
// Constants
// ============================================

const SHAFT_LENGTH = 0.38
const SHAFT_DIAMETER = 0.028
const TIP_DIAMETER = 0.1
const NEG_TIP_DIAMETER = 0.065
const CENTER_DIAMETER = 0.08
const SCREEN_OFFSET_X = 60   // px from left
const SCREEN_OFFSET_Y = 60   // px from top
const GIZMO_DEPTH = 4        // fixed distance in front of camera
const ANIM_DURATION_MS = 300

// Axis colors
const COLORS = {
  xPos: new Color3(0.9, 0.2, 0.2),
  xNeg: new Color3(0.45, 0.12, 0.12),
  yPos: new Color3(0.35, 0.8, 0.2),
  yNeg: new Color3(0.18, 0.4, 0.12),
  zPos: new Color3(0.2, 0.4, 0.95),
  zNeg: new Color3(0.12, 0.2, 0.5),
  center: new Color3(0.45, 0.45, 0.5),
  centerHover: new Color3(0.65, 0.65, 0.7),
  xShaft: new Color3(0.75, 0.18, 0.18),
  yShaft: new Color3(0.28, 0.65, 0.18),
  zShaft: new Color3(0.18, 0.35, 0.8)
}

// Snap directions: axis name -> camera position direction (unit vector FROM origin toward camera)
const SNAP_DIRECTIONS: Record<string, Vector3> = {
  '+x': new Vector3(1, 0, 0),
  '-x': new Vector3(-1, 0, 0),
  '+y': new Vector3(0, 1, 0),
  '-y': new Vector3(0, -1, 0),
  '+z': new Vector3(0, 0, 1),
  '-z': new Vector3(0, 0, -1)
}

// ============================================
// Module State
// ============================================

let rootNode: TransformNode | null = null
let gizmoMeshes: Mesh[] = []
let gizmoMeshSet: Set<Mesh> = new Set()
let meshAxisMap: Map<Mesh, string> = new Map()   // mesh -> axis key ('+x', '-x', 'center', etc.)
let pointerObserver: Observer<PointerInfo> | null = null
let beforeRenderObserver: any = null
let sceneRef: Scene | null = null
let engineRef: Engine | null = null
let isVisible = true

// Animation state
let animating = false
let animStartTime = 0
let animStartAlpha = 0
let animStartBeta = 0
let animTargetAlpha = 0
let animTargetBeta = 0
let animStartPos: Vector3 | null = null
let animTargetPos: Vector3 | null = null
let animStartQuat: Quaternion | null = null
let animTargetQuat: Quaternion | null = null
let animCameraType: 'orbit' | 'fly' = 'orbit'

// Hover state
let hoveredMesh: Mesh | null = null
let hoveredOriginalColor: Color3 | null = null

// ============================================
// Material Creation
// ============================================

function createGizmoMaterial(name: string, color: Color3, scene: Scene): StandardMaterial {
  const mat = new StandardMaterial(name, scene)
  mat.emissiveColor = color
  mat.disableDepthWrite = true
  mat.disableLighting = true
  // Render always on top
  mat.depthFunction = Engine.ALWAYS
  return mat
}

// ============================================
// Public API
// ============================================

/**
 * Initialize the view cube gizmo.
 * Creates meshes, registers per-frame update and pointer handling.
 */
export function initViewCube(scene: Scene, engine: Engine): void {
  sceneRef = scene
  engineRef = engine

  // Enable rendering group 3
  scene.setRenderingAutoClearDepthStencil(3, false)

  // Root transform node -- all gizmo meshes are children
  rootNode = new TransformNode('viewCubeRoot', scene)

  // ------------------------------------------
  // Create axis shafts (cylinders)
  // ------------------------------------------
  const shaftConfigs: { name: string; axis: string; dir: Vector3; color: Color3 }[] = [
    { name: 'vcShaftX', axis: 'x', dir: Vector3.Right(), color: COLORS.xShaft },
    { name: 'vcShaftY', axis: 'y', dir: Vector3.Up(), color: COLORS.yShaft },
    { name: 'vcShaftZ', axis: 'z', dir: Vector3.Forward(), color: COLORS.zShaft }
  ]

  for (const cfg of shaftConfigs) {
    const shaft = MeshBuilder.CreateCylinder(cfg.name, {
      height: SHAFT_LENGTH,
      diameter: SHAFT_DIAMETER,
      tessellation: 8
    }, scene)

    // Position shaft so it extends from center outward in the positive direction
    // Cylinders are created along Y axis, we need to rotate + offset
    const halfLen = SHAFT_LENGTH * 0.5

    if (cfg.axis === 'x') {
      shaft.rotation.z = -Math.PI * 0.5
      shaft.position.x = halfLen
    } else if (cfg.axis === 'y') {
      // Already along Y
      shaft.position.y = halfLen
    } else {
      shaft.rotation.x = Math.PI * 0.5
      shaft.position.z = halfLen
    }

    shaft.material = createGizmoMaterial(cfg.name + 'Mat', cfg.color, scene)
    shaft.renderingGroupId = 3
    shaft.parent = rootNode
    shaft.isPickable = true

    gizmoMeshes.push(shaft)
    gizmoMeshSet.add(shaft)
    meshAxisMap.set(shaft, '+' + cfg.axis)
  }

  // ------------------------------------------
  // Create axis tip spheres (positive + negative)
  // ------------------------------------------
  const tipConfigs: { name: string; key: string; pos: Vector3; color: Color3; diameter: number }[] = [
    { name: 'vcTipPosX', key: '+x', pos: new Vector3(SHAFT_LENGTH, 0, 0), color: COLORS.xPos, diameter: TIP_DIAMETER },
    { name: 'vcTipNegX', key: '-x', pos: new Vector3(-SHAFT_LENGTH * 0.35, 0, 0), color: COLORS.xNeg, diameter: NEG_TIP_DIAMETER },
    { name: 'vcTipPosY', key: '+y', pos: new Vector3(0, SHAFT_LENGTH, 0), color: COLORS.yPos, diameter: TIP_DIAMETER },
    { name: 'vcTipNegY', key: '-y', pos: new Vector3(0, -SHAFT_LENGTH * 0.35, 0), color: COLORS.yNeg, diameter: NEG_TIP_DIAMETER },
    { name: 'vcTipPosZ', key: '+z', pos: new Vector3(0, 0, SHAFT_LENGTH), color: COLORS.zPos, diameter: TIP_DIAMETER },
    { name: 'vcTipNegZ', key: '-z', pos: new Vector3(0, 0, -SHAFT_LENGTH * 0.35), color: COLORS.zNeg, diameter: NEG_TIP_DIAMETER }
  ]

  for (const cfg of tipConfigs) {
    const tip = MeshBuilder.CreateSphere(cfg.name, {
      diameter: cfg.diameter,
      segments: 10
    }, scene)

    tip.position.copyFrom(cfg.pos)
    tip.material = createGizmoMaterial(cfg.name + 'Mat', cfg.color, scene)
    tip.renderingGroupId = 3
    tip.parent = rootNode
    tip.isPickable = true

    gizmoMeshes.push(tip)
    gizmoMeshSet.add(tip)
    meshAxisMap.set(tip, cfg.key)
  }

  // ------------------------------------------
  // Center sphere
  // ------------------------------------------
  const center = MeshBuilder.CreateSphere('vcCenter', {
    diameter: CENTER_DIAMETER,
    segments: 10
  }, scene)
  center.material = createGizmoMaterial('vcCenterMat', COLORS.center, scene)
  center.renderingGroupId = 3
  center.parent = rootNode
  center.isPickable = true
  gizmoMeshes.push(center)
  gizmoMeshSet.add(center)
  meshAxisMap.set(center, 'center')

  // ------------------------------------------
  // Per-frame update
  // ------------------------------------------
  beforeRenderObserver = scene.onBeforeRenderObservable.add(() => {
    updateGizmoTransform()
  })

  // ------------------------------------------
  // Pointer handling
  // ------------------------------------------
  setupPointerObservable()

  console.log('[ViewCube] Initialized')
}

/**
 * Dispose all view cube resources
 */
export function disposeViewCube(): void {
  if (sceneRef && pointerObserver) {
    sceneRef.onPointerObservable.remove(pointerObserver)
    pointerObserver = null
  }

  if (sceneRef && beforeRenderObserver) {
    sceneRef.onBeforeRenderObservable.remove(beforeRenderObserver)
    beforeRenderObserver = null
  }

  for (const mesh of gizmoMeshes) {
    mesh.material?.dispose()
    mesh.dispose()
  }
  gizmoMeshes = []
  gizmoMeshSet.clear()
  meshAxisMap.clear()

  if (rootNode) {
    rootNode.dispose()
    rootNode = null
  }

  hoveredMesh = null
  hoveredOriginalColor = null
  animating = false
  sceneRef = null
  engineRef = null

  console.log('[ViewCube] Disposed')
}

/**
 * Toggle view cube visibility
 */
export function setViewCubeVisible(visible: boolean): void {
  isVisible = visible
  if (rootNode) {
    rootNode.setEnabled(visible)
  }
}

// ============================================
// Per-Frame Transform Update
// ============================================

function updateGizmoTransform(): void {
  if (!rootNode || !sceneRef || !engineRef || !isVisible) return

  const camera = sceneRef.activeCamera
  if (!camera) return

  // Tick animation if active
  if (animating) {
    tickAnimation()
  }

  // ------------------------------------------
  // Position: project screen pixel to world
  // ------------------------------------------
  const sw = engineRef.getRenderWidth()
  const sh = engineRef.getRenderHeight()

  // Screen point in top-left corner
  const screenX = SCREEN_OFFSET_X
  const screenY = SCREEN_OFFSET_Y

  // Unproject at a fixed depth from near plane to get a stable world position
  // We pick a point at a fixed distance along the camera's forward direction
  const viewMatrix = camera.getViewMatrix()
  const projMatrix = camera.getProjectionMatrix()
  const vpMatrix = viewMatrix.multiply(projMatrix)
  const invVP = Matrix.Invert(vpMatrix)

  // Convert screen coords to NDC (-1..1)
  const ndcX = (screenX / sw) * 2 - 1
  const ndcY = 1 - (screenY / sh) * 2
  const ndcNear = 0

  // Unproject to world
  const worldPos = Vector3.TransformCoordinates(
    new Vector3(ndcX, ndcY, ndcNear),
    invVP
  )

  // Direction from camera to that point
  const camPos = camera.globalPosition
  const dir = worldPos.subtract(camPos).normalize()

  // Place gizmo at fixed depth along that direction
  const gizmoWorldPos = camPos.add(dir.scale(GIZMO_DEPTH))
  rootNode.position.copyFrom(gizmoWorldPos)

  // ------------------------------------------
  // Scale: maintain constant pixel size
  // ------------------------------------------
  // At depth GIZMO_DEPTH the apparent size depends on FOV
  // We use a fixed scale that looks good at depth 4
  const fov = (camera as any).fov || 0.8
  const scale = GIZMO_DEPTH * Math.tan(fov * 0.5) * 0.12
  rootNode.scaling.setAll(scale)

  // ------------------------------------------
  // Rotation: none needed!
  // The gizmo meshes are defined in world-axis directions.
  // The camera naturally shows them from its current viewpoint,
  // so the gizmo correctly reflects camera orientation without
  // any additional rotation on the root node.
  // ------------------------------------------
  rootNode.rotationQuaternion = null
}

// ============================================
// Pointer Handling
// ============================================

function setupPointerObservable(): void {
  if (!sceneRef) return

  pointerObserver = sceneRef.onPointerObservable.add((pointerInfo: PointerInfo) => {
    if (!isVisible || animating) return

    switch (pointerInfo.type) {
      case PointerEventTypes.POINTERMOVE:
        handlePointerMove(pointerInfo)
        break
      case PointerEventTypes.POINTERDOWN:
        handlePointerDown(pointerInfo)
        break
    }
  })
}

function handlePointerMove(pointerInfo: PointerInfo): void {
  if (!sceneRef) return

  const evt = pointerInfo.event as PointerEvent
  const pickResult = sceneRef.pick(evt.offsetX, evt.offsetY, (mesh) => gizmoMeshSet.has(mesh as Mesh))

  if (pickResult?.hit && pickResult.pickedMesh && gizmoMeshSet.has(pickResult.pickedMesh as Mesh)) {
    const mesh = pickResult.pickedMesh as Mesh
    if (mesh !== hoveredMesh) {
      // Restore previous hover
      clearHover()
      // Apply hover highlight
      hoveredMesh = mesh
      const mat = mesh.material as StandardMaterial
      if (mat) {
        hoveredOriginalColor = mat.emissiveColor.clone()
        // Brighten by 30%
        mat.emissiveColor = new Color3(
          Math.min(hoveredOriginalColor.r * 1.4 + 0.15, 1),
          Math.min(hoveredOriginalColor.g * 1.4 + 0.15, 1),
          Math.min(hoveredOriginalColor.b * 1.4 + 0.15, 1)
        )
      }
    }
  } else {
    clearHover()
  }
}

function clearHover(): void {
  if (hoveredMesh && hoveredOriginalColor) {
    const mat = hoveredMesh.material as StandardMaterial
    if (mat) {
      mat.emissiveColor = hoveredOriginalColor
    }
  }
  hoveredMesh = null
  hoveredOriginalColor = null
}

function handlePointerDown(pointerInfo: PointerInfo): void {
  if (!sceneRef) return

  const evt = pointerInfo.event as PointerEvent
  // Only respond to left click
  if (evt.button !== 0) return

  const pickResult = sceneRef.pick(evt.offsetX, evt.offsetY, (mesh) => gizmoMeshSet.has(mesh as Mesh))

  if (pickResult?.hit && pickResult.pickedMesh && gizmoMeshSet.has(pickResult.pickedMesh as Mesh)) {
    const mesh = pickResult.pickedMesh as Mesh
    const axisKey = meshAxisMap.get(mesh)
    if (!axisKey) return

    // Prevent the event from propagating to camera controls
    evt.preventDefault()

    if (axisKey === 'center') {
      flipCamera()
    } else {
      snapToAxis(axisKey)
    }
  }
}

// ============================================
// Camera Snap & Flip
// ============================================

function getDistanceFromOrigin(): number {
  if (!sceneRef || !sceneRef.activeCamera) return 10

  const camera = sceneRef.activeCamera
  if (camera instanceof ArcRotateCamera) {
    return camera.radius
  }
  return Vector3.Distance(camera.globalPosition, Vector3.Zero())
}

function snapToAxis(axisKey: string): void {
  if (!sceneRef || animating) return

  const direction = SNAP_DIRECTIONS[axisKey]
  if (!direction) return

  const distance = getDistanceFromOrigin()
  const camera = sceneRef.activeCamera

  if (camera instanceof ArcRotateCamera) {
    startOrbitAnimation(direction, distance)
  } else if (camera instanceof UniversalCamera) {
    startFlyAnimation(direction, distance)
  }
}

function flipCamera(): void {
  if (!sceneRef || animating) return

  const camera = sceneRef.activeCamera
  if (!camera) return

  const distance = getDistanceFromOrigin()

  if (camera instanceof ArcRotateCamera) {
    // Flip: rotate alpha by PI and mirror beta
    const currentAlpha = camera.alpha
    const currentBeta = camera.beta

    animating = true
    animCameraType = 'orbit'
    animStartTime = performance.now()
    animStartAlpha = currentAlpha
    animStartBeta = currentBeta
    animTargetAlpha = currentAlpha + Math.PI
    animTargetBeta = Math.PI - currentBeta
  } else if (camera instanceof UniversalCamera) {
    // Flip fly camera: move to opposite side of origin
    const camPos = camera.globalPosition.clone()
    const dir = camPos.normalize()
    const targetPos = dir.scale(-distance)

    // Compute target quaternion looking back at origin
    const targetQuat = computeLookAtQuaternion(targetPos, Vector3.Zero())

    animating = true
    animCameraType = 'fly'
    animStartTime = performance.now()
    animStartPos = camera.position.clone()
    animTargetPos = targetPos
    animStartQuat = camera.rotationQuaternion ? camera.rotationQuaternion.clone() : Quaternion.Identity()
    animTargetQuat = targetQuat
  }
}

// ============================================
// Orbit Camera Snap Helpers
// ============================================

function startOrbitAnimation(direction: Vector3, distance: number): void {
  if (!sceneRef) return
  const camera = sceneRef.activeCamera
  if (!(camera instanceof ArcRotateCamera)) return

  // Compute target alpha/beta from direction vector
  // direction = camera position direction (from origin toward camera)
  // In ArcRotateCamera: alpha=0 is +X axis, increases CCW toward +Z when viewed from +Y
  const targetAlpha = Math.atan2(direction.z, direction.x)
  let targetBeta = Math.acos(Math.max(-1, Math.min(1, direction.y)))

  // Handle pure up/down (avoid gimbal lock at exact poles)
  if (Math.abs(direction.y) > 0.99) {
    targetBeta = direction.y > 0 ? 0.01 : Math.PI - 0.01
  }

  animating = true
  animCameraType = 'orbit'
  animStartTime = performance.now()
  animStartAlpha = camera.alpha
  animStartBeta = camera.beta

  // Normalize alpha difference to shortest path
  let da = targetAlpha - camera.alpha
  // Wrap to [-PI, PI]
  da = da - Math.round(da / (2 * Math.PI)) * 2 * Math.PI
  animTargetAlpha = camera.alpha + da
  animTargetBeta = targetBeta
}

function startFlyAnimation(direction: Vector3, distance: number): void {
  if (!sceneRef) return
  const camera = sceneRef.activeCamera
  if (!(camera instanceof UniversalCamera)) return

  const targetPos = direction.scale(distance)
  const targetQuat = computeLookAtQuaternion(targetPos, Vector3.Zero())

  animating = true
  animCameraType = 'fly'
  animStartTime = performance.now()
  animStartPos = camera.position.clone()
  animTargetPos = targetPos
  animStartQuat = camera.rotationQuaternion ? camera.rotationQuaternion.clone() : Quaternion.Identity()
  animTargetQuat = targetQuat
}

// ============================================
// Animation Tick
// ============================================

function tickAnimation(): void {
  if (!sceneRef || !animating) return

  const elapsed = performance.now() - animStartTime
  let t = Math.min(elapsed / ANIM_DURATION_MS, 1)

  // Ease out cubic
  t = 1 - Math.pow(1 - t, 3)

  if (animCameraType === 'orbit') {
    const camera = sceneRef.activeCamera
    if (camera instanceof ArcRotateCamera) {
      camera.alpha = animStartAlpha + (animTargetAlpha - animStartAlpha) * t
      camera.beta = animStartBeta + (animTargetBeta - animStartBeta) * t
    }
  } else if (animCameraType === 'fly') {
    const camera = sceneRef.activeCamera
    if (camera instanceof UniversalCamera && animStartPos && animTargetPos && animStartQuat && animTargetQuat) {
      Vector3.LerpToRef(animStartPos, animTargetPos, t, camera.position)
      Quaternion.SlerpToRef(animStartQuat, animTargetQuat, t, camera.rotationQuaternion!)
    }
  }

  if (t >= 1) {
    animating = false
    animStartPos = null
    animTargetPos = null
    animStartQuat = null
    animTargetQuat = null
  }
}

// ============================================
// Utility
// ============================================

/**
 * Compute a quaternion that makes the camera look from `eye` toward `target`
 * with world up = Y.
 */
function computeLookAtQuaternion(eye: Vector3, target: Vector3): Quaternion {
  const lookMatrix = Matrix.LookAtLH(eye, target, Vector3.Up())
  // LookAtLH gives view matrix (world->camera). We need camera rotation in world space.
  const invLook = Matrix.Invert(lookMatrix)
  return Quaternion.FromRotationMatrix(invLook)
}
