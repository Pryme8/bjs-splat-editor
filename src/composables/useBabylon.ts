import { ref, watch } from 'vue'
import { 
  Engine, 
  Scene, 
  UniversalCamera,
  ArcRotateCamera,
  Vector3, 
  HemisphericLight, 
  Color4,
  MeshBuilder,
  StandardMaterial,
  Color3,
  Quaternion,
  Texture,
  Mesh,
  VertexData,
  KeyboardEventTypes
} from '@babylonjs/core'
import { LinesMesh } from '@babylonjs/core/Meshes/linesMesh'
import { GaussianSplattingMesh } from '@babylonjs/core/Meshes/GaussianSplatting/gaussianSplattingMesh'
import { AxesViewer } from '@babylonjs/core/Debug/axesViewer'
import { RotationGizmo } from '@babylonjs/core/Gizmos/rotationGizmo'
import { PositionGizmo } from '@babylonjs/core/Gizmos/positionGizmo'
import { ScaleGizmo } from '@babylonjs/core/Gizmos/scaleGizmo'
import { UtilityLayerRenderer } from '@babylonjs/core/Rendering/utilityLayerRenderer'
import { useAppStore } from '@/stores/appStore'
import { useSceneStore } from '@/stores/sceneStore'
import { useEditorStore, type GizmoType, type Transform } from '@/stores/editorStore'
import type { ColmapPreviewData, CameraPreview, Point3D } from '@/services/BackendApi'

let engine: Engine | null = null
let scene: Scene | null = null
let flyCamera: UniversalCamera | null = null
let orbitCamera: ArcRotateCamera | null = null
let activeCamera: UniversalCamera | ArcRotateCamera | null = null
let currentSplat: GaussianSplattingMesh | null = null
let debugMesh: any = null

// COLMAP preview meshes
let colmapPreviewMeshes: Mesh[] = []
let colmapPointCloud: Mesh | null = null

// Editor helpers
let axesViewer: AxesViewer | null = null
let groundPlaneMesh: LinesMesh | null = null
let utilityLayer: UtilityLayerRenderer | null = null
let rotationGizmo: RotationGizmo | null = null
let positionGizmo: PositionGizmo | null = null
let scaleGizmo: ScaleGizmo | null = null

// Transform snapshot for undo/redo (captured on drag start)
let transformBeforeDrag: Transform | null = null

// Clipping sphere
let clipSphereMesh: LinesMesh | null = null
let clipSphereGizmo: PositionGizmo | null = null

// Clipping box
let clipBoxMesh: LinesMesh | null = null
let clipBoxGizmo: PositionGizmo | null = null

let originalFileBlob: Blob | null = null
let originalFileName: string | null = null

// Custom camera control state - velocity-based for smooth impulse movement
const cameraVelocity = {
  forward: 0,    // W/S
  right: 0,      // A/D
  up: 0,         // R/F
  rollVel: 0,    // Q/E
}

// Track which keys are currently pressed
const keysPressed = {
  forward: false,
  backward: false,
  left: false,
  right: false,
  rollLeft: false,
  rollRight: false,
  moveUp: false,
  moveDown: false,
}

export function useBabylon() {
  const isReady = ref(false)
  const appStore = useAppStore()
  const sceneStore = useSceneStore()
  const editorStore = useEditorStore()

  function initScene(canvas: HTMLCanvasElement) {
    // Create engine with performance options
    engine = new Engine(canvas, true, {
      preserveDrawingBuffer: false,  // Better performance
      stencil: false,
      antialias: false,  // Disable for splat rendering (not needed)
      powerPreference: 'high-performance'
    })

    // Create scene with optimizations
    scene = new Scene(engine)
    scene.clearColor = new Color4(0.051, 0.051, 0.071, 1) // #0D0D12
    
    // Performance optimizations
    scene.skipPointerMovePicking = true
    scene.autoClear = true
    scene.autoClearDepthAndStencil = true

    // ============================================
    // ORBIT CAMERA (default)
    // ============================================
    orbitCamera = new ArcRotateCamera(
      'orbitCamera',
      -Math.PI * 0.5,  // alpha (horizontal rotation)
      Math.PI * 0.4,   // beta (vertical rotation)
      10,              // radius (distance from target)
      Vector3.Zero(),  // target
      scene
    )
    orbitCamera.minZ = 0.01
    orbitCamera.maxZ = 500
    orbitCamera.wheelPrecision = 50
    orbitCamera.panningSensibility = 500
    orbitCamera.lowerRadiusLimit = 0.5
    orbitCamera.upperRadiusLimit = 200
    orbitCamera.attachControl(canvas, true)
    
    // ============================================
    // FLY CAMERA (6DOF drone mode)
    // ============================================
    flyCamera = new UniversalCamera(
      'flyCamera',
      new Vector3(0, 0, -10),
      scene
    )
    flyCamera.setTarget(Vector3.Zero())
    flyCamera.minZ = 0.01
    flyCamera.maxZ = 500
    
    // Disable ALL built-in controls - we handle everything ourselves
    flyCamera.keysUp = []
    flyCamera.keysDown = []
    flyCamera.keysLeft = []
    flyCamera.keysRight = []
    flyCamera.inputs.clear()  // Remove all default inputs including mouse
    
    // Use quaternion for rotation to properly handle 6DOF
    flyCamera.rotationQuaternion = Quaternion.FromEulerAngles(
      flyCamera.rotation.x,
      flyCamera.rotation.y, 
      flyCamera.rotation.z
    )
    
    // Set active camera based on store
    activeCamera = editorStore.cameraMode === 'orbit' ? orbitCamera : flyCamera
    scene.activeCamera = activeCamera
    
    // Movement physics - impulse-based with damping
    const acceleration = 0.004
    const maxSpeed = 0.075
    const damping = 0.85
    const rollAccel = 0.0015
    const maxRollSpeed = 0.01
    const rollDamping = 0.85
    const mouseSensitivity = 0.002
    
    // Mouse look state for fly camera
    let isMouseDown = false
    let lastMouseX = 0
    let lastMouseY = 0
    
    // Mouse down - start looking (fly camera only)
    canvas.addEventListener('pointerdown', (e) => {
      if (editorStore.cameraMode !== 'fly') return
      isMouseDown = true
      lastMouseX = e.clientX
      lastMouseY = e.clientY
      canvas.setPointerCapture(e.pointerId)
    })
    
    // Mouse up - stop looking
    canvas.addEventListener('pointerup', (e) => {
      if (editorStore.cameraMode !== 'fly') return
      isMouseDown = false
      canvas.releasePointerCapture(e.pointerId)
    })
    
    // Mouse move - apply rotation around LOCAL axes (fly camera only)
    canvas.addEventListener('pointermove', (e) => {
      if (editorStore.cameraMode !== 'fly' || !isMouseDown || !flyCamera || !flyCamera.rotationQuaternion) return
      
      const deltaX = e.clientX - lastMouseX
      const deltaY = e.clientY - lastMouseY
      lastMouseX = e.clientX
      lastMouseY = e.clientY
      
      // Create rotation quaternions around LOCAL axes
      const yawRotation = Quaternion.RotationAxis(
        Vector3.Up().rotateByQuaternionToRef(flyCamera.rotationQuaternion, new Vector3()),
        deltaX * mouseSensitivity
      )
      
      const pitchRotation = Quaternion.RotationAxis(
        Vector3.Right().rotateByQuaternionToRef(flyCamera.rotationQuaternion, new Vector3()),
        deltaY * mouseSensitivity
      )
      
      flyCamera.rotationQuaternion = yawRotation.multiply(flyCamera.rotationQuaternion)
      flyCamera.rotationQuaternion = pitchRotation.multiply(flyCamera.rotationQuaternion)
    })
    
    // Track all keys for custom movement (fly camera only)
    scene.onKeyboardObservable.add((kbInfo) => {
      if (editorStore.cameraMode !== 'fly') return
      
      const key = kbInfo.event.key.toLowerCase()
      const isDown = kbInfo.type === KeyboardEventTypes.KEYDOWN
      
      switch (key) {
        case 'w':
          keysPressed.forward = isDown
          break
        case 's':
          keysPressed.backward = isDown
          break
        case 'a':
          keysPressed.left = isDown
          break
        case 'd':
          keysPressed.right = isDown
          break
        case 'q':
          keysPressed.rollLeft = isDown
          break
        case 'e':
          keysPressed.rollRight = isDown
          break
        case 'r':
          keysPressed.moveUp = isDown
          break
        case 'f':
          keysPressed.moveDown = isDown
          break
      }
    })
    
    // Apply velocity-based movement each frame (fly camera only)
    scene.onBeforeRenderObservable.add(() => {
      if (editorStore.cameraMode !== 'fly' || !flyCamera || !flyCamera.rotationQuaternion) return
      
      const forward = Vector3.Forward().rotateByQuaternionToRef(flyCamera.rotationQuaternion, new Vector3())
      const right = Vector3.Right().rotateByQuaternionToRef(flyCamera.rotationQuaternion, new Vector3())
      const up = Vector3.Up().rotateByQuaternionToRef(flyCamera.rotationQuaternion, new Vector3())
      
      if (keysPressed.forward) {
        cameraVelocity.forward = Math.min(cameraVelocity.forward + acceleration, maxSpeed)
      } else if (keysPressed.backward) {
        cameraVelocity.forward = Math.max(cameraVelocity.forward - acceleration, -maxSpeed)
      }
      
      if (keysPressed.right) {
        cameraVelocity.right = Math.min(cameraVelocity.right + acceleration, maxSpeed)
      } else if (keysPressed.left) {
        cameraVelocity.right = Math.max(cameraVelocity.right - acceleration, -maxSpeed)
      }
      
      if (keysPressed.moveUp) {
        cameraVelocity.up = Math.min(cameraVelocity.up + acceleration, maxSpeed)
      } else if (keysPressed.moveDown) {
        cameraVelocity.up = Math.max(cameraVelocity.up - acceleration, -maxSpeed)
      }
      
      if (keysPressed.rollLeft) {
        cameraVelocity.rollVel = Math.min(cameraVelocity.rollVel + rollAccel, maxRollSpeed)
      } else if (keysPressed.rollRight) {
        cameraVelocity.rollVel = Math.max(cameraVelocity.rollVel - rollAccel, -maxRollSpeed)
      }
      
      if (Math.abs(cameraVelocity.forward) > 0.0001) {
        flyCamera.position.addInPlace(forward.scale(cameraVelocity.forward))
      }
      if (Math.abs(cameraVelocity.right) > 0.0001) {
        flyCamera.position.addInPlace(right.scale(cameraVelocity.right))
      }
      if (Math.abs(cameraVelocity.up) > 0.0001) {
        flyCamera.position.addInPlace(up.scale(cameraVelocity.up))
      }
      
      if (Math.abs(cameraVelocity.rollVel) > 0.0001) {
        const rollRotation = Quaternion.RotationAxis(forward, cameraVelocity.rollVel)
        flyCamera.rotationQuaternion = rollRotation.multiply(flyCamera.rotationQuaternion)
      }
      
      if (!keysPressed.forward && !keysPressed.backward) {
        cameraVelocity.forward *= damping
      }
      if (!keysPressed.left && !keysPressed.right) {
        cameraVelocity.right *= damping
      }
      if (!keysPressed.moveUp && !keysPressed.moveDown) {
        cameraVelocity.up *= damping
      }
      if (!keysPressed.rollLeft && !keysPressed.rollRight) {
        cameraVelocity.rollVel *= rollDamping
      }
    })

    // Create light (minimal - splats don't need much lighting)
    const light = new HemisphericLight('light', new Vector3(0, 1, 0), scene)
    light.intensity = 0.8

    // Handle resize with debounce
    let resizeTimeout: number
    const resizeObserver = new ResizeObserver(() => {
      clearTimeout(resizeTimeout)
      resizeTimeout = setTimeout(() => {
        engine?.resize()
      }, 100) as unknown as number
    })
    resizeObserver.observe(canvas)

    // Start render loop
    engine.runRenderLoop(() => {
      scene?.render()
    })

    isReady.value = true
    console.log('[Babylon] Scene initialized with performance optimizations')

    // Watch for file changes
    watch(() => appStore.currentFile, async (file, oldFile) => {
      if (file) {
        // Pass isPreview flag to loadSplat
        await loadSplat(file.url, file.name, file.isPreview)
      } else {
        clearSplat()
      }
    }, { immediate: true })

    // Initialize editor helpers
    initEditorHelpers()

    // Watch editor store for changes
    watch(() => editorStore.showAxes, (show) => {
      setAxesVisible(show)
    }, { immediate: true })

    watch(() => editorStore.showGroundPlane, (show) => {
      setGroundPlaneVisible(show)
    }, { immediate: true })

    watch(() => editorStore.groundPlaneSize, (size) => {
      updateGroundPlaneSize(size)
    })

    watch(() => editorStore.activeGizmo, (gizmoType) => {
      setActiveGizmo(gizmoType)
    })

    watch(() => editorStore.transformSpace, (space) => {
      updateGizmoSpace(space === 'local')
    })

    // Watch camera mode
    watch(() => editorStore.cameraMode, (mode) => {
      switchCameraMode(mode)
    })

    // Watch clipping sphere
    watch(() => editorStore.clipSphere.enabled, (enabled) => {
      setClipSphereVisible(enabled)
    })

    watch(() => editorStore.clipSphere.radius, (radius) => {
      updateClipSphereRadius(radius)
    })

    watch(() => editorStore.clipSphere.center, (center) => {
      updateClipSpherePosition(center.x, center.y, center.z)
    }, { deep: true })

    // Watch clipping box
    watch(() => editorStore.clipBox.enabled, (enabled) => {
      setClipBoxVisible(enabled)
    })

    watch(() => editorStore.clipBox.size, (size) => {
      updateClipBoxSize(size.x, size.y, size.z)
    }, { deep: true })

    watch(() => editorStore.clipBox.center, (center) => {
      updateClipBoxPosition(center.x, center.y, center.z)
    }, { deep: true })
  }

  // ============================================
  // Camera Functions
  // ============================================

  function switchCameraMode(mode: 'fly' | 'orbit') {
    if (!scene || !flyCamera || !orbitCamera) return

    // Reset fly camera velocity when switching away
    if (mode === 'orbit') {
      cameraVelocity.forward = 0
      cameraVelocity.right = 0
      cameraVelocity.up = 0
      cameraVelocity.rollVel = 0
      
      // Reset key states
      keysPressed.forward = false
      keysPressed.backward = false
      keysPressed.left = false
      keysPressed.right = false
      keysPressed.moveUp = false
      keysPressed.moveDown = false
      keysPressed.rollLeft = false
      keysPressed.rollRight = false
    }

    // Detach current camera controls
    if (activeCamera === orbitCamera) {
      orbitCamera.detachControl()
    }

    // Switch active camera
    if (mode === 'orbit') {
      activeCamera = orbitCamera
      orbitCamera.attachControl(scene.getEngine().getRenderingCanvas()!, true)
    } else {
      activeCamera = flyCamera
    }

    scene.activeCamera = activeCamera
    console.log('[Babylon] Camera mode switched to:', mode)
  }

  // ============================================
  // Editor Helper Functions
  // ============================================

  function initEditorHelpers() {
    if (!scene) return

    // Create utility layer for gizmos
    utilityLayer = new UtilityLayerRenderer(scene)

    // Create axes viewer at origin
    createAxesViewer()

    // Create ground plane
    createGroundPlane()

    console.log('[Babylon] Editor helpers initialized')
  }

  function createAxesViewer() {
    if (!scene) return

    // Dispose existing
    if (axesViewer) {
      axesViewer.dispose()
    }

    // Create new axes viewer with length 2
    axesViewer = new AxesViewer(scene, 2)
    console.log('[Babylon] AxesViewer created')
  }

  function setAxesVisible(visible: boolean) {
    if (!axesViewer) return
    
    // AxesViewer doesn't have a visibility property, so we need to access the underlying meshes
    if (axesViewer.xAxis) {
      axesViewer.xAxis.setEnabled(visible)
    }
    if (axesViewer.yAxis) {
      axesViewer.yAxis.setEnabled(visible)
    }
    if (axesViewer.zAxis) {
      axesViewer.zAxis.setEnabled(visible)
    }
    console.log('[Babylon] AxesViewer visibility:', visible)
  }

  function createGroundPlane() {
    if (!scene) return

    // Dispose existing
    if (groundPlaneMesh) {
      groundPlaneMesh.dispose()
    }

    const size = editorStore.groundPlaneSize

    // Create grid using line system for better performance
    const lines: Vector3[][] = []
    const gridLines = 20  // Number of lines in each direction
    const spacing = size / gridLines

    // Create lines along X axis
    for (let i = 0; i <= gridLines; i++) {
      const z = -size * 0.5 + i * spacing
      lines.push([
        new Vector3(-size * 0.5, 0, z),
        new Vector3(size * 0.5, 0, z)
      ])
    }

    // Create lines along Z axis
    for (let i = 0; i <= gridLines; i++) {
      const x = -size * 0.5 + i * spacing
      lines.push([
        new Vector3(x, 0, -size * 0.5),
        new Vector3(x, 0, size * 0.5)
      ])
    }

    groundPlaneMesh = MeshBuilder.CreateLineSystem('groundPlane', { lines }, scene)
    groundPlaneMesh.color = new Color3(0.3, 0.3, 0.4)  // Subtle gray-blue
    groundPlaneMesh.isPickable = false

    console.log('[Babylon] Ground plane created, size:', size)
  }

  function setGroundPlaneVisible(visible: boolean) {
    if (groundPlaneMesh) {
      groundPlaneMesh.setEnabled(visible)
      console.log('[Babylon] Ground plane visibility:', visible)
    }
  }

  function updateGroundPlaneSize(size: number) {
    // Recreate ground plane with new size
    createGroundPlane()
    // Apply current visibility setting
    setGroundPlaneVisible(editorStore.showGroundPlane)
  }

  function setActiveGizmo(gizmoType: GizmoType) {
    if (!utilityLayer || !scene) return

    // Dispose all existing gizmos
    if (rotationGizmo) {
      rotationGizmo.dispose()
      rotationGizmo = null
    }
    if (positionGizmo) {
      positionGizmo.dispose()
      positionGizmo = null
    }
    if (scaleGizmo) {
      scaleGizmo.dispose()
      scaleGizmo = null
    }

    if (gizmoType === 'none' || !currentSplat) {
      console.log('[Babylon] Gizmos cleared')
      return
    }

    // Determine if we should use local space (true) or world space (false)
    const useLocalSpace = editorStore.transformSpace === 'local'

    // Helper to capture transform before drag starts
    const captureTransformBeforeDrag = () => {
      transformBeforeDrag = editorStore.getTransformSnapshot()
    }

    // Helper to sync transform and create undo command
    const syncAndCreateCommand = () => {
      const before = transformBeforeDrag
      syncTransformToStore()
      const after = editorStore.getTransformSnapshot()
      
      // Only create command if transform actually changed
      if (before && (
        before.position.x !== after.position.x ||
        before.position.y !== after.position.y ||
        before.position.z !== after.position.z ||
        before.rotation.x !== after.rotation.x ||
        before.rotation.y !== after.rotation.y ||
        before.rotation.z !== after.rotation.z ||
        before.scale.x !== after.scale.x ||
        before.scale.y !== after.scale.y ||
        before.scale.z !== after.scale.z
      )) {
        editorStore.pushCommand({ type: 'transform', before, after })
      }
      transformBeforeDrag = null
    }

    // Create the appropriate gizmo
    switch (gizmoType) {
      case 'rotate':
        rotationGizmo = new RotationGizmo(utilityLayer)
        rotationGizmo.attachedMesh = currentSplat
        rotationGizmo.updateGizmoRotationToMatchAttachedMesh = useLocalSpace
        rotationGizmo.onDragStartObservable.add(captureTransformBeforeDrag)
        rotationGizmo.onDragEndObservable.add(syncAndCreateCommand)
        console.log('[Babylon] Rotation gizmo attached, local:', useLocalSpace)
        break

      case 'translate':
        positionGizmo = new PositionGizmo(utilityLayer)
        positionGizmo.attachedMesh = currentSplat
        positionGizmo.updateGizmoRotationToMatchAttachedMesh = useLocalSpace
        positionGizmo.onDragStartObservable.add(captureTransformBeforeDrag)
        positionGizmo.onDragEndObservable.add(syncAndCreateCommand)
        console.log('[Babylon] Position gizmo attached, local:', useLocalSpace)
        break

      case 'scale':
        scaleGizmo = new ScaleGizmo(utilityLayer)
        scaleGizmo.attachedMesh = currentSplat
        scaleGizmo.onDragStartObservable.add(captureTransformBeforeDrag)
        scaleGizmo.onDragEndObservable.add(syncAndCreateCommand)
        console.log('[Babylon] Scale gizmo attached')
        break
    }
  }

  function updateGizmoSpace(useLocalSpace: boolean) {
    // Update existing gizmos to use new space
    if (rotationGizmo) {
      rotationGizmo.updateGizmoRotationToMatchAttachedMesh = useLocalSpace
    }
    if (positionGizmo) {
      positionGizmo.updateGizmoRotationToMatchAttachedMesh = useLocalSpace
    }
    // Scale gizmo doesn't have this property - it always works in local space
    console.log('[Babylon] Gizmo space updated, local:', useLocalSpace)
  }

  function syncTransformToStore() {
    if (!currentSplat) return

    const pos = currentSplat.position
    const rot = currentSplat.rotation
    const scl = currentSplat.scaling

    editorStore.updateTransform({
      position: { x: pos.x, y: pos.y, z: pos.z },
      rotation: { 
        x: rot.x * (180 / Math.PI), 
        y: rot.y * (180 / Math.PI), 
        z: rot.z * (180 / Math.PI) 
      },
      scale: { x: scl.x, y: scl.y, z: scl.z }
    })
  }

  function applySplatTransform(position?: { x: number; y: number; z: number }, rotation?: { x: number; y: number; z: number }, scale?: { x: number; y: number; z: number }) {
    if (!currentSplat) return

    if (position) {
      currentSplat.position = new Vector3(position.x, position.y, position.z)
    }
    if (rotation) {
      // Convert degrees to radians
      currentSplat.rotation = new Vector3(
        rotation.x * (Math.PI / 180),
        rotation.y * (Math.PI / 180),
        rotation.z * (Math.PI / 180)
      )
    }
    if (scale) {
      currentSplat.scaling = new Vector3(scale.x, scale.y, scale.z)
    }
  }

  function resetSplatTransform() {
    if (!currentSplat) return

    currentSplat.position = Vector3.Zero()
    currentSplat.rotation = Vector3.Zero()
    currentSplat.scaling = new Vector3(1, 1, 1)
    
    editorStore.resetTransform()
    console.log('[Babylon] Splat transform reset')
  }

  function rotateSplat90(axis: 'x' | 'y' | 'z') {
    if (!currentSplat) return

    const angle = Math.PI * 0.5  // 90 degrees
    switch (axis) {
      case 'x':
        currentSplat.rotation.x += angle
        break
      case 'y':
        currentSplat.rotation.y += angle
        break
      case 'z':
        currentSplat.rotation.z += angle
        break
    }

    syncTransformToStore()
    console.log(`[Babylon] Splat rotated 90° around ${axis.toUpperCase()} axis`)
  }

  // Apply a transform directly to the mesh (used by undo/redo)
  function applyTransformFromHistory(transform: Transform) {
    if (!currentSplat) return

    currentSplat.position = new Vector3(transform.position.x, transform.position.y, transform.position.z)
    currentSplat.rotation = new Vector3(
      transform.rotation.x * (Math.PI / 180),
      transform.rotation.y * (Math.PI / 180),
      transform.rotation.z * (Math.PI / 180)
    )
    currentSplat.scaling = new Vector3(transform.scale.x, transform.scale.y, transform.scale.z)
    console.log('[Babylon] Transform applied from history')
  }

  // ============================================
  // Clipping Sphere Functions
  // ============================================

  function createClipSphereWidget() {
    if (!scene) return

    // Dispose existing
    if (clipSphereMesh) {
      clipSphereMesh.dispose()
    }

    const radius = editorStore.clipSphere.radius
    const center = editorStore.clipSphere.center
    const segments = 64

    // Create three circle lines for XY, XZ, and YZ planes
    const lines: Vector3[][] = []

    // XY plane circle (Z = 0)
    const xyCircle: Vector3[] = []
    for (let i = 0; i <= segments; i++) {
      const angle = (i / segments) * Math.PI * 2
      xyCircle.push(new Vector3(
        Math.cos(angle) * radius,
        Math.sin(angle) * radius,
        0
      ))
    }
    lines.push(xyCircle)

    // XZ plane circle (Y = 0)
    const xzCircle: Vector3[] = []
    for (let i = 0; i <= segments; i++) {
      const angle = (i / segments) * Math.PI * 2
      xzCircle.push(new Vector3(
        Math.cos(angle) * radius,
        0,
        Math.sin(angle) * radius
      ))
    }
    lines.push(xzCircle)

    // YZ plane circle (X = 0)
    const yzCircle: Vector3[] = []
    for (let i = 0; i <= segments; i++) {
      const angle = (i / segments) * Math.PI * 2
      yzCircle.push(new Vector3(
        0,
        Math.cos(angle) * radius,
        Math.sin(angle) * radius
      ))
    }
    lines.push(yzCircle)

    clipSphereMesh = MeshBuilder.CreateLineSystem('clipSphere', { lines }, scene)
    clipSphereMesh.color = new Color3(1, 0.5, 0)  // Orange
    clipSphereMesh.position = new Vector3(center.x, center.y, center.z)
    clipSphereMesh.isPickable = false

    // Create position gizmo for the sphere
    if (utilityLayer && !clipSphereGizmo) {
      clipSphereGizmo = new PositionGizmo(utilityLayer)
      clipSphereGizmo.scaleRatio = 0.75
      clipSphereGizmo.onDragEndObservable.add(() => {
        if (clipSphereMesh) {
          // Use absolutePosition to get world position
          const absPos = clipSphereMesh.absolutePosition
          console.log('[Babylon] Clip sphere dragged to:', absPos.x, absPos.y, absPos.z)
          editorStore.setClipSphereCenter(absPos.x, absPos.y, absPos.z)
        }
      })
    }

    if (clipSphereGizmo) {
      clipSphereGizmo.attachedMesh = clipSphereMesh
    }

    console.log('[Babylon] Clip sphere widget created, radius:', radius)
  }

  function setClipSphereVisible(visible: boolean) {
    if (visible) {
      createClipSphereWidget()
    } else {
      if (clipSphereMesh) {
        clipSphereMesh.dispose()
        clipSphereMesh = null
      }
      if (clipSphereGizmo) {
        clipSphereGizmo.attachedMesh = null
      }
    }
    console.log('[Babylon] Clip sphere visibility:', visible)
  }

  function updateClipSphereRadius(radius: number) {
    if (editorStore.clipSphere.enabled) {
      // Recreate the widget with new radius
      createClipSphereWidget()
    }
  }

  function updateClipSpherePosition(x: number, y: number, z: number) {
    if (clipSphereMesh) {
      clipSphereMesh.position = new Vector3(x, y, z)
    }
  }

  // ============================================
  // Clipping Box Functions
  // ============================================

  function createClipBoxWidget() {
    if (!scene) return

    // Dispose existing
    if (clipBoxMesh) {
      clipBoxMesh.dispose()
    }

    const size = editorStore.clipBox.size
    const center = editorStore.clipBox.center

    // Create wireframe box using line system
    const halfX = size.x * 0.5
    const halfY = size.y * 0.5
    const halfZ = size.z * 0.5

    // Define the 8 corners of the box
    const corners = [
      new Vector3(-halfX, -halfY, -halfZ), // 0: bottom-back-left
      new Vector3( halfX, -halfY, -halfZ), // 1: bottom-back-right
      new Vector3( halfX, -halfY,  halfZ), // 2: bottom-front-right
      new Vector3(-halfX, -halfY,  halfZ), // 3: bottom-front-left
      new Vector3(-halfX,  halfY, -halfZ), // 4: top-back-left
      new Vector3( halfX,  halfY, -halfZ), // 5: top-back-right
      new Vector3( halfX,  halfY,  halfZ), // 6: top-front-right
      new Vector3(-halfX,  halfY,  halfZ), // 7: top-front-left
    ]

    // Define the 12 edges of the box
    const lines = [
      // Bottom face
      [corners[0], corners[1]],
      [corners[1], corners[2]],
      [corners[2], corners[3]],
      [corners[3], corners[0]],
      // Top face
      [corners[4], corners[5]],
      [corners[5], corners[6]],
      [corners[6], corners[7]],
      [corners[7], corners[4]],
      // Vertical edges
      [corners[0], corners[4]],
      [corners[1], corners[5]],
      [corners[2], corners[6]],
      [corners[3], corners[7]],
    ]

    clipBoxMesh = MeshBuilder.CreateLineSystem('clipBox', { lines }, scene)
    clipBoxMesh.color = new Color3(0.3, 0.7, 1)  // Light blue
    clipBoxMesh.position = new Vector3(center.x, center.y, center.z)
    clipBoxMesh.isPickable = false

    // Create position gizmo for the box
    if (utilityLayer && !clipBoxGizmo) {
      clipBoxGizmo = new PositionGizmo(utilityLayer)
      clipBoxGizmo.scaleRatio = 0.75
      clipBoxGizmo.onDragEndObservable.add(() => {
        if (clipBoxMesh) {
          const absPos = clipBoxMesh.absolutePosition
          console.log('[Babylon] Clip box dragged to:', absPos.x, absPos.y, absPos.z)
          editorStore.setClipBoxCenter(absPos.x, absPos.y, absPos.z)
        }
      })
    }

    if (clipBoxGizmo) {
      clipBoxGizmo.attachedMesh = clipBoxMesh
    }

    console.log('[Babylon] Clip box widget created, size:', size.x, size.y, size.z)
  }

  function setClipBoxVisible(visible: boolean) {
    if (visible) {
      createClipBoxWidget()
    } else {
      if (clipBoxMesh) {
        clipBoxMesh.dispose()
        clipBoxMesh = null
      }
      if (clipBoxGizmo) {
        clipBoxGizmo.attachedMesh = null
      }
    }
    console.log('[Babylon] Clip box visibility:', visible)
  }

  function updateClipBoxSize(x: number, y: number, z: number) {
    if (editorStore.clipBox.enabled) {
      // Recreate the widget with new size
      createClipBoxWidget()
    }
  }

  function updateClipBoxPosition(x: number, y: number, z: number) {
    if (clipBoxMesh) {
      clipBoxMesh.position = new Vector3(x, y, z)
    }
  }

  async function applyClipBox(): Promise<{ originalCount: number; clippedCount: number } | null> {
    if (!originalFileBlob || !scene) {
      console.error('[Babylon] No original file to clip')
      return null
    }

    const center = editorStore.clipBox.center
    const size = editorStore.clipBox.size

    // Calculate half extents for AABB test
    let localCenter = { x: center.x, y: center.y, z: center.z }
    let localHalfSize = { x: size.x * 0.5, y: size.y * 0.5, z: size.z * 0.5 }

    if (currentSplat) {
      const meshPos = currentSplat.position
      const meshRot = currentSplat.rotation
      const meshScale = currentSplat.scaling
      
      console.log('[Babylon] Current splat transform:')
      console.log('  Position:', meshPos.x, meshPos.y, meshPos.z)
      console.log('  Rotation:', meshRot.x, meshRot.y, meshRot.z)
      console.log('  Scale:', meshScale.x, meshScale.y, meshScale.z)
      
      // Check if mesh has any transform applied
      const hasTransform = 
        meshPos.x !== 0 || meshPos.y !== 0 || meshPos.z !== 0 ||
        meshRot.x !== 0 || meshRot.y !== 0 || meshRot.z !== 0 ||
        meshScale.x !== 1 || meshScale.y !== 1 || meshScale.z !== 1
      
      if (hasTransform) {
        // Get the splat's world matrix and compute its inverse
        const worldMatrix = currentSplat.getWorldMatrix()
        const inverseWorldMatrix = worldMatrix.clone().invert()
        
        // Transform the clip box center from world to local space
        const worldCenterVec = new Vector3(center.x, center.y, center.z)
        const localCenterVec = Vector3.TransformCoordinates(worldCenterVec, inverseWorldMatrix)
        
        localCenter = { 
          x: localCenterVec.x, 
          y: localCenterVec.y, 
          z: localCenterVec.z 
        }
        
        // Adjust half-size for scale
        localHalfSize = {
          x: localHalfSize.x / Math.abs(meshScale.x),
          y: localHalfSize.y / Math.abs(meshScale.y),
          z: localHalfSize.z / Math.abs(meshScale.z)
        }
        
        console.log('[Babylon] Mesh has transform, converted clip box from world to local')
      } else {
        console.log('[Babylon] Mesh at identity transform, using world coordinates directly')
      }
    }

    console.log('[Babylon] Applying clip box:')
    console.log('  World center:', center.x, center.y, center.z)
    console.log('  Local center:', localCenter.x, localCenter.y, localCenter.z)
    console.log('  Half size:', localHalfSize.x, localHalfSize.y, localHalfSize.z)

    try {
      // Read the original file
      const arrayBuffer = await originalFileBlob.arrayBuffer()
      const uint8 = new Uint8Array(arrayBuffer)

      // Detect format and parse
      const header = new TextDecoder().decode(uint8.slice(0, 100))
      
      if (header.startsWith('ply')) {
        return await clipPlyFileBox(uint8, localCenter, localHalfSize)
      } else {
        return await clipSplatFileBox(uint8, localCenter, localHalfSize)
      }
    } catch (e) {
      console.error('[Babylon] Failed to apply clip box:', e)
      return null
    }
  }

  async function clipPlyFileBox(
    data: Uint8Array, 
    center: { x: number; y: number; z: number },
    halfSize: { x: number; y: number; z: number }
  ): Promise<{ originalCount: number; clippedCount: number }> {
    // Parse PLY header
    const headerEnd = findPlyHeaderEnd(data)
    if (headerEnd < 0) {
      throw new Error('Invalid PLY file - no header end found')
    }

    const headerStr = new TextDecoder().decode(data.slice(0, headerEnd))
    const vertexCountMatch = headerStr.match(/element vertex (\d+)/)
    if (!vertexCountMatch) {
      throw new Error('Invalid PLY file - no vertex count')
    }

    const originalCount = parseInt(vertexCountMatch[1])
    
    const properties = parsePlyProperties(headerStr)
    const vertexSize = properties.reduce((sum, p) => sum + p.size, 0)
    
    const xProp = properties.find(p => p.name === 'x')
    const yProp = properties.find(p => p.name === 'y')
    const zProp = properties.find(p => p.name === 'z')
    
    if (!xProp || !yProp || !zProp) {
      throw new Error('PLY file missing position properties')
    }

    const dataStart = headerEnd
    const dataView = new DataView(data.buffer, data.byteOffset + dataStart)

    // Find vertices inside box (AABB test)
    const insideIndices: number[] = []
    
    const minX = center.x - halfSize.x
    const maxX = center.x + halfSize.x
    const minY = center.y - halfSize.y
    const maxY = center.y + halfSize.y
    const minZ = center.z - halfSize.z
    const maxZ = center.z + halfSize.z
    
    for (let i = 0; i < originalCount; i++) {
      const offset = i * vertexSize
      const x = dataView.getFloat32(offset + xProp.offset, true)
      const y = -dataView.getFloat32(offset + yProp.offset, true)  // Negated Y for Babylon
      const z = dataView.getFloat32(offset + zProp.offset, true)
      
      if (x >= minX && x <= maxX && y >= minY && y <= maxY && z >= minZ && z <= maxZ) {
        insideIndices.push(i)
      }
    }

    const clippedCount = insideIndices.length
    console.log('[Babylon] PLY box clip: keeping', clippedCount, 'of', originalCount, 'splats')

    // Build new PLY file
    const newHeader = headerStr.replace(
      /element vertex \d+/,
      `element vertex ${clippedCount}`
    )
    const newHeaderBytes = new TextEncoder().encode(newHeader)
    
    const newDataSize = clippedCount * vertexSize
    const newFile = new Uint8Array(newHeaderBytes.length + newDataSize)
    newFile.set(newHeaderBytes)
    
    for (let i = 0; i < insideIndices.length; i++) {
      const srcOffset = dataStart + insideIndices[i] * vertexSize
      const dstOffset = newHeaderBytes.length + i * vertexSize
      newFile.set(data.slice(srcOffset, srcOffset + vertexSize), dstOffset)
    }

    // Load the clipped file
    const clippedBlob = new Blob([newFile], { type: 'application/octet-stream' })
    const url = URL.createObjectURL(clippedBlob)
    
    await loadSplat(url, originalFileName || 'clipped.ply', false, true)
    URL.revokeObjectURL(url)

    return { originalCount, clippedCount }
  }

  async function clipSplatFileBox(
    data: Uint8Array,
    center: { x: number; y: number; z: number },
    halfSize: { x: number; y: number; z: number }
  ): Promise<{ originalCount: number; clippedCount: number }> {
    const bytesPerSplat = 32
    const originalCount = Math.floor(data.length / bytesPerSplat)
    const dataView = new DataView(data.buffer, data.byteOffset)

    const minX = center.x - halfSize.x
    const maxX = center.x + halfSize.x
    const minY = center.y - halfSize.y
    const maxY = center.y + halfSize.y
    const minZ = center.z - halfSize.z
    const maxZ = center.z + halfSize.z

    const insideIndices: number[] = []
    
    for (let i = 0; i < originalCount; i++) {
      const offset = i * bytesPerSplat
      const x = dataView.getFloat32(offset, true)
      const y = -dataView.getFloat32(offset + 4, true)  // Negated Y
      const z = dataView.getFloat32(offset + 8, true)
      
      if (x >= minX && x <= maxX && y >= minY && y <= maxY && z >= minZ && z <= maxZ) {
        insideIndices.push(i)
      }
    }

    const clippedCount = insideIndices.length
    console.log('[Babylon] Splat box clip: keeping', clippedCount, 'of', originalCount, 'splats')

    const newFile = new Uint8Array(clippedCount * bytesPerSplat)
    
    for (let i = 0; i < insideIndices.length; i++) {
      const srcOffset = insideIndices[i] * bytesPerSplat
      const dstOffset = i * bytesPerSplat
      newFile.set(data.slice(srcOffset, srcOffset + bytesPerSplat), dstOffset)
    }

    const clippedBlob = new Blob([newFile], { type: 'application/octet-stream' })
    const url = URL.createObjectURL(clippedBlob)
    
    await loadSplat(url, originalFileName || 'clipped.splat', false, true)
    URL.revokeObjectURL(url)

    return { originalCount, clippedCount }
  }

  function storeOriginalFile(blob: Blob, name: string) {
    originalFileBlob = blob
    originalFileName = name
    console.log('[Babylon] Original file stored:', name, blob.size, 'bytes')
  }

  function getOriginalFile(): { blob: Blob; name: string } | null {
    if (originalFileBlob && originalFileName) {
      return { blob: originalFileBlob, name: originalFileName }
    }
    return null
  }

  async function applyClipSphere(): Promise<{ originalCount: number; clippedCount: number } | null> {
    if (!originalFileBlob || !scene) {
      console.error('[Babylon] No original file to clip')
      return null
    }

    const center = editorStore.clipSphere.center
    const radius = editorStore.clipSphere.radius

    // The clip sphere is positioned in WORLD space visually
    // The PLY/splat vertex data is in LOCAL (model) space
    // 
    // IMPORTANT: When the mesh has identity transform (default), the vertex
    // positions in the file ARE the world positions. So we use the clip 
    // sphere center directly.
    //
    // If the user has applied transforms to the mesh, we need to transform
    // the clip center from world to local space.
    
    let localCenter = { x: center.x, y: center.y, z: center.z }
    let localRadius = radius

    if (currentSplat) {
      const meshPos = currentSplat.position
      const meshRot = currentSplat.rotation
      const meshScale = currentSplat.scaling
      
      console.log('[Babylon] Current splat transform:')
      console.log('  Position:', meshPos.x, meshPos.y, meshPos.z)
      console.log('  Rotation:', meshRot.x, meshRot.y, meshRot.z)
      console.log('  Scale:', meshScale.x, meshScale.y, meshScale.z)
      
      // Check if mesh has any transform applied
      const hasTransform = 
        meshPos.x !== 0 || meshPos.y !== 0 || meshPos.z !== 0 ||
        meshRot.x !== 0 || meshRot.y !== 0 || meshRot.z !== 0 ||
        meshScale.x !== 1 || meshScale.y !== 1 || meshScale.z !== 1
      
      if (hasTransform) {
        // Get the splat's world matrix and compute its inverse
        const worldMatrix = currentSplat.getWorldMatrix()
        const inverseWorldMatrix = worldMatrix.clone().invert()
        
        // Transform the clip sphere center from world to local space
        const worldCenterVec = new Vector3(center.x, center.y, center.z)
        const localCenterVec = Vector3.TransformCoordinates(worldCenterVec, inverseWorldMatrix)
        
        localCenter = { 
          x: localCenterVec.x, 
          y: localCenterVec.y, 
          z: localCenterVec.z 
        }
        
        // Adjust radius for scale (use the average scale factor)
        const avgScale = (Math.abs(meshScale.x) + Math.abs(meshScale.y) + Math.abs(meshScale.z)) / 3
        if (avgScale !== 0 && avgScale !== 1) {
          localRadius = radius / avgScale
        }
        
        console.log('[Babylon] Mesh has transform, converted clip center from world to local')
      } else {
        console.log('[Babylon] Mesh at identity transform, using world coordinates directly')
      }
    }

    const radiusSq = localRadius * localRadius

    console.log('[Babylon] Applying clip sphere:')
    console.log('  World center:', center.x, center.y, center.z)
    console.log('  Local center:', localCenter.x, localCenter.y, localCenter.z)
    console.log('  Radius:', localRadius)

    try {
      // Read the original file
      const arrayBuffer = await originalFileBlob.arrayBuffer()
      const uint8 = new Uint8Array(arrayBuffer)

      // Detect format and parse
      const header = new TextDecoder().decode(uint8.slice(0, 100))
      
      if (header.startsWith('ply')) {
        // PLY format
        return await clipPlyFile(uint8, localCenter, radiusSq)
      } else {
        // Assume .splat format (32 bytes per splat)
        return await clipSplatFile(uint8, localCenter, radiusSq)
      }
    } catch (e) {
      console.error('[Babylon] Failed to apply clip sphere:', e)
      return null
    }
  }

  async function clipPlyFile(
    data: Uint8Array, 
    center: { x: number; y: number; z: number },
    radiusSq: number
  ): Promise<{ originalCount: number; clippedCount: number }> {
    // Parse PLY header
    const headerEnd = findPlyHeaderEnd(data)
    if (headerEnd < 0) {
      throw new Error('Invalid PLY file - no header end found')
    }

    const headerStr = new TextDecoder().decode(data.slice(0, headerEnd))
    const vertexCountMatch = headerStr.match(/element vertex (\d+)/)
    if (!vertexCountMatch) {
      throw new Error('Invalid PLY file - no vertex count')
    }

    const originalCount = parseInt(vertexCountMatch[1])
    
    // Find property order and calculate vertex size
    const properties = parsePlyProperties(headerStr)
    const vertexSize = properties.reduce((sum, p) => sum + p.size, 0)
    
    // Find position indices
    const xProp = properties.find(p => p.name === 'x')
    const yProp = properties.find(p => p.name === 'y')
    const zProp = properties.find(p => p.name === 'z')
    
    if (!xProp || !yProp || !zProp) {
      throw new Error('PLY file missing position properties')
    }

    const dataStart = headerEnd
    const dataView = new DataView(data.buffer, data.byteOffset + dataStart)

    // Debug: sample some vertex positions to understand the data
    if (originalCount > 0) {
      const sampleOffset = 0
      const rawY = dataView.getFloat32(sampleOffset + yProp.offset, true)
      const sampleX = dataView.getFloat32(sampleOffset + xProp.offset, true)
      const sampleY = -rawY  // Negated Y as used in clipping
      const sampleZ = dataView.getFloat32(sampleOffset + zProp.offset, true)
      console.log('[Babylon] PLY first vertex - raw Y:', rawY, '-> transformed:', sampleX, sampleY, sampleZ)
      
      // Find bounding box of all vertices (with Y negation)
      let minX = Infinity, minY = Infinity, minZ = Infinity
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
      for (let i = 0; i < Math.min(originalCount, 1000); i++) {
        const offset = i * vertexSize
        const x = dataView.getFloat32(offset + xProp.offset, true)
        const y = -dataView.getFloat32(offset + yProp.offset, true)  // Negated
        const z = dataView.getFloat32(offset + zProp.offset, true)
        minX = Math.min(minX, x); maxX = Math.max(maxX, x)
        minY = Math.min(minY, y); maxY = Math.max(maxY, y)
        minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z)
      }
      console.log('[Babylon] PLY bounds with Y negated (first 1000):', 
        'X:', minX.toFixed(2), 'to', maxX.toFixed(2),
        'Y:', minY.toFixed(2), 'to', maxY.toFixed(2),
        'Z:', minZ.toFixed(2), 'to', maxZ.toFixed(2))
      console.log('[Babylon] Clip center:', center.x.toFixed(2), center.y.toFixed(2), center.z.toFixed(2), 'radius:', Math.sqrt(radiusSq).toFixed(2))
    }

    // First pass: count vertices inside sphere
    // NOTE: Babylon.js GaussianSplattingMesh may transform PLY coordinates when loading
    // Common transforms include negating Y or Z for coordinate system conversion
    // We need to apply the same transform to match what Babylon displays
    const insideIndices: number[] = []
    
    for (let i = 0; i < originalCount; i++) {
      const offset = i * vertexSize
      const x = dataView.getFloat32(offset + xProp.offset, true)
      // Negate Y to match Babylon's coordinate transform for PLY files
      const y = -dataView.getFloat32(offset + yProp.offset, true)
      const z = dataView.getFloat32(offset + zProp.offset, true)
      
      const dx = x - center.x
      const dy = y - center.y
      const dz = z - center.z
      const distSq = dx * dx + dy * dy + dz * dz
      
      if (distSq <= radiusSq) {
        insideIndices.push(i)
      }
    }

    const clippedCount = insideIndices.length
    console.log('[Babylon] PLY clip: keeping', clippedCount, 'of', originalCount, 'splats')

    // Build new PLY file
    const newHeader = headerStr.replace(
      /element vertex \d+/,
      `element vertex ${clippedCount}`
    )
    const newHeaderBytes = new TextEncoder().encode(newHeader)
    
    const newDataSize = clippedCount * vertexSize
    const newFile = new Uint8Array(newHeaderBytes.length + newDataSize)
    newFile.set(newHeaderBytes)
    
    // Copy vertex data for inside vertices
    for (let i = 0; i < insideIndices.length; i++) {
      const srcOffset = dataStart + insideIndices[i] * vertexSize
      const dstOffset = newHeaderBytes.length + i * vertexSize
      newFile.set(data.slice(srcOffset, srcOffset + vertexSize), dstOffset)
    }

    // Load the clipped file (mark as internal reload to preserve original)
    const clippedBlob = new Blob([newFile], { type: 'application/octet-stream' })
    const url = URL.createObjectURL(clippedBlob)
    
    await loadSplat(url, originalFileName || 'clipped.ply', false, true)
    URL.revokeObjectURL(url)

    return { originalCount, clippedCount }
  }

  async function clipSplatFile(
    data: Uint8Array,
    center: { x: number; y: number; z: number },
    radiusSq: number
  ): Promise<{ originalCount: number; clippedCount: number }> {
    const bytesPerSplat = 32
    const originalCount = Math.floor(data.length / bytesPerSplat)
    const dataView = new DataView(data.buffer, data.byteOffset)

    // Find splats inside sphere
    // NOTE: Apply same Y negation as PLY to match Babylon's display
    const insideIndices: number[] = []
    
    for (let i = 0; i < originalCount; i++) {
      const offset = i * bytesPerSplat
      const x = dataView.getFloat32(offset, true)
      // Negate Y to match Babylon's coordinate transform
      const y = -dataView.getFloat32(offset + 4, true)
      const z = dataView.getFloat32(offset + 8, true)
      
      const dx = x - center.x
      const dy = y - center.y
      const dz = z - center.z
      const distSq = dx * dx + dy * dy + dz * dz
      
      if (distSq <= radiusSq) {
        insideIndices.push(i)
      }
    }

    const clippedCount = insideIndices.length
    console.log('[Babylon] Splat clip: keeping', clippedCount, 'of', originalCount, 'splats')

    // Build new splat file
    const newFile = new Uint8Array(clippedCount * bytesPerSplat)
    
    for (let i = 0; i < insideIndices.length; i++) {
      const srcOffset = insideIndices[i] * bytesPerSplat
      const dstOffset = i * bytesPerSplat
      newFile.set(data.slice(srcOffset, srcOffset + bytesPerSplat), dstOffset)
    }

    // Load the clipped file (mark as internal reload to preserve original)
    const clippedBlob = new Blob([newFile], { type: 'application/octet-stream' })
    const url = URL.createObjectURL(clippedBlob)
    
    await loadSplat(url, originalFileName || 'clipped.splat', false, true)
    URL.revokeObjectURL(url)

    return { originalCount, clippedCount }
  }

  function findPlyHeaderEnd(data: Uint8Array): number {
    // Look for "end_header\n"
    const searchStr = 'end_header\n'
    const searchBytes = new TextEncoder().encode(searchStr)
    
    for (let i = 0; i < Math.min(data.length - searchBytes.length, 10000); i++) {
      let found = true
      for (let j = 0; j < searchBytes.length; j++) {
        if (data[i + j] !== searchBytes[j]) {
          found = false
          break
        }
      }
      if (found) {
        return i + searchBytes.length
      }
    }
    return -1
  }

  function parsePlyProperties(header: string): Array<{ name: string; size: number; offset: number }> {
    const properties: Array<{ name: string; size: number; offset: number }> = []
    const lines = header.split('\n')
    let offset = 0

    for (const line of lines) {
      const match = line.match(/^property\s+(\w+)\s+(\w+)/)
      if (match) {
        const type = match[1]
        const name = match[2]
        let size = 4  // default float size
        
        if (type === 'double') size = 8
        else if (type === 'uchar' || type === 'char') size = 1
        else if (type === 'short' || type === 'ushort') size = 2
        else if (type === 'int' || type === 'uint' || type === 'float') size = 4
        
        properties.push({ name, size, offset })
        offset += size
      }
    }

    return properties
  }

  // ============================================
  // Bake Transform Functions
  // ============================================

  /**
   * Bake the current mesh transform into the vertex data and reset mesh to identity.
   * Uses Babylon.js built-in bakeCurrentTransformIntoVertices() method.
   */
  function bakeTransformToVertices(): boolean {
    if (!currentSplat) {
      console.error('[Babylon] No splat loaded to bake transform')
      return false
    }

    const meshPos = currentSplat.position
    const meshRot = currentSplat.rotation
    const meshScale = currentSplat.scaling

    // Check if there's any transform to bake
    const hasTransform = 
      meshPos.x !== 0 || meshPos.y !== 0 || meshPos.z !== 0 ||
      meshRot.x !== 0 || meshRot.y !== 0 || meshRot.z !== 0 ||
      meshScale.x !== 1 || meshScale.y !== 1 || meshScale.z !== 1

    if (!hasTransform) {
      console.log('[Babylon] No transform to bake - mesh already at identity')
      return true
    }

    console.log('[Babylon] Baking transform into vertices:')
    console.log('  Position:', meshPos.x, meshPos.y, meshPos.z)
    console.log('  Rotation:', meshRot.x, meshRot.y, meshRot.z)
    console.log('  Scale:', meshScale.x, meshScale.y, meshScale.z)

    try {
      // Use Babylon's built-in method to bake transform into vertex buffers
      currentSplat.bakeCurrentTransformIntoVertices()
      
      // Reset the editor store transform (the mesh transform is now identity)
      editorStore.resetTransform()

      console.log('[Babylon] Transform baked successfully')
      return true
    } catch (e) {
      console.error('[Babylon] Failed to bake transform:', e)
      return false
    }
  }

  /**
   * Center the splat at the origin by computing the bounding box center
   * and offsetting all vertices.
   */
  function centerAtOrigin(): boolean {
    if (!currentSplat) {
      console.error('[Babylon] No splat loaded to center')
      return false
    }

    try {
      // Get bounding info to find center
      const boundingInfo = currentSplat.getBoundingInfo()
      const center = boundingInfo.boundingBox.centerWorld.clone()
      
      console.log('[Babylon] Centering splat - current center:', center.x, center.y, center.z)

      // If already at origin, nothing to do
      if (Math.abs(center.x) < 0.01 && Math.abs(center.y) < 0.01 && Math.abs(center.z) < 0.01) {
        console.log('[Babylon] Splat already centered at origin')
        return true
      }

      // Move mesh to compensate, then bake that offset into vertices
      currentSplat.position.subtractInPlace(center)
      
      // Bake the offset into vertices
      return bakeTransformToVertices()
    } catch (e) {
      console.error('[Babylon] Failed to center at origin:', e)
      return false
    }
  }

  async function loadSplat(url: string, name: string, isPreview: boolean = false, isInternalReload: boolean = false) {
    if (!scene) {
      console.error('[Babylon] Cannot load splat - scene not initialized')
      return
    }

    console.log('[Babylon] Loading splat:', name, 'from:', url, 'isPreview:', isPreview)

    // Dispose existing splat mesh properly
    if (currentSplat) {
      console.log('[Babylon] Disposing previous splat mesh')
      currentSplat.dispose()
      currentSplat = null
    }
    
    // Clear debug mesh if exists
    if (debugMesh) {
      debugMesh.dispose()
      debugMesh = null
    }
    
    // Clear COLMAP preview when loading any splat (preview or final)
    if (colmapPreviewMeshes.length > 0) {
      console.log('[Babylon] Clearing COLMAP preview for splat load')
      clearColmapPreview()
    }

    // Only clear scene store for non-preview loads
    if (!isPreview) {
      sceneStore.clearAll()
    }

    try {
      // Only show loading indicator for non-preview loads
      if (!isPreview) {
        appStore.isLoading = true
      }

      // Store original file for clipping (only for non-preview loads from user imports)
      // Skip if this is an internal reload (like from clipping)
      if (!isPreview && url.startsWith('blob:') && !isInternalReload) {
        try {
          const response = await fetch(url)
          const blob = await response.blob()
          storeOriginalFile(blob, name)
        } catch (e) {
          console.warn('[Babylon] Could not store original file:', e)
        }
      }

      // Create new Gaussian Splatting mesh
      currentSplat = new GaussianSplattingMesh(name, null, scene)
      console.log('[Babylon] GaussianSplattingMesh created, loading file...')
      
      await currentSplat.loadFileAsync(url)
      console.log('[Babylon] File loaded successfully')

      // Get splat count
      const splatCount = currentSplat.getScene() ? 
        (currentSplat as any)._covariancesATexture?.getSize()?.width || 0 : 0

      console.log('[Babylon] Splat count:', splatCount)

      // Only add to scene store for non-preview loads, or update existing for previews
      if (!isPreview) {
        sceneStore.addObject({
          id: crypto.randomUUID(),
          name: name,
          visible: true,
          splatCount: splatCount
        })
      } else {
        // Update splat count in scene store if there's an existing preview entry
        sceneStore.updatePreviewSplatCount(splatCount)
      }

      // Focus camera on splat (only on first load or non-preview)
      if ((orbitCamera || flyCamera) && currentSplat.getBoundingInfo()) {
        // Only reposition camera for first preview or non-preview loads
        if (!isPreview || !sceneStore.hasPreviewObject) {
          focusCamera()
        }
      }
    } catch (error) {
      console.error('[Babylon] Failed to load splat:', error)
      if (!isPreview) {
        appStore.error = 'Failed to load splat file'
        // Show debug cube on error
        showDebugCube(true)
      }
    } finally {
      if (!isPreview) {
        appStore.isLoading = false
      }
    }
  }

  function clearSplat(clearStore: boolean = true) {
    if (currentSplat) {
      console.log('[Babylon] Disposing splat mesh in clearSplat')
      currentSplat.dispose()
      currentSplat = null
    }
    if (clearStore) {
      sceneStore.clearAll()
    }
  }

  function dispose() {
    clearSplat()
    scene?.dispose()
    engine?.dispose()
    scene = null
    engine = null
    flyCamera = null
    orbitCamera = null
    activeCamera = null
    isReady.value = false
  }

  function getScene() {
    return scene
  }

  function getEngine() {
    return engine
  }

  function getCamera() {
    return activeCamera
  }

  function getCurrentSplat() {
    return currentSplat
  }

  /**
   * Show a debug cube to verify scene is rendering
   */
  function showDebugCube(show: boolean = true) {
    if (!scene) return

    if (debugMesh) {
      debugMesh.dispose()
      debugMesh = null
    }

    if (show) {
      debugMesh = MeshBuilder.CreateBox('debugCube', { size: 1 }, scene)
      const material = new StandardMaterial('debugMat', scene)
      material.diffuseColor = new Color3(0.4, 0.6, 1)
      material.emissiveColor = new Color3(0.1, 0.2, 0.4)
      debugMesh.material = material

      // Rotate slowly
      scene.registerBeforeRender(() => {
        if (debugMesh) {
          debugMesh.rotation.y += 0.01
          debugMesh.rotation.x += 0.005
        }
      })

      // Focus camera on cube
      focusCamera(Vector3.Zero(), 5)

      console.log('[Babylon] Debug cube created')
    }
  }

  /**
   * Check if scene is ready and rendering
   */
  function isSceneReady(): boolean {
    return isReady.value && scene !== null && engine !== null
  }

  /**
   * Focus camera on the current splat or a specific target
   */
  function focusCamera(target?: Vector3, distance?: number) {
    if (!orbitCamera && !flyCamera) {
      console.warn('[Babylon] Cannot focus - cameras not initialized')
      return
    }

    // Get target and distance
    let targetPos = target || Vector3.Zero()
    let dist = distance || 10

    if (!target && currentSplat) {
      try {
        const boundingInfo = currentSplat.getBoundingInfo()
        if (boundingInfo) {
          targetPos = boundingInfo.boundingBox.centerWorld.clone()
          const radius = boundingInfo.boundingSphere.radiusWorld
          dist = Math.max(radius * 2.5, 5)
        }
      } catch (e) {
        console.warn('[Babylon] Could not get bounding info, using default focus')
      }
    }

    // Focus orbit camera
    if (orbitCamera) {
      orbitCamera.setTarget(targetPos)
      orbitCamera.radius = dist
      orbitCamera.alpha = -Math.PI * 0.5
      orbitCamera.beta = Math.PI * 0.4
    }

    // Focus fly camera
    if (flyCamera) {
      flyCamera.position = targetPos.add(new Vector3(0, dist * 0.3, -dist))
      flyCamera.setTarget(targetPos)
      flyCamera.rotationQuaternion = Quaternion.FromEulerAngles(
        flyCamera.rotation.x,
        flyCamera.rotation.y,
        0  // Reset roll
      )
    }

    console.log('[Babylon] Camera focused on:', targetPos, 'distance:', dist)
  }

  // ============================================
  // COLMAP Preview Visualization Functions
  // ============================================

  /**
   * Create a camera frustum wireframe with image plane
   */
  function createCameraFrustum(
    cam: CameraPreview, 
    imageUrl: string, 
    index: number, 
    totalCameras: number
  ): Mesh[] {
    if (!scene) return []

    const meshes: Mesh[] = []
    
    // COLMAP stores camera-to-world transform, we need to convert
    // Position is the camera center in world space
    // Rotation quaternion transforms from camera to world coordinates
    const position = new Vector3(cam.position[0], cam.position[1], cam.position[2])
    
    // Convert quaternion [qx, qy, qz, qw] to Babylon Quaternion
    const rotation = new Quaternion(cam.rotation[0], cam.rotation[1], cam.rotation[2], cam.rotation[3])
    
    // Calculate frustum size based on focal length and image dimensions
    const aspectRatio = cam.width / cam.height
    const fovY = 2 * Math.atan(cam.height / (2 * cam.focalLength))
    const frustumDepth = 0.3  // How far the frustum extends
    const nearHeight = frustumDepth * Math.tan(fovY * 0.5)
    const nearWidth = nearHeight * aspectRatio

    // Frustum corners in camera space (camera looks along +Z, frustum opens forward)
    const corners = [
      new Vector3(-nearWidth, -nearHeight, frustumDepth),  // Bottom-left
      new Vector3(nearWidth, -nearHeight, frustumDepth),   // Bottom-right
      new Vector3(nearWidth, nearHeight, frustumDepth),    // Top-right
      new Vector3(-nearWidth, nearHeight, frustumDepth),   // Top-left
    ]

    // Transform corners to world space
    const worldCorners = corners.map(corner => {
      const rotated = corner.rotateByQuaternionToRef(rotation, new Vector3())
      return rotated.add(position)
    })

    // Color gradient from red (first) to blue (last)
    const t = totalCameras > 1 ? index / (totalCameras - 1) : 0
    const color = new Color3(1 - t, 0.3, t)

    // Create frustum wireframe lines
    const frustumLines = [
      // Edges from camera to corners
      [position, worldCorners[0]],
      [position, worldCorners[1]],
      [position, worldCorners[2]],
      [position, worldCorners[3]],
      // Rectangle at near plane
      [worldCorners[0], worldCorners[1]],
      [worldCorners[1], worldCorners[2]],
      [worldCorners[2], worldCorners[3]],
      [worldCorners[3], worldCorners[0]],
    ]

    const linesMesh = MeshBuilder.CreateLineSystem(
      `frustum_lines_${cam.id}`,
      { lines: frustumLines },
      scene
    )
    linesMesh.color = color
    meshes.push(linesMesh)

    // Create image plane directly from the world corners for perfect alignment
    // worldCorners: [bottom-left, bottom-right, top-right, top-left]
    const imagePlane = new Mesh(`frustum_image_${cam.id}`, scene)
    const vertexData = new VertexData()
    
    // Positions: two triangles forming a quad
    // Triangle 1: bottom-left, bottom-right, top-right
    // Triangle 2: bottom-left, top-right, top-left
    vertexData.positions = [
      worldCorners[0].x, worldCorners[0].y, worldCorners[0].z,  // 0: bottom-left
      worldCorners[1].x, worldCorners[1].y, worldCorners[1].z,  // 1: bottom-right
      worldCorners[2].x, worldCorners[2].y, worldCorners[2].z,  // 2: top-right
      worldCorners[3].x, worldCorners[3].y, worldCorners[3].z,  // 3: top-left
    ]
    
    // Indices for two triangles (facing the camera)
    vertexData.indices = [0, 2, 1, 0, 3, 2]
    
    // UVs: map image to corners (flip V for typical image coordinate system)
    vertexData.uvs = [
      0, 1,  // bottom-left -> image top-left
      1, 1,  // bottom-right -> image top-right
      1, 0,  // top-right -> image bottom-right
      0, 0,  // top-left -> image bottom-left
    ]
    
    vertexData.applyToMesh(imagePlane)

    // Create material with image texture
    const material = new StandardMaterial(`frustum_mat_${cam.id}`, scene)
    material.diffuseTexture = new Texture(imageUrl, scene)
    material.diffuseTexture.hasAlpha = false
    material.emissiveColor = new Color3(0.5, 0.5, 0.5)  // Make it visible without lighting
    material.backFaceCulling = false
    material.alpha = 0.8
    imagePlane.material = material

    meshes.push(imagePlane)

    return meshes
  }

  /**
   * Create point cloud mesh from 3D points
   */
  function createPointCloud(points: Point3D[]): Mesh | null {
    if (!scene || points.length === 0) return null

    console.log(`[Babylon] Creating point cloud with ${points.length} points`)

    // Create custom mesh for point cloud
    const pointCloud = new Mesh('colmap_pointcloud', scene)
    
    // Build vertex data
    const positions: number[] = []
    const colors: number[] = []

    for (const point of points) {
      positions.push(point.x, point.y, point.z)
      // Convert 0-255 to 0-1
      colors.push(point.r / 255, point.g / 255, point.b / 255, 1)
    }

    const vertexData = new VertexData()
    vertexData.positions = positions
    vertexData.colors = colors

    // Create indices for points (each point is its own primitive)
    const indices: number[] = []
    for (let i = 0; i < points.length; i++) {
      indices.push(i)
    }
    vertexData.indices = indices

    vertexData.applyToMesh(pointCloud)

    // Use a material that shows vertex colors
    const material = new StandardMaterial('pointcloud_mat', scene)
    material.emissiveColor = new Color3(1, 1, 1)
    material.disableLighting = true
    material.pointsCloud = true
    material.pointSize = 3
    pointCloud.material = material

    return pointCloud
  }

  /**
   * Load and display COLMAP preview (cameras + point cloud)
   */
  async function loadColmapPreview(data: ColmapPreviewData, getImageUrl: (imageName: string) => string): Promise<void> {
    if (!scene) {
      console.error('[Babylon] Cannot load COLMAP preview - scene not initialized')
      return
    }

    console.log(`[Babylon] Loading COLMAP preview: ${data.cameras.length} cameras, ${data.points3D.length} points`)

    // Clear any existing preview
    clearColmapPreview()

    // Create camera frustums
    console.log(`[Babylon] Creating frustums for ${data.cameras.length} cameras`)
    for (let i = 0; i < data.cameras.length; i++) {
      const cam = data.cameras[i]
      const imageUrl = getImageUrl(cam.imageName)
      console.log(`[Babylon] Camera ${i}: ${cam.imageName} at position [${cam.position.join(', ')}]`)
      const frustumMeshes = createCameraFrustum(cam, imageUrl, i, data.cameras.length)
      console.log(`[Babylon] Created ${frustumMeshes.length} meshes for camera ${i}`)
      colmapPreviewMeshes.push(...frustumMeshes)
    }

    // Create point cloud
    if (data.points3D.length > 0) {
      colmapPointCloud = createPointCloud(data.points3D)
      if (colmapPointCloud) {
        colmapPreviewMeshes.push(colmapPointCloud)
      }
    }

    console.log(`[Babylon] COLMAP preview loaded: ${colmapPreviewMeshes.length} meshes created`)

    // Focus camera on the preview
    if ((orbitCamera || flyCamera) && data.points3D.length > 0) {
      // Calculate bounding box of points
      let minX = Infinity, minY = Infinity, minZ = Infinity
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
      
      for (const point of data.points3D) {
        minX = Math.min(minX, point.x)
        minY = Math.min(minY, point.y)
        minZ = Math.min(minZ, point.z)
        maxX = Math.max(maxX, point.x)
        maxY = Math.max(maxY, point.y)
        maxZ = Math.max(maxZ, point.z)
      }

      const center = new Vector3(
        (minX + maxX) * 0.5,
        (minY + maxY) * 0.5,
        (minZ + maxZ) * 0.5
      )
      const size = Math.max(maxX - minX, maxY - minY, maxZ - minZ)
      const dist = Math.max(size * 1.5, 5)
      
      focusCamera(center, dist)
      console.log('[Babylon] Camera focused on COLMAP preview - center:', center, 'size:', size)
    }
  }

  /**
   * Clear all COLMAP preview meshes
   */
  function clearColmapPreview(): void {
    console.log(`[Babylon] Clearing ${colmapPreviewMeshes.length} COLMAP preview meshes`)
    
    for (const mesh of colmapPreviewMeshes) {
      if (mesh.material) {
        // Dispose textures
        if (mesh.material instanceof StandardMaterial && mesh.material.diffuseTexture) {
          mesh.material.diffuseTexture.dispose()
        }
        mesh.material.dispose()
      }
      mesh.dispose()
    }
    colmapPreviewMeshes = []
    colmapPointCloud = null
  }

  /**
   * Check if COLMAP preview is currently displayed
   */
  function hasColmapPreview(): boolean {
    return colmapPreviewMeshes.length > 0
  }

  return {
    isReady,
    initScene,
    loadSplat,
    clearSplat,
    dispose,
    getScene,
    getEngine,
    getCamera,
    getCurrentSplat,
    showDebugCube,
    isSceneReady,
    focusCamera,
    switchCameraMode,
    // COLMAP preview functions
    loadColmapPreview,
    clearColmapPreview,
    hasColmapPreview,
    // Editor functions
    setAxesVisible,
    setGroundPlaneVisible,
    setActiveGizmo,
    updateGizmoSpace,
    applySplatTransform,
    resetSplatTransform,
    rotateSplat90,
    syncTransformToStore,
    applyTransformFromHistory,
    // Clipping sphere
    setClipSphereVisible,
    updateClipSphereRadius,
    updateClipSpherePosition,
    applyClipSphere,
    // Clipping box
    setClipBoxVisible,
    updateClipBoxSize,
    updateClipBoxPosition,
    applyClipBox,
    getOriginalFile,
    storeOriginalFile,
    // Bake transform
    bakeTransformToVertices,
    centerAtOrigin
  }
}
