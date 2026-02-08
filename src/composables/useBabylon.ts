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
  KeyboardEventTypes,
  PointerEventTypes,
  Matrix,
  Tools,
  Viewport
} from '@babylonjs/core'
import type { Observer } from '@babylonjs/core/Misc/observable'
import type { PointerInfo } from '@babylonjs/core/Events/pointerEvents'
import { LinesMesh } from '@babylonjs/core/Meshes/linesMesh'
import { GaussianSplattingMesh } from '@babylonjs/core/Meshes/GaussianSplatting/gaussianSplattingMesh'
import { AxesViewer } from '@babylonjs/core/Debug/axesViewer'
import { RotationGizmo } from '@babylonjs/core/Gizmos/rotationGizmo'
import { PositionGizmo } from '@babylonjs/core/Gizmos/positionGizmo'
import { ScaleGizmo } from '@babylonjs/core/Gizmos/scaleGizmo'
import { UtilityLayerRenderer } from '@babylonjs/core/Rendering/utilityLayerRenderer'
import { ImportMeshAsync } from '@babylonjs/core/Loading/sceneLoader'
import { registerBuiltInLoaders } from "@babylonjs/loaders/dynamic";
import { useAppStore } from '@/stores/appStore'
import { useSceneStore } from '@/stores/sceneStore'
import { useEditorStore, type GizmoType, type Transform } from '@/stores/editorStore'
import type { ColmapPreviewData, CameraPreview, Point3D } from '@/services/BackendApi'
import { initViewCube, disposeViewCube, setViewCubeVisible } from '@/composables/useViewCube'

registerBuiltInLoaders();  
// Types for multi-view capture
export interface CapturedView {
  filename: string
  dataUrl: string  // base64 PNG data URL
  width: number
  height: number
  transformMatrix: number[]  // 4x4 combined view*projection matrix as flat array
  cameraPosition: { x: number; y: number; z: number }
}

let engine: Engine | null = null
let scene: Scene | null = null
let flyCamera: UniversalCamera | null = null
let orbitCamera: ArcRotateCamera | null = null
let activeCamera: UniversalCamera | ArcRotateCamera | null = null
let debugMesh: any = null

// Multi-splat storage - keyed by object ID
const splats = new Map<string, GaussianSplattingMesh>()
const workingBlobs = new Map<string, Blob>() // Current working state (updated by operations)
const originalBlobs = new Map<string, Blob>() // Pristine original files for restore
const originalFileNames = new Map<string, string>()
const positionCaches = new Map<string, Float32Array>()
const splatCounts = new Map<string, number>()
const splatFlipStates = new Map<string, boolean>() // Track if splat was Y-flipped

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

// Current splat bounding radius for dynamic zoom speed
let currentSplatRadius = 10

// Clipping sphere
let clipSphereMesh: LinesMesh | null = null
let clipSphereGizmo: PositionGizmo | null = null

// Clipping box
let clipBoxMesh: LinesMesh | null = null
let clipBoxGizmo: PositionGizmo | null = null

// Selection brush and point cloud
let selectionBrushMesh: Mesh | null = null
let selectionPointCloud: Mesh | null = null
let selectionPointerObserver: Observer<PointerInfo> | null = null
let isSelectionPainting = false

// Double-right-click detection for clearing selection
let lastRightClickTime: number = 0
let globalPointerObserver: Observer<PointerInfo> | null = null

// Selection transform proxy - invisible mesh for gizmo attachment when selection exists
let selectionProxyMesh: Mesh | null = null
let selectionInitialCenter: Vector3 | null = null
let selectionInitialTransform: { position: Vector3; rotation: Quaternion; scale: Vector3 } | null = null

// Custom camera control state - velocity-based for smooth impulse movement
const cameraVelocity = {
  forward: 0,    // W/S
  right: 0,      // A/D
  up: 0,         // R/F
  rollVel: 0,    // Q/E
}

// Y-flip prompt state - set when a user imports a PLY/SPZ file
const pendingYFlipObjectId = ref<string | null>(null)

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

// Waypoint markers - camera frustum widgets in 3D space
const waypointMarkers = new Map<string, Mesh>()  // keyed by waypoint ID
const waypointTargetSpheres = new Map<string, Mesh>()  // target spheres for waypoints
let waypointMarkersVisible = true

export function useBabylon() {
  const isReady = ref(false)
  const appStore = useAppStore()
  const sceneStore = useSceneStore()
  const editorStore = useEditorStore()

  // Helper functions to access active splat data
  function getActiveSplat(): GaussianSplattingMesh | null {
    const id = editorStore.activeObjectId
    if (!id) return null
    return splats.get(id) || null
  }

  function getActiveBlob(): Blob | null {
    const id = editorStore.activeObjectId
    if (!id) return null
    return workingBlobs.get(id) || null
  }

  function getActiveFileName(): string | null {
    const id = editorStore.activeObjectId
    if (!id) return null
    return originalFileNames.get(id) || null
  }

  function getActivePositions(): Float32Array | null {
    const id = editorStore.activeObjectId
    if (!id) return null
    return positionCaches.get(id) || null
  }

  function getActiveSplatCount(): number {
    const id = editorStore.activeObjectId
    if (!id) return 0
    return splatCounts.get(id) || 0
  }

  // Store data for a specific splat by ID
  function storeSplatData(id: string, blob: Blob, fileName: string) {
    originalBlobs.set(id, blob)
    originalFileNames.set(id, fileName)
  }

  function initScene(canvas: HTMLCanvasElement) {
    // Create engine - using Babylon sandbox settings for proper splat rendering
    engine = new Engine(canvas, true, {
      useHighPrecisionMatrix: true,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
      antialias: true,
      stencil: false,
      powerPreference: 'high-performance'
    })

    // Create scene with optimizations
    scene = new Scene(engine)
    scene.clearColor = new Color4(0.051, 0.051, 0.071, 1) // #0D0D12
    
    // Critical for gaussian splat rendering - prevents incorrect culling
    scene.skipFrustumClipping = true
    
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
    orbitCamera.lowerRadiusLimit = orbitCamera.minZ  // Match minimum distance to near clipping plane
    orbitCamera.upperRadiusLimit = 200
    
    // Use natural zoom - zoom speed is proportional to distance (faster when far, slower when close)
    orbitCamera.useNaturalPinchZoom = true
    
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
    
    // Track all keys for custom movement (both fly and orbit cameras)
    scene.onKeyboardObservable.add((kbInfo) => {
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
    
    // Apply velocity-based movement each frame (both cameras)
    scene.onBeforeRenderObservable.add(() => {
      if (editorStore.cameraMode === 'fly' && flyCamera && flyCamera.rotationQuaternion) {
        // FLY CAMERA MODE - move camera position
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
      } else if (editorStore.cameraMode === 'orbit' && orbitCamera) {
        // ORBIT CAMERA MODE - move target (origin) in camera view direction
        // Calculate view direction vectors from orbit camera
        const cameraDirection = orbitCamera.position.subtract(orbitCamera.target).normalize()
        const forward = cameraDirection.scale(-1) // Forward is opposite of camera direction
        const right = Vector3.Cross(cameraDirection, Vector3.Up()).normalize()
        const up = Vector3.Up()
        
        // Movement speed scaled by distance for more natural feel
        const moveSpeed = Math.max(orbitCamera.radius * 0.05, 0.1)
        
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
        
        // Move target based on velocities
        if (Math.abs(cameraVelocity.forward) > 0.0001) {
          orbitCamera.target.addInPlace(forward.scale(cameraVelocity.forward * moveSpeed))
        }
        if (Math.abs(cameraVelocity.right) > 0.0001) {
          orbitCamera.target.addInPlace(right.scale(cameraVelocity.right * moveSpeed))
        }
        if (Math.abs(cameraVelocity.up) > 0.0001) {
          orbitCamera.target.addInPlace(up.scale(cameraVelocity.up * moveSpeed))
        }
        
        // Apply damping
        if (!keysPressed.forward && !keysPressed.backward) {
          cameraVelocity.forward *= damping
        }
        if (!keysPressed.left && !keysPressed.right) {
          cameraVelocity.right *= damping
        }
        if (!keysPressed.moveUp && !keysPressed.moveDown) {
          cameraVelocity.up *= damping
        }
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

    // Add inspector keyboard shortcut (Ctrl+Shift+I or Cmd+Shift+I)
    window.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key === 'I') {
        event.preventDefault()
        if (scene) {
          if (scene.debugLayer.isVisible()) {
            scene.debugLayer.hide()
          } else {
            scene.debugLayer.show({
              embedMode: true,
              handleResize: true,
              overlay: true
            })
          }
        }
      }
    })

    isReady.value = true
    console.log('[Babylon] Scene initialized with performance optimizations')
    console.log('[Babylon] Press Ctrl+Shift+I to toggle inspector')

    // Watch for file changes
    watch(() => appStore.currentFile, async (file, oldFile) => {
      if (file) {
        // Check if this file is already loaded (same URL or splat already exists) to prevent duplicate loads
        const isSameFile = oldFile && oldFile.url === file.url
        
        // Also check if we already have a splat loaded (for SQPZ imports that load directly)
        const hasSplat = splats.size > 0 && editorStore.activeObjectId
        
        if (isSameFile) {
          console.log('[Babylon] File already loaded (same URL), skipping duplicate load')
          return
        }
        
        if (hasSplat && file.skipFlipPrompt) {
          // SQPZ import already loaded the splat directly - don't reload
          console.log('[Babylon] Splat already loaded by SQPZ import, skipping watcher load')
          return
        }
        
        // Pass isPreview and skipFlipPrompt flags to loadSplat
        await loadSplat(file.url, file.name, file.isPreview, false, undefined, file.skipFlipPrompt)
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

    // Selection watchers
    watch(() => editorStore.selection.brushEnabled, (enabled) => {
      setSelectionBrushVisible(enabled)
      if (enabled) {
        setupSelectionPointerObservable()
      } else {
        removeSelectionPointerObservable()
        isSelectionPainting = false
      }
    })

    watch(() => editorStore.selection.brushRadius, (radius) => {
      updateSelectionBrushRadius(radius)
    })

    watch(() => editorStore.selection.indices.size, (newSize, oldSize) => {
      updateSelectionPointCloud()
      
      // Refresh gizmo attachment when selection state changes (has selection ↔ no selection)
      const wasSelected = (oldSize || 0) > 0
      const isSelected = newSize > 0
      
      if (wasSelected !== isSelected && editorStore.activeGizmo !== 'none') {
        // Selection state changed - re-attach gizmo to correct target
        setActiveGizmo(editorStore.activeGizmo)
      }
    })

    // Setup global pointer observer for double-right-click to clear selection
    setupGlobalPointerObservable()
  }

  /**
   * Setup global pointer observable for features that work regardless of brush state
   * Currently handles: double-right-click to clear selection
   */
  function setupGlobalPointerObservable() {
    if (!scene) return

    // Remove existing observer if any
    if (globalPointerObserver) {
      scene.onPointerObservable.remove(globalPointerObserver)
      globalPointerObserver = null
    }

    globalPointerObserver = scene.onPointerObservable.add((pointerInfo) => {
      if (pointerInfo.type !== PointerEventTypes.POINTERDOWN) return

      const evt = pointerInfo.event as PointerEvent
      
      // Check for right mouse button (button === 2)
      if (evt.button === 2) {
        const now = Date.now()
        const timeSinceLastClick = now - lastRightClickTime
        
        // Double-click detected (within 300ms)
        if (timeSinceLastClick < 300 && editorStore.hasSelection) {
          console.log('[Babylon] Double-right-click detected - clearing selection')
          editorStore.clearSelection()
          clearSelectionPointCloud()
          
          // Reset timer to prevent triple-click triggering another clear
          lastRightClickTime = 0
        } else {
          lastRightClickTime = now
        }
      }
    })

    console.log('[Babylon] Global pointer observable setup (double-right-click to clear selection)')
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

    // Create selection brush
    createSelectionBrush()

    // Create view cube (camera orientation gizmo)
    initViewCube(scene!, engine!)

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

    const currentSplat = getActiveSplat()

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
      disposeSelectionProxy()
      console.log('[Babylon] Gizmos cleared')
      return
    }

    // Check if we have a selection - if so, gizmo attaches to proxy mesh
    const hasSelection = editorStore.hasSelection

    // Determine if we should use local space (true) or world space (false)
    const useLocalSpace = editorStore.transformSpace === 'local'

    // Determine which mesh to attach gizmo to
    let targetMesh: Mesh | GaussianSplattingMesh | null = currentSplat

    if (hasSelection) {
      // Create/update proxy mesh at selection center
      if (!createOrUpdateSelectionProxy()) {
        console.warn('[Babylon] Failed to create selection proxy - no valid selection')
        return
      }
      targetMesh = selectionProxyMesh
      console.log('[Babylon] Gizmo will attach to selection proxy')
    } else {
      // No selection - clean up any existing proxy
      disposeSelectionProxy()
    }

    if (!targetMesh) {
      console.warn('[Babylon] No target mesh for gizmo')
      return
    }

    // Helper to capture transform before drag starts
    const captureTransformBeforeDrag = () => {
      // Disable camera controls during gizmo drag to prevent camera movement
      if (scene) {
        const canvas = scene.getEngine().getRenderingCanvas()
        if (canvas) {
          if (orbitCamera) orbitCamera.detachControl()
          if (flyCamera) flyCamera.detachControl()
        }
      }
      
      if (hasSelection) {
        captureSelectionProxyTransform()
      } else {
        transformBeforeDrag = editorStore.getTransformSnapshot()
      }
    }

    // Helper for handling drag updates (for selection preview)
    const onDragUpdate = () => {
      if (hasSelection && selectionProxyMesh && selectionInitialTransform) {
        updateSelectionPointCloudFromProxy()
      }
    }

    // Helper to sync transform and create undo command / apply selection transform
    const syncAndCreateCommand = async () => {
      // Re-enable camera controls after gizmo drag
      if (scene) {
        const canvas = scene.getEngine().getRenderingCanvas()
        if (canvas) {
          const activeCamera = scene.activeCamera
          if (activeCamera === orbitCamera && orbitCamera) {
            orbitCamera.attachControl(canvas, true)
          } else if (activeCamera === flyCamera && flyCamera) {
            flyCamera.attachControl(canvas, true)
          }
        }
      }
      
      if (hasSelection) {
        // Apply transform to selected splats
        await applySelectionProxyTransform()
      } else {
        // Standard mesh transform behavior
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
    }

    // Create the appropriate gizmo
    switch (gizmoType) {
      case 'rotate':
        rotationGizmo = new RotationGizmo(utilityLayer)
        rotationGizmo.attachedMesh = targetMesh
        rotationGizmo.updateGizmoRotationToMatchAttachedMesh = useLocalSpace
        rotationGizmo.onDragStartObservable.add(captureTransformBeforeDrag)
        rotationGizmo.onDragObservable.add(onDragUpdate)
        rotationGizmo.onDragEndObservable.add(syncAndCreateCommand)
        console.log('[Babylon] Rotation gizmo attached to', hasSelection ? 'selection proxy' : 'splat', ', local:', useLocalSpace)
        break

      case 'translate':
        positionGizmo = new PositionGizmo(utilityLayer)
        positionGizmo.attachedMesh = targetMesh
        positionGizmo.updateGizmoRotationToMatchAttachedMesh = useLocalSpace
        positionGizmo.onDragStartObservable.add(captureTransformBeforeDrag)
        positionGizmo.onDragObservable.add(onDragUpdate)
        positionGizmo.onDragEndObservable.add(syncAndCreateCommand)
        console.log('[Babylon] Position gizmo attached to', hasSelection ? 'selection proxy' : 'splat', ', local:', useLocalSpace)
        break

      case 'scale':
        scaleGizmo = new ScaleGizmo(utilityLayer)
        scaleGizmo.attachedMesh = targetMesh
        scaleGizmo.onDragStartObservable.add(captureTransformBeforeDrag)
        scaleGizmo.onDragObservable.add(onDragUpdate)
        scaleGizmo.onDragEndObservable.add(syncAndCreateCommand)
        console.log('[Babylon] Scale gizmo attached to', hasSelection ? 'selection proxy' : 'splat')
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

  /**
   * Sync the current mesh transform to the editor store.
   * This reads the actual Vector3 values from the Babylon mesh.
   */
  function syncTransformToStore() {
    const currentSplat = getActiveSplat()
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

  /**
   * Get the current transform directly from the mesh (source of truth)
   */
  function getMeshTransform(): Transform | null {
    const currentSplat = getActiveSplat()
    if (!currentSplat) return null

    const pos = currentSplat.position
    const rot = currentSplat.rotation
    const scl = currentSplat.scaling

    return {
      position: { x: pos.x, y: pos.y, z: pos.z },
      rotation: { 
        x: rot.x * (180 / Math.PI), 
        y: rot.y * (180 / Math.PI), 
        z: rot.z * (180 / Math.PI) 
      },
      scale: { x: scl.x, y: scl.y, z: scl.z }
    }
  }

  function applySplatTransform(position?: { x: number; y: number; z: number }, rotation?: { x: number; y: number; z: number }, scale?: { x: number; y: number; z: number }) {
    const currentSplat = getActiveSplat()
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
    const currentSplat = getActiveSplat()
    if (!currentSplat) return

    currentSplat.position = Vector3.Zero()
    currentSplat.rotation = Vector3.Zero()
    currentSplat.scaling = new Vector3(1, 1, 1)
    
    editorStore.resetTransform()
    console.log('[Babylon] Splat transform reset')
  }

  function rotateSplat90(axis: 'x' | 'y' | 'z') {
    const currentSplat = getActiveSplat()
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
    const currentSplat = getActiveSplat()
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
      
      // Disable camera controls during drag
      clipSphereGizmo.onDragStartObservable.add(() => {
        if (scene) {
          const canvas = scene.getEngine().getRenderingCanvas()
          if (canvas) {
            if (orbitCamera) orbitCamera.detachControl()
            if (flyCamera) flyCamera.detachControl()
          }
        }
      })
      
      clipSphereGizmo.onDragEndObservable.add(() => {
        // Re-enable camera controls
        if (scene) {
          const canvas = scene.getEngine().getRenderingCanvas()
          if (canvas) {
            const activeCamera = scene.activeCamera
            if (activeCamera === orbitCamera && orbitCamera) {
              orbitCamera.attachControl(canvas, true)
            } else if (activeCamera === flyCamera && flyCamera) {
              flyCamera.attachControl(canvas, true)
            }
          }
        }
        
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
      
      // Disable camera controls during drag
      clipBoxGizmo.onDragStartObservable.add(() => {
        if (scene) {
          const canvas = scene.getEngine().getRenderingCanvas()
          if (canvas) {
            if (orbitCamera) orbitCamera.detachControl()
            if (flyCamera) flyCamera.detachControl()
          }
        }
      })
      
      clipBoxGizmo.onDragEndObservable.add(() => {
        // Re-enable camera controls
        if (scene) {
          const canvas = scene.getEngine().getRenderingCanvas()
          if (canvas) {
            const activeCamera = scene.activeCamera
            if (activeCamera === orbitCamera && orbitCamera) {
              orbitCamera.attachControl(canvas, true)
            } else if (activeCamera === flyCamera && flyCamera) {
              flyCamera.attachControl(canvas, true)
            }
          }
        }
        
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
    const originalFileBlob = getActiveBlob()
    const currentSplat = getActiveSplat()
    
    if (!originalFileBlob || !scene) {
      console.error('[Babylon] No original file to clip')
      return null
    }

    const center = editorStore.clipBox.center
    const size = editorStore.clipBox.size

    // Calculate half extents for AABB test
    let localCenter = { x: center.x, y: center.y, z: center.z }
    let localHalfSize = { x: size.x * 0.5, y: size.y * 0.5, z: size.z * 0.5 }
    let applyYNegation = false  // Whether to negate Y when reading file data

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
        
        // If mesh has negative Y scale, the local center is already in flipped space
        applyYNegation = meshScale.y >= 0
      } else {
        // Mesh at identity: Babylon applies Y negation during PLY load
        applyYNegation = true
        console.log('[Babylon] Mesh at identity transform, using world coordinates directly')
      }
    } else {
      // No mesh found, assume Y negation needed
      applyYNegation = true
    }

    console.log('[Babylon] Applying clip box:')
    console.log('  World center:', center.x, center.y, center.z)
    console.log('  Local center:', localCenter.x, localCenter.y, localCenter.z)
    console.log('  Half size:', localHalfSize.x, localHalfSize.y, localHalfSize.z)
    console.log('  Apply Y negation:', applyYNegation)

    try {
      // Read the original file
      const arrayBuffer = await originalFileBlob.arrayBuffer()
      const uint8 = new Uint8Array(arrayBuffer)

      // Detect format and parse
      const header = new TextDecoder().decode(uint8.slice(0, 100))
      
      if (header.startsWith('ply')) {
        return await clipPlyFileBox(uint8, localCenter, localHalfSize, applyYNegation)
      } else {
        return await clipSplatFileBox(uint8, localCenter, localHalfSize, applyYNegation)
      }
    } catch (e) {
      console.error('[Babylon] Failed to apply clip box:', e)
      return null
    }
  }

  async function clipPlyFileBox(
    data: Uint8Array, 
    center: { x: number; y: number; z: number },
    halfSize: { x: number; y: number; z: number },
    applyYNegation: boolean
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
      const rawY = dataView.getFloat32(offset + yProp.offset, true)
      const y = applyYNegation ? -rawY : rawY
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
    
    // Update the working file
    const activeId = editorStore.activeObjectId
    if (activeId) {
      const fileName = getActiveFileName() || 'clipped.ply'
      storeOriginalFile(activeId, clippedBlob, fileName)
    }
    
    const url = URL.createObjectURL(clippedBlob)
    const fileName = getActiveFileName() || 'clipped.ply'
    await loadSplat(url, fileName, false, true)
    URL.revokeObjectURL(url)

    // CRITICAL: Update position cache after crop so brush tool stays in sync
    if (activeId) {
      await cacheSplatPositions(activeId)
    }

    return { originalCount, clippedCount }
  }

  async function clipSplatFileBox(
    data: Uint8Array,
    center: { x: number; y: number; z: number },
    halfSize: { x: number; y: number; z: number },
    applyYNegation: boolean
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
      const rawY = dataView.getFloat32(offset + 4, true)
      const y = applyYNegation ? -rawY : rawY
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
    
    // Update the working file
    const activeId = editorStore.activeObjectId
    if (activeId) {
      const fileName = getActiveFileName() || 'clipped.splat'
      storeOriginalFile(activeId, clippedBlob, fileName)
    }
    
    const url = URL.createObjectURL(clippedBlob)
    const fileName = getActiveFileName() || 'clipped.splat'
    await loadSplat(url, fileName, false, true)
    URL.revokeObjectURL(url)

    // CRITICAL: Update position cache after crop so brush tool stays in sync
    if (activeId) {
      await cacheSplatPositions(activeId)
    }

    return { originalCount, clippedCount }
  }

  function storeOriginalFile(id: string, blob: Blob, name: string) {
    workingBlobs.set(id, blob)
    originalFileNames.set(id, name)
    // Store pristine original blob only if we don't have one yet (first load)
    if (!originalBlobs.has(id)) {
      originalBlobs.set(id, blob)
      console.log('[Babylon] Pristine original file stored for', id, ':', name, blob.size, 'bytes')
    }
    console.log('[Babylon] Working file stored for', id, ':', name, blob.size, 'bytes')
  }

  /**
   * Get the current working file (with all modifications like crops, deletions, etc.)
   * NOTE: Despite the name "getOriginalFile", this returns the WORKING blob, not the pristine original.
   * For the pristine original, use originalBlobs.get(id) directly.
   */
  function getOriginalFile(id?: string): { blob: Blob; name: string } | null {
    const targetId = id || editorStore.activeObjectId
    if (!targetId) return null
    const blob = workingBlobs.get(targetId)
    const name = originalFileNames.get(targetId)
    if (blob && name) {
      return { blob, name }
    }
    return null
  }

  async function restoreToOriginal(): Promise<boolean> {
    const activeId = editorStore.activeObjectId
    if (!activeId) {
      console.error('[Babylon] No active object to restore')
      return false
    }

    const pristineBlob = originalBlobs.get(activeId)
    const originalName = originalFileNames.get(activeId)
    
    if (!pristineBlob || !originalName) {
      console.error('[Babylon] No original file found to restore')
      return false
    }

    console.log('[Babylon] Restoring to original:', originalName, pristineBlob.size, 'bytes')

    // Restore the working blob to the pristine original
    workingBlobs.set(activeId, pristineBlob)

    // Reload the splat from the pristine original blob
    const url = URL.createObjectURL(pristineBlob)
    await loadSplat(url, originalName, false, true)
    URL.revokeObjectURL(url)

    // CRITICAL: Update position cache after restore so brush tool stays in sync
    await cacheSplatPositions(activeId)

    console.log('[Babylon] Restored to original successfully')
    return true
  }

  async function applyClipSphere(): Promise<{ originalCount: number; clippedCount: number } | null> {
    const originalFileBlob = getActiveBlob()
    const currentSplat = getActiveSplat()
    
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
    let applyYNegation = false  // Whether to negate Y when reading file data

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
        
        // If mesh has negative Y scale, the local center is already in flipped space
        // So we should NOT apply Y negation when reading file data
        applyYNegation = meshScale.y >= 0
      } else {
        // Mesh at identity: Babylon applies Y negation during PLY load, so we need to match it
        applyYNegation = true
        console.log('[Babylon] Mesh at identity transform, using world coordinates directly')
      }
    } else {
      // No mesh found, assume Y negation needed
      applyYNegation = true
    }

    const radiusSq = localRadius * localRadius

    console.log('[Babylon] Applying clip sphere:')
    console.log('  World center:', center.x, center.y, center.z)
    console.log('  Local center:', localCenter.x, localCenter.y, localCenter.z)
    console.log('  Radius:', localRadius)
    console.log('  Apply Y negation:', applyYNegation)

    try {
      // Read the original file
      const arrayBuffer = await originalFileBlob.arrayBuffer()
      const uint8 = new Uint8Array(arrayBuffer)

      // Detect format and parse
      const header = new TextDecoder().decode(uint8.slice(0, 100))
      
      if (header.startsWith('ply')) {
        // PLY format
        return await clipPlyFile(uint8, localCenter, radiusSq, applyYNegation)
      } else {
        // Assume .splat format (32 bytes per splat)
        return await clipSplatFile(uint8, localCenter, radiusSq, applyYNegation)
      }
    } catch (e) {
      console.error('[Babylon] Failed to apply clip sphere:', e)
      return null
    }
  }

  async function clipPlyFile(
    data: Uint8Array, 
    center: { x: number; y: number; z: number },
    radiusSq: number,
    applyYNegation: boolean
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
      const sampleY = applyYNegation ? -rawY : rawY
      const sampleZ = dataView.getFloat32(sampleOffset + zProp.offset, true)
      console.log('[Babylon] PLY first vertex - raw Y:', rawY, '-> transformed:', sampleX, sampleY, sampleZ, '(Y negation:', applyYNegation, ')')
      
      // Find bounding box of all vertices (with Y negation)
      let minX = Infinity, minY = Infinity, minZ = Infinity
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
      for (let i = 0; i < Math.min(originalCount, 1000); i++) {
        const offset = i * vertexSize
        const x = dataView.getFloat32(offset + xProp.offset, true)
        const rawY = dataView.getFloat32(offset + yProp.offset, true)
        const y = applyYNegation ? -rawY : rawY
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
    // We apply Y negation only if the mesh doesn't already have negative Y scale
    const insideIndices: number[] = []
    
    for (let i = 0; i < originalCount; i++) {
      const offset = i * vertexSize
      const x = dataView.getFloat32(offset + xProp.offset, true)
      const rawY = dataView.getFloat32(offset + yProp.offset, true)
      const y = applyYNegation ? -rawY : rawY
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
    
    // Update the working file
    const activeId = editorStore.activeObjectId
    if (activeId) {
      const fileName = getActiveFileName() || 'clipped.ply'
      storeOriginalFile(activeId, clippedBlob, fileName)
    }
    
    const url = URL.createObjectURL(clippedBlob)
    const fileName = getActiveFileName() || 'clipped.ply'
    await loadSplat(url, fileName, false, true)
    URL.revokeObjectURL(url)

    // CRITICAL: Update position cache after crop so brush tool stays in sync
    if (activeId) {
      await cacheSplatPositions(activeId)
    }

    return { originalCount, clippedCount }
  }

  async function clipSplatFile(
    data: Uint8Array,
    center: { x: number; y: number; z: number },
    radiusSq: number,
    applyYNegation: boolean
  ): Promise<{ originalCount: number; clippedCount: number }> {
    const bytesPerSplat = 32
    const originalCount = Math.floor(data.length / bytesPerSplat)
    const dataView = new DataView(data.buffer, data.byteOffset)

    // Find splats inside sphere
    // Apply Y negation only if the mesh doesn't already have negative Y scale
    const insideIndices: number[] = []
    
    for (let i = 0; i < originalCount; i++) {
      const offset = i * bytesPerSplat
      const x = dataView.getFloat32(offset, true)
      const rawY = dataView.getFloat32(offset + 4, true)
      const y = applyYNegation ? -rawY : rawY
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
    
    // Update the working file
    const activeId = editorStore.activeObjectId
    if (activeId) {
      const fileName = getActiveFileName() || 'clipped.splat'
      storeOriginalFile(activeId, clippedBlob, fileName)
    }
    
    const url = URL.createObjectURL(clippedBlob)
    const fileName = getActiveFileName() || 'clipped.splat'
    await loadSplat(url, fileName, false, true)
    URL.revokeObjectURL(url)

    // CRITICAL: Update position cache after crop so brush tool stays in sync
    if (activeId) {
      await cacheSplatPositions(activeId)
    }

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
  async function bakeTransformToVertices(): Promise<boolean> {
    const currentSplat = getActiveSplat()
    if (!currentSplat) {
      console.error('[Babylon] No splat loaded to bake transform')
      return false
    }

    const meshPos = currentSplat.position.clone()
    const meshRot = currentSplat.rotation.clone()
    const meshScale = currentSplat.scaling.clone()
    const meshRotQuat = currentSplat.rotationQuaternion?.clone()

    // Check if there's any transform to bake
    // NOTE: Ignore Y scale of -1, which is Babylon's coordinate system conversion for PLY files
    const hasPosition = meshPos.x !== 0 || meshPos.y !== 0 || meshPos.z !== 0
    const hasRotation = meshRot.x !== 0 || meshRot.y !== 0 || meshRot.z !== 0
    const hasScale = (meshScale.x !== 1 || meshScale.z !== 1) || (meshScale.y !== 1 && meshScale.y !== -1)
    const hasTransform = hasPosition || hasRotation || hasScale

    if (!hasTransform) {
      console.log('[Babylon] No user transform to bake (only coordinate system conversion)')
      return true
    }

    console.log('[Babylon] Baking transform into vertices:')
    console.log('  Position:', meshPos.x, meshPos.y, meshPos.z)
    console.log('  Rotation (euler):', meshRot.x, meshRot.y, meshRot.z)
    console.log('  Rotation (quat):', meshRotQuat)
    console.log('  Scale:', meshScale.x, meshScale.y, meshScale.z)
    console.log('  Has rotationQuaternion:', !!currentSplat.rotationQuaternion)

    try {
      // Use Babylon's built-in method to bake transform into vertex buffers
      try {
        currentSplat.bakeCurrentTransformIntoVertices()
        console.log('[Babylon] bakeCurrentTransformIntoVertices succeeded')
      } catch (bakeError: any) {
        console.error('[Babylon] bakeCurrentTransformIntoVertices failed:', bakeError?.message || bakeError)
        throw new Error('Bake failed - splat data must be kept in RAM. This is a bug with the keepInRam plugin option.')
      }
      
      // Explicitly ensure mesh is at identity after baking
      // CRITICAL: Must set rotationQuaternion to null first, or rotation won't take effect
      currentSplat.rotationQuaternion = null
      currentSplat.position = Vector3.Zero()
      currentSplat.rotation = Vector3.Zero()
      currentSplat.scaling = new Vector3(1, 1, 1)
      
      console.log('[Babylon] After reset - position:', currentSplat.position, 'rotation:', currentSplat.rotation, 'rotationQuaternion:', currentSplat.rotationQuaternion)
      
      // Reset the editor store transform (the mesh transform is now identity)
      // NOTE: Position cache is rebuilt by exportBakedMeshToWorkingBlob via cacheSplatPositions
      editorStore.resetTransform()
      
      // Verify mesh state after full reset
      console.log('[Babylon] Transform baked successfully')
      console.log('  Final mesh state:')
      console.log('    Position:', currentSplat.position.x, currentSplat.position.y, currentSplat.position.z)
      console.log('    Rotation:', currentSplat.rotation.x, currentSplat.rotation.y, currentSplat.rotation.z)
      console.log('    RotationQuaternion:', currentSplat.rotationQuaternion)
      console.log('    Scale:', currentSplat.scaling.x, currentSplat.scaling.y, currentSplat.scaling.z)
      console.log('  Store state:')
      console.log('    Position:', editorStore.splatTransform.position)
      console.log('    Rotation:', editorStore.splatTransform.rotation)
      console.log('    Scale:', editorStore.splatTransform.scale)
      
      // Force sync to make sure everything is consistent
      setTimeout(() => {
        console.log('[Babylon] Checking mesh state 100ms after bake:')
        console.log('    Position:', currentSplat.position.x, currentSplat.position.y, currentSplat.position.z)
        console.log('    Rotation:', currentSplat.rotation.x, currentSplat.rotation.y, currentSplat.rotation.z)
        console.log('    RotationQuaternion:', currentSplat.rotationQuaternion)
      }, 100)
      
      // Export the baked mesh data back to workingBlobs so crop operations use the baked data
      // This also converts from Babylon space to file convention (Y negation) and re-caches positions
      const activeId = editorStore.activeObjectId
      if (activeId) {
        const success = await exportBakedMeshToWorkingBlob(activeId, currentSplat)
        if (!success) {
          console.warn('[Babylon] Failed to export baked data to working blob - crops may use old data')
        }
      }
      
      return true
    } catch (e) {
      console.error('[Babylon] Failed to bake transform:', e)
      return false
    }
  }

  /**
   * Auto-flip Y axis and bake for imported PLY/SPZ files.
   * Sets scaling.y = 1, rotates Z by 180 degrees, then bakes the transform.
   */
  async function autoFlipAndBake(): Promise<boolean> {
    const objectId = pendingYFlipObjectId.value
    pendingYFlipObjectId.value = null
    
    if (!objectId) {
      console.warn('[Babylon] No pending Y-flip object')
      return false
    }

    const mesh = splats.get(objectId)
    if (!mesh) {
      console.warn('[Babylon] Mesh not found for Y-flip:', objectId)
      return false
    }

    console.log('[Babylon] Auto-flipping Y axis and baking for', objectId)

    // Negate the -Y scaling (set to +1)
    mesh.scaling.y = 1

    // Rotate Z by 180 degrees to compensate
    mesh.rotation.z = Math.PI

    // Sync to the store so bake sees the correct state
    syncTransformToStore()

    // Bake the transform into vertex data
    const result = await bakeTransformToVertices()
    
    if (result) {
      // Mark this splat as flipped so we can track it in SQPZ export
      splatFlipStates.set(objectId, true)
      console.log('[Babylon] Auto Y-flip and bake completed successfully - marked as flipped')
      // Re-focus camera after transform
      focusCamera()
    } else {
      console.error('[Babylon] Auto Y-flip and bake failed')
    }

    return result
  }

  /**
   * Re-apply flip after internal reload (for operations like clip/delete)
   * Called automatically after reloading a splat that was previously flipped
   */
  async function reapplyFlipAfterReload(objectId: string): Promise<boolean> {
    const wasFlipped = splatFlipStates.get(objectId)
    if (!wasFlipped) {
      return true // Nothing to do
    }

    const mesh = splats.get(objectId)
    if (!mesh) {
      console.warn('[Babylon] Mesh not found for re-flip:', objectId)
      return false
    }

    // Check if the mesh has the -Y scale from Babylon's loader
    if (mesh.scaling.y >= 0) {
      console.log('[Babylon] Mesh already has positive Y scale, skipping re-flip')
      return true
    }

    console.log('[Babylon] Re-applying flip after reload for', objectId)

    // Apply the same flip transform
    mesh.scaling.y = 1
    mesh.rotation.z = Math.PI
    syncTransformToStore()

    // Bake it again
    const result = await bakeTransformToVertices()
    
    if (result) {
      console.log('[Babylon] Re-flip and bake completed after reload')
    } else {
      console.error('[Babylon] Re-flip and bake failed after reload')
    }

    return result
  }

  /**
   * Dismiss the Y-flip prompt without applying
   */
  function dismissYFlipPrompt() {
    pendingYFlipObjectId.value = null
  }

  /**
   * Export the current mesh's baked vertex data back to a blob file
   * This ensures crop/delete operations work on the baked data
   */
  async function exportBakedMeshToWorkingBlob(id: string, mesh: GaussianSplattingMesh): Promise<boolean> {
    try {
      // Access the internal splat data
      const splatData = (mesh as any)._splatsData as ArrayBuffer
      if (!splatData) {
        console.error('[Babylon] Mesh does not have _splatsData - cannot export baked data')
        return false
      }

      const fileName = originalFileNames.get(id)
      if (!fileName) {
        console.error('[Babylon] No filename found for', id)
        return false
      }

      // Clone the buffer so we don't mutate the live mesh data
      const cloned = splatData.slice(0)
      const fView = new Float32Array(cloned)
      const uView = new Uint8Array(cloned)

      // Convert from Babylon display space back to file convention.
      // Babylon's loader applies scaling.y = -1 on import, so file convention
      // has Y opposite to Babylon's internal space after baking.
      // Internal splat format: 32 bytes per splat
      //   Bytes 0-11:  Float32 x, y, z  (position)
      //   Bytes 12-23: Float32 sx, sy, sz (scale)
      //   Bytes 24-27: Uint8 r, g, b, a  (color)
      //   Bytes 28-31: Uint8 w, x, y, z  (quaternion, mapped [-1,1] -> [0,255])
      const bytesPerSplat = 32
      const floatsPerSplat = bytesPerSplat / 4  // 8
      const splatCount = cloned.byteLength / bytesPerSplat

      for (let i = 0; i < splatCount; i++) {
        // Negate position Y (float32 at byte offset 4 = float index 1)
        fView[i * floatsPerSplat + 1] = -fView[i * floatsPerSplat + 1]

        // Adjust quaternion for Y-axis reflection:
        // Negate W (byte 28) and Y (byte 30) — mirrors Babylon's own
        // bakeTransformIntoVertices handling for negative Y scale.
        // For uint8 mapped from [-1,1] to [0,255]: negate = 255 - byte
        const byteBase = i * bytesPerSplat
        uView[byteBase + 28] = 255 - uView[byteBase + 28]  // W
        uView[byteBase + 30] = 255 - uView[byteBase + 30]  // Y
      }

      console.log('[Babylon] Converted', splatCount, 'splats from Babylon space to file convention (Y negated)')

      // Create a blob from the corrected data
      const blob = new Blob([cloned], { type: 'application/octet-stream' })
      
      // Update the working blob with the corrected data
      workingBlobs.set(id, blob)
      console.log('[Babylon] Exported baked mesh data to working blob:', blob.size, 'bytes')

      // Re-cache positions from the corrected blob so clipping/selection tools stay consistent
      await cacheSplatPositions(id)
      
      return true
    } catch (e) {
      console.error('[Babylon] Failed to export baked mesh to blob:', e)
      return false
    }
  }

  /**
   * Center the splat at the origin by computing the bounding box center
   * and offsetting all vertices.
   */
  async function centerAtOrigin(): Promise<boolean> {
    const currentSplat = getActiveSplat()
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
      return await bakeTransformToVertices()
    } catch (e) {
      console.error('[Babylon] Failed to center at origin:', e)
      return false
    }
  }

  // ============================================================
  // SELECTION BRUSH AND POINT CLOUD
  // ============================================================

  /**
   * Create the selection brush sphere (transparent)
   */
  function createSelectionBrush() {
    if (!scene) return

    // Dispose existing
    if (selectionBrushMesh) {
      selectionBrushMesh.dispose()
    }

    const radius = editorStore.selection.brushRadius

    // Create a semi-transparent sphere
    selectionBrushMesh = MeshBuilder.CreateSphere('selectionBrush', {
      diameter: radius * 2,
      segments: 24
    }, scene)

    const material = new StandardMaterial('selectionBrushMat', scene)
    material.diffuseColor = new Color3(0.2, 0.8, 1.0) // Cyan
    material.alpha = 0.3
    material.backFaceCulling = false
    selectionBrushMesh.material = material

    // Start hidden
    selectionBrushMesh.setEnabled(false)
    selectionBrushMesh.isPickable = false
  }

  /**
   * Show/hide the selection brush
   */
  function setSelectionBrushVisible(visible: boolean) {
    if (selectionBrushMesh) {
      selectionBrushMesh.setEnabled(visible)
    }
  }

  /**
   * Update the selection brush radius
   */
  function updateSelectionBrushRadius(radius: number) {
    if (!selectionBrushMesh || !scene) return

    // Recreate the sphere with new size
    const position = selectionBrushMesh.position.clone()
    const wasEnabled = selectionBrushMesh.isEnabled()

    selectionBrushMesh.dispose()

    selectionBrushMesh = MeshBuilder.CreateSphere('selectionBrush', {
      diameter: radius * 2,
      segments: 24
    }, scene)

    const material = new StandardMaterial('selectionBrushMat', scene)
    material.diffuseColor = new Color3(0.2, 0.8, 1.0)
    material.alpha = 0.3
    material.backFaceCulling = false
    selectionBrushMesh.material = material

    selectionBrushMesh.position = position
    selectionBrushMesh.setEnabled(wasEnabled)
    selectionBrushMesh.isPickable = false
  }

  /**
   * Position the selection brush at a specific world position
   */
  function setSelectionBrushPosition(x: number, y: number, z: number) {
    if (selectionBrushMesh) {
      selectionBrushMesh.position.set(x, y, z)
    }
  }

  /**
   * Find the nearest splat to a picking ray and return its position
   * Uses Babylon's scene.pick for proper coordinate handling
   */
  function findBrushPositionFromPointer(pointerX: number, pointerY: number): Vector3 | null {
    const posData = getSplatPositions()
    if (!scene || !activeCamera || !posData) {
      return null
    }
    
    const { positions: cachedSplatPositions, count: cachedSplatCount } = posData

    // Use scene.createPickingRay with the pointer coordinates
    // The scene automatically handles the coordinate transformation
    const ray = scene.createPickingRay(pointerX, pointerY, Matrix.Identity(), activeCamera)

    // Find the splat closest to the ray (smallest perpendicular distance)
    let closestPerpDistSq = Infinity
    let closestPosition: Vector3 | null = null
    const maxRayDist = 500 // Maximum distance along the ray to consider
    
    // Tight search radius - only consider splats very close to the ray
    // This makes the brush positioning much more accurate
    const maxPerpDist = 0.5 // Maximum perpendicular distance from ray to consider

    for (let i = 0; i < cachedSplatCount; i++) {
      const idx = i * 3
      const sx = cachedSplatPositions[idx]
      const sy = cachedSplatPositions[idx + 1]
      const sz = cachedSplatPositions[idx + 2]

      // Calculate distance from splat to ray using vector math
      // Vector from ray origin to splat
      const toSplatX = sx - ray.origin.x
      const toSplatY = sy - ray.origin.y
      const toSplatZ = sz - ray.origin.z

      // Project onto ray direction
      const projLength = toSplatX * ray.direction.x + toSplatY * ray.direction.y + toSplatZ * ray.direction.z
      
      // Skip if behind camera or too far
      if (projLength < 0.1 || projLength > maxRayDist) continue

      // Calculate perpendicular distance to ray
      const projX = ray.origin.x + ray.direction.x * projLength
      const projY = ray.origin.y + ray.direction.y * projLength
      const projZ = ray.origin.z + ray.direction.z * projLength
      
      const perpDistSq = (sx - projX) * (sx - projX) + (sy - projY) * (sy - projY) + (sz - projZ) * (sz - projZ)

      // Find the splat with the smallest perpendicular distance to the ray
      // This gives us the most accurate brush positioning
      if (perpDistSq < maxPerpDist * maxPerpDist && perpDistSq < closestPerpDistSq) {
        closestPerpDistSq = perpDistSq
        closestPosition = new Vector3(sx, sy, sz)
      }
    }

    return closestPosition
  }

  /**
   * Setup pointer observable for selection brush
   */
  function setupSelectionPointerObservable() {
    if (!scene) return

    // Remove existing observer
    if (selectionPointerObserver) {
      scene.onPointerObservable.remove(selectionPointerObserver)
      selectionPointerObserver = null
    }

    selectionPointerObserver = scene.onPointerObservable.add((pointerInfo) => {
      // Only handle if brush is enabled
      if (!editorStore.selection.brushEnabled) return

      const evt = pointerInfo.event as PointerEvent

      switch (pointerInfo.type) {
        case PointerEventTypes.POINTERMOVE: {
          // Update brush position
          const position = findBrushPositionFromPointer(scene!.pointerX, scene!.pointerY)
          if (selectionBrushMesh) {
            if (position) {
              // Found a splat within threshold - show brush at position
              selectionBrushMesh.setEnabled(true)
              selectionBrushMesh.position.copyFrom(position)
            } else {
              // No splat within threshold - hide brush
              selectionBrushMesh.setEnabled(false)
            }
          }

          // Paint if currently painting (only if we have a valid position)
          if (isSelectionPainting && position) {
            paintAtPosition(position)
          }
          break
        }

        case PointerEventTypes.POINTERDOWN: {
          if (evt.button === 0) { // Left mouse button
            isSelectionPainting = true
            
            // Disable camera controls while painting to prevent camera movement
            const canvas = scene!.getEngine().getRenderingCanvas()
            if (orbitCamera && canvas) {
              orbitCamera.detachControl()
            }
            if (flyCamera && canvas) {
              flyCamera.detachControl()
            }
            
            // Initial paint at current position
            const position = findBrushPositionFromPointer(scene!.pointerX, scene!.pointerY)
            if (position) {
              paintAtPosition(position)
            }
          }
          break
        }

        case PointerEventTypes.POINTERUP: {
          if (evt.button === 0) {
            isSelectionPainting = false
            
            // Re-enable camera controls after painting
            const canvas = scene!.getEngine().getRenderingCanvas()
            if (canvas) {
              const activeCamera = scene!.activeCamera
              if (activeCamera === orbitCamera && orbitCamera) {
                orbitCamera.attachControl(canvas, true)
              } else if (activeCamera === flyCamera && flyCamera) {
                flyCamera.attachControl(canvas, true)
              }
            }
          }
          break
        }
      }
    })

    console.log('[Babylon] Selection pointer observable setup')
  }

  /**
   * Paint selection at a specific world position
   */
  function paintAtPosition(position: Vector3) {
    const posData = getSplatPositions()
    if (!posData) return

    const { positions: cachedSplatPositions, count: cachedSplatCount } = posData
    const brushRadius = editorStore.selection.brushRadius
    const radiusSq = brushRadius * brushRadius
    const indices: number[] = []

    for (let i = 0; i < cachedSplatCount; i++) {
      const idx = i * 3
      const dx = cachedSplatPositions[idx] - position.x
      const dy = cachedSplatPositions[idx + 1] - position.y
      const dz = cachedSplatPositions[idx + 2] - position.z
      const distSq = dx * dx + dy * dy + dz * dz

      if (distSq <= radiusSq) {
        indices.push(i)
      }
    }

    if (indices.length > 0) {
      if (editorStore.selection.brushMode === 'add') {
        editorStore.addToSelection(indices)
      } else {
        editorStore.removeFromSelection(indices)
      }
    }
  }

  /**
   * Remove selection pointer observable
   */
  function removeSelectionPointerObservable() {
    if (scene && selectionPointerObserver) {
      scene.onPointerObservable.remove(selectionPointerObserver)
      selectionPointerObserver = null
    }
  }

  /**
   * Cache splat positions from the original file for fast lookups
   * Called after loading a splat file
   */
  async function cacheSplatPositions(id: string) {
    const blob = workingBlobs.get(id)
    if (!blob) {
      console.warn('[Babylon] No working file to cache positions from for', id)
      positionCaches.delete(id)
      splatCounts.delete(id)
      return
    }

    try {
      const arrayBuffer = await blob.arrayBuffer()
      const uint8 = new Uint8Array(arrayBuffer)
      const header = new TextDecoder().decode(uint8.slice(0, 100))

      if (header.startsWith('ply')) {
        await cachePlyPositions(id, uint8)
      } else {
        await cacheSplatFilePositions(id, uint8)
      }

      console.log('[Babylon] Cached', splatCounts.get(id), 'splat positions for', id)
    } catch (e) {
      console.error('[Babylon] Failed to cache splat positions for', id, ':', e)
      positionCaches.delete(id)
      splatCounts.delete(id)
    }
  }

  async function cachePlyPositions(id: string, data: Uint8Array) {
    const headerEnd = findPlyHeaderEnd(data)
    if (headerEnd < 0) {
      throw new Error('Invalid PLY file')
    }

    const headerStr = new TextDecoder().decode(data.slice(0, headerEnd))
    const vertexCountMatch = headerStr.match(/element vertex (\d+)/)
    if (!vertexCountMatch) {
      throw new Error('Invalid PLY file - no vertex count')
    }

    const vertexCount = parseInt(vertexCountMatch[1])
    const properties = parsePlyProperties(headerStr)
    const vertexSize = properties.reduce((sum, p) => sum + p.size, 0)

    const xProp = properties.find(p => p.name === 'x')
    const yProp = properties.find(p => p.name === 'y')
    const zProp = properties.find(p => p.name === 'z')

    if (!xProp || !yProp || !zProp) {
      throw new Error('PLY missing position properties')
    }

    const dataView = new DataView(data.buffer, data.byteOffset + headerEnd)
    const positions = new Float32Array(vertexCount * 3)

    for (let i = 0; i < vertexCount; i++) {
      const offset = i * vertexSize
      const x = dataView.getFloat32(offset + xProp.offset, true)
      // Negate Y to match Babylon's coordinate transform for PLY files
      // These positions are used in WORLD space by the brush tool
      const y = -dataView.getFloat32(offset + yProp.offset, true)
      const z = dataView.getFloat32(offset + zProp.offset, true)

      positions[i * 3] = x
      positions[i * 3 + 1] = y
      positions[i * 3 + 2] = z
    }

    positionCaches.set(id, positions)
    splatCounts.set(id, vertexCount)
  }

  async function cacheSplatFilePositions(id: string, data: Uint8Array) {
    const bytesPerSplat = 32
    const count = Math.floor(data.length / bytesPerSplat)
    const dataView = new DataView(data.buffer, data.byteOffset)

    const positions = new Float32Array(count * 3)

    for (let i = 0; i < count; i++) {
      const offset = i * bytesPerSplat
      const x = dataView.getFloat32(offset, true)
      // Negate Y to match Babylon's coordinate transform
      // These positions are used in WORLD space by the brush tool
      const y = -dataView.getFloat32(offset + 4, true)
      const z = dataView.getFloat32(offset + 8, true)

      positions[i * 3] = x
      positions[i * 3 + 1] = y
      positions[i * 3 + 2] = z
    }

    positionCaches.set(id, positions)
    splatCounts.set(id, count)
  }

  /**
   * Get the cached splat positions array for active object
   */
  function getSplatPositions(id?: string): { positions: Float32Array; count: number } | null {
    const targetId = id || editorStore.activeObjectId
    if (!targetId) return null
    const positions = positionCaches.get(targetId)
    const count = splatCounts.get(targetId)
    if (!positions || !count) {
      return null
    }
    return { positions, count }
  }

  /**
   * Create or update the selection point cloud to show selected splats
   */
  function updateSelectionPointCloud() {
    const posData = getSplatPositions()
    if (!scene || !posData) return

    const { positions: cachedSplatPositions, count: cachedSplatCount } = posData
    const selectedIndices = editorStore.selection.indices

    // Dispose existing
    if (selectionPointCloud) {
      selectionPointCloud.dispose()
      selectionPointCloud = null
    }

    if (selectedIndices.size === 0) {
      return
    }

    // Build positions array from selected indices
    const positions: number[] = []
    const colors: number[] = []
    
    for (const idx of selectedIndices) {
      if (idx >= 0 && idx < cachedSplatCount) {
        positions.push(
          cachedSplatPositions[idx * 3],
          cachedSplatPositions[idx * 3 + 1],
          cachedSplatPositions[idx * 3 + 2]
        )
        // Cyan highlight color with full opacity
        colors.push(0, 1, 1, 1)
      }
    }

    if (positions.length === 0) return

    // Create custom mesh for point cloud
    selectionPointCloud = new Mesh('selectionPointCloud', scene)
    
    // DON'T parent to splat mesh - cached positions are already in world space
    // Parenting would cause double-transformation and Y inversion
    
    const vertexData = new VertexData()
    vertexData.positions = positions
    vertexData.colors = colors
    
    // Create indices for points (each point is its own index)
    const indices: number[] = []
    for (let i = 0; i < positions.length / 3; i++) {
      indices.push(i)
    }
    vertexData.indices = indices
    
    vertexData.applyToMesh(selectionPointCloud)

    // Create point material
    const material = new StandardMaterial('selectionPointMat', scene)
    material.emissiveColor = new Color3(0, 1, 1) // Cyan glow
    material.disableLighting = true
    material.pointsCloud = true
    material.pointSize = 8
    
    selectionPointCloud.material = material
    selectionPointCloud.isPickable = false

    console.log('[Babylon] Updated selection point cloud with', selectedIndices.size, 'points')
  }

  /**
   * Clear the selection point cloud
   */
  function clearSelectionPointCloud() {
    if (selectionPointCloud) {
      // Point cloud is not parented, so no need to unparent
      selectionPointCloud.dispose()
      selectionPointCloud = null
    }
  }

  /**
   * Calculate the center of the current selection (bounding box center)
   */
  function getSelectionCenter(): Vector3 | null {
    const posData = getSplatPositions()
    if (!posData) {
      return null
    }

    const { positions: cachedSplatPositions, count: cachedSplatCount } = posData
    const selectedIndices = editorStore.selection.indices
    if (selectedIndices.size === 0) {
      return null
    }

    let minX = Infinity, minY = Infinity, minZ = Infinity
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity

    for (const idx of selectedIndices) {
      if (idx >= 0 && idx < cachedSplatCount) {
        const x = cachedSplatPositions[idx * 3]
        const y = cachedSplatPositions[idx * 3 + 1]
        const z = cachedSplatPositions[idx * 3 + 2]

        minX = Math.min(minX, x)
        minY = Math.min(minY, y)
        minZ = Math.min(minZ, z)
        maxX = Math.max(maxX, x)
        maxY = Math.max(maxY, y)
        maxZ = Math.max(maxZ, z)
      }
    }

    if (minX === Infinity) {
      return null
    }

    return new Vector3(
      (minX + maxX) * 0.5,
      (minY + maxY) * 0.5,
      (minZ + maxZ) * 0.5
    )
  }

  /**
   * Create or update the selection proxy mesh (invisible mesh used for gizmo attachment)
   */
  function createOrUpdateSelectionProxy(): boolean {
    if (!scene) return false

    const center = getSelectionCenter()
    if (!center) {
      disposeSelectionProxy()
      return false
    }

    // Create proxy mesh if it doesn't exist
    if (!selectionProxyMesh) {
      selectionProxyMesh = MeshBuilder.CreateBox('selectionProxy', { size: 0.01 }, scene)
      selectionProxyMesh.isVisible = false
      selectionProxyMesh.isPickable = false
    }

    // Make proxy a child of the splat mesh so gizmo operates in splat's local space
    // This ensures the rotation we get from the gizmo matches the PLY coordinate system
    const currentSplat = getActiveSplat()
    if (currentSplat && selectionProxyMesh.parent !== currentSplat) {
      selectionProxyMesh.parent = currentSplat
    }

    // Position proxy at selection center (in local space, since it's now a child of splat)
    selectionProxyMesh.position.copyFrom(center)
    selectionProxyMesh.rotationQuaternion = Quaternion.Identity()
    selectionProxyMesh.scaling.setAll(1)

    // Store initial center for transform calculations
    selectionInitialCenter = center.clone()

    console.log('[Babylon] Selection proxy created at:', center.x.toFixed(2), center.y.toFixed(2), center.z.toFixed(2))
    return true
  }

  /**
   * Dispose selection proxy mesh
   */
  function disposeSelectionProxy() {
    if (selectionProxyMesh) {
      selectionProxyMesh.parent = null  // Unparent before disposing
      selectionProxyMesh.dispose()
      selectionProxyMesh = null
    }
    selectionInitialCenter = null
    selectionInitialTransform = null
  }

  /**
   * Capture the initial transform state of the selection proxy (called on drag start)
   */
  function captureSelectionProxyTransform() {
    if (!selectionProxyMesh) return
    
    selectionInitialTransform = {
      position: selectionProxyMesh.position.clone(),
      rotation: selectionProxyMesh.rotationQuaternion?.clone() || Quaternion.Identity(),
      scale: selectionProxyMesh.scaling.clone()
    }
    
    console.log('[Babylon] Captured selection proxy initial transform')
  }

  /**
   * Update the selection point cloud preview during gizmo drag
   * Transforms the cached positions by the delta between initial and current proxy transform
   */
  function updateSelectionPointCloudFromProxy() {
    const posData = getSplatPositions()
    if (!scene || !posData || !selectionProxyMesh || !selectionInitialTransform || !selectionInitialCenter) {
      return
    }

    const { positions: cachedSplatPositions, count: cachedSplatCount } = posData
    const selectedIndices = editorStore.selection.indices
    if (selectedIndices.size === 0) return

    // Calculate delta transform from initial to current
    const currentPos = selectionProxyMesh.position
    const currentRot = selectionProxyMesh.rotationQuaternion || Quaternion.Identity()
    const currentScale = selectionProxyMesh.scaling

    const initialPos = selectionInitialTransform.position
    const initialRot = selectionInitialTransform.rotation
    const initialScale = selectionInitialTransform.scale

    // Dispose existing point cloud
    if (selectionPointCloud) {
      selectionPointCloud.dispose()
      selectionPointCloud = null
    }

    // Build transformed positions array
    const positions: number[] = []
    const colors: number[] = []

    // Pre-calculate inverse initial rotation for delta calculation
    const initialRotInverse = initialRot.clone()
    initialRotInverse.invertInPlace()
    
    // Delta rotation = inverse(initial) * current
    // This gives us the rotation to apply to points to move them from initial orientation to current
    const deltaRot = initialRotInverse.multiply(currentRot)
    
    // Delta scale = current / initial
    const deltaScale = new Vector3(
      currentScale.x / (initialScale.x || 1),
      currentScale.y / (initialScale.y || 1),
      currentScale.z / (initialScale.z || 1)
    )
    
    // Delta translation = current - initial
    const deltaTranslation = currentPos.subtract(initialPos)

    const pivot = selectionInitialCenter
    const tempPos = new Vector3()
    const rotatedPos = new Vector3()

    for (const idx of selectedIndices) {
      if (idx >= 0 && idx < cachedSplatCount) {
        // Get original position
        const x = cachedSplatPositions[idx * 3]
        const y = cachedSplatPositions[idx * 3 + 1]
        const z = cachedSplatPositions[idx * 3 + 2]

        // Transform around pivot:
        // 1. Translate to origin (relative to pivot)
        tempPos.set(x - pivot.x, y - pivot.y, z - pivot.z)
        
        // 2. Apply scale
        tempPos.x *= deltaScale.x
        tempPos.y *= deltaScale.y
        tempPos.z *= deltaScale.z
        
        // 3. Apply rotation
        tempPos.rotateByQuaternionToRef(deltaRot, rotatedPos)
        
        // 4. Translate back and add delta translation
        const newX = rotatedPos.x + pivot.x + deltaTranslation.x
        const newY = rotatedPos.y + pivot.y + deltaTranslation.y
        const newZ = rotatedPos.z + pivot.z + deltaTranslation.z

        positions.push(newX, newY, newZ)
        // Cyan highlight color
        colors.push(0, 1, 1, 1)
      }
    }

    if (positions.length === 0) return

    // Create custom mesh for point cloud
    selectionPointCloud = new Mesh('selectionPointCloud', scene)
    
    // DON'T parent to splat mesh - positions are already in world space after transform
    
    const vertexData = new VertexData()
    vertexData.positions = positions
    vertexData.colors = colors
    
    // Create indices for points
    const indices: number[] = []
    for (let i = 0; i < positions.length / 3; i++) {
      indices.push(i)
    }
    vertexData.indices = indices
    
    vertexData.applyToMesh(selectionPointCloud)

    // Create point material
    const material = new StandardMaterial('selectionPointMat', scene)
    material.emissiveColor = new Color3(0, 1, 1)
    material.disableLighting = true
    material.pointsCloud = true
    material.pointSize = 4
    
    selectionPointCloud.material = material
  }

  /**
   * Apply the selection proxy transform to the actual splat file data
   * Called when gizmo drag ends
   */
  async function applySelectionProxyTransform(): Promise<boolean> {
    if (!selectionProxyMesh || !selectionInitialTransform || !selectionInitialCenter) {
      console.warn('[Babylon] Cannot apply selection transform - missing proxy data')
      return false
    }

    // Calculate delta transform
    const currentPos = selectionProxyMesh.position
    const currentRot = selectionProxyMesh.rotationQuaternion || Quaternion.Identity()
    const currentScale = selectionProxyMesh.scaling

    const initialPos = selectionInitialTransform.position
    const initialRot = selectionInitialTransform.rotation
    const initialScale = selectionInitialTransform.scale

    // Check if there's actually any change
    const posChanged = !currentPos.equals(initialPos)
    const rotChanged = !currentRot.equals(initialRot)
    const scaleChanged = !currentScale.equals(initialScale)

    if (!posChanged && !rotChanged && !scaleChanged) {
      console.log('[Babylon] No selection transform change detected')
      return true
    }

    // Calculate delta rotation = inverse(initial) * current
    // This gives us the rotation to apply to points to move them from initial orientation to current
    const initialRotInverse = initialRot.clone()
    initialRotInverse.invertInPlace()
    const deltaRot = initialRotInverse.multiply(currentRot)
    
    // Delta scale = current / initial
    const deltaScale = new Vector3(
      currentScale.x / (initialScale.x || 1),
      currentScale.y / (initialScale.y || 1),
      currentScale.z / (initialScale.z || 1)
    )
    
    // Delta translation = current - initial
    const deltaTranslation = currentPos.subtract(initialPos)

    console.log('[Babylon] Applying selection transform:')
    console.log('  Delta translation:', deltaTranslation.x.toFixed(3), deltaTranslation.y.toFixed(3), deltaTranslation.z.toFixed(3))
    console.log('  Delta scale:', deltaScale.x.toFixed(3), deltaScale.y.toFixed(3), deltaScale.z.toFixed(3))

    // Apply transform to selected splats in file
    const result = await transformSelectedSplats(
      selectionInitialCenter,
      deltaTranslation,
      deltaRot,
      deltaScale
    )

    // Reset proxy transform for next drag
    if (result) {
      createOrUpdateSelectionProxy()
    }

    return result
  }

  /**
   * Transform selected splats in the file data
   * Modifies positions around pivot and rotates quaternions
   */
  async function transformSelectedSplats(
    pivot: Vector3,
    translation: Vector3,
    rotation: Quaternion,
    scale: Vector3
  ): Promise<boolean> {
    const originalFileBlob = getActiveBlob()
    if (!originalFileBlob) {
      console.error('[Babylon] No original file to transform')
      return false
    }

    const selectedIndices = editorStore.selection.indices
    if (selectedIndices.size === 0) {
      console.log('[Babylon] No splats selected to transform')
      return false
    }

    const activeId = editorStore.activeObjectId
    if (!activeId) {
      console.error('[Babylon] No active object to transform')
      return false
    }

    try {
      const arrayBuffer = await originalFileBlob.arrayBuffer()
      const uint8 = new Uint8Array(arrayBuffer)
      const header = new TextDecoder().decode(uint8.slice(0, 100))

      if (header.startsWith('ply')) {
        await transformPlySelected(uint8, selectedIndices, pivot, translation, rotation, scale)
      } else {
        await transformSplatFileSelected(uint8, selectedIndices, pivot, translation, rotation, scale)
      }

      // Update cached positions
      await cacheSplatPositions(activeId)

      // Refresh the selection point cloud with new positions
      updateSelectionPointCloud()

      return true
    } catch (e) {
      console.error('[Babylon] Failed to transform selected splats:', e)
      return false
    }
  }

  /**
   * Transform selected vertices in a PLY file
   */
  async function transformPlySelected(
    data: Uint8Array,
    selectedIndices: Set<number>,
    pivot: Vector3,
    translation: Vector3,
    rotation: Quaternion,
    scale: Vector3
  ): Promise<void> {
    const headerEnd = findPlyHeaderEnd(data)
    if (headerEnd < 0) {
      throw new Error('Invalid PLY file')
    }

    const headerStr = new TextDecoder().decode(data.slice(0, headerEnd))
    const vertexCountMatch = headerStr.match(/element vertex (\d+)/)
    if (!vertexCountMatch) {
      throw new Error('Invalid PLY file - no vertex count')
    }

    const properties = parsePlyProperties(headerStr)
    const vertexSize = properties.reduce((sum, p) => sum + p.size, 0)

    // Find position and rotation property offsets
    const xProp = properties.find(p => p.name === 'x')
    const yProp = properties.find(p => p.name === 'y')
    const zProp = properties.find(p => p.name === 'z')
    const rot0Prop = properties.find(p => p.name === 'rot_0')
    const rot1Prop = properties.find(p => p.name === 'rot_1')
    const rot2Prop = properties.find(p => p.name === 'rot_2')
    const rot3Prop = properties.find(p => p.name === 'rot_3')

    if (!xProp || !yProp || !zProp) {
      throw new Error('PLY missing position properties')
    }

    const hasRotation = rot0Prop && rot1Prop && rot2Prop && rot3Prop

    // Create a copy of the data to modify
    const newData = new Uint8Array(data)
    const dataView = new DataView(newData.buffer, newData.byteOffset + headerEnd)

    const tempPos = new Vector3()
    const rotatedPos = new Vector3()

    for (const idx of selectedIndices) {
      const offset = idx * vertexSize

      // Read current position (with Y negation for Babylon.js coordinate system)
      const x = dataView.getFloat32(offset + xProp.offset, true)
      const y = -dataView.getFloat32(offset + yProp.offset, true)  // Negate Y
      const z = dataView.getFloat32(offset + zProp.offset, true)

      // Transform position around pivot
      tempPos.set(x - pivot.x, y - pivot.y, z - pivot.z)
      tempPos.x *= scale.x
      tempPos.y *= scale.y
      tempPos.z *= scale.z
      tempPos.rotateByQuaternionToRef(rotation, rotatedPos)
      
      const newX = rotatedPos.x + pivot.x + translation.x
      const newY = rotatedPos.y + pivot.y + translation.y
      const newZ = rotatedPos.z + pivot.z + translation.z

      // Write back (with Y negation)
      dataView.setFloat32(offset + xProp.offset, newX, true)
      dataView.setFloat32(offset + yProp.offset, -newY, true)  // Negate Y back
      dataView.setFloat32(offset + zProp.offset, newZ, true)

      // Transform rotation quaternion if present
      // The delta rotation is in Babylon space (Y-negated from PLY)
      // We need to convert it to PLY space before applying to PLY quaternions
      if (hasRotation) {
        const q0 = dataView.getFloat32(offset + rot0Prop!.offset, true)  // w
        const q1 = dataView.getFloat32(offset + rot1Prop!.offset, true)  // x
        const q2 = dataView.getFloat32(offset + rot2Prop!.offset, true)  // y
        const q3 = dataView.getFloat32(offset + rot3Prop!.offset, true)  // z

        // PLY quaternion format: rot_0=w, rot_1=x, rot_2=y, rot_3=z
        // Babylon Quaternion constructor: (x, y, z, w)
        const originalQuat = new Quaternion(q1, q2, q3, q0)
        
        // Convert delta rotation from Babylon space to PLY space
        // Since positions use Y-negation, rotations need the same conversion:
        // For Y-negation, negate the Y component of the quaternion's imaginary part
        const rotationInPlySpace = new Quaternion(rotation.x, -rotation.y, rotation.z, rotation.w)
        
        // Apply delta rotation in PLY space: newQuat = rotationPLY * originalQuat
        const newQuat = rotationInPlySpace.multiply(originalQuat)
        newQuat.normalize()

        // Write back in PLY format: rot_0=w, rot_1=x, rot_2=y, rot_3=z
        dataView.setFloat32(offset + rot0Prop!.offset, newQuat.w, true)
        dataView.setFloat32(offset + rot1Prop!.offset, newQuat.x, true)
        dataView.setFloat32(offset + rot2Prop!.offset, newQuat.y, true)
        dataView.setFloat32(offset + rot3Prop!.offset, newQuat.z, true)
      }
    }

    // Update original file blob and reload
    const activeId = editorStore.activeObjectId
    const fileName = getActiveFileName() || 'transformed.ply'
    const newBlob = new Blob([newData], { type: 'application/octet-stream' })
    if (activeId) {
      storeOriginalFile(activeId, newBlob, fileName)
    }

    const url = URL.createObjectURL(newBlob)
    await loadSplat(url, fileName, false, true)
    URL.revokeObjectURL(url)
  }

  /**
   * Transform selected vertices in a .splat file (antimatter15 format)
   */
  async function transformSplatFileSelected(
    data: Uint8Array,
    selectedIndices: Set<number>,
    pivot: Vector3,
    translation: Vector3,
    rotation: Quaternion,
    scale: Vector3
  ): Promise<void> {
    const bytesPerSplat = 32
    const splatCount = Math.floor(data.length / bytesPerSplat)

    // Create a copy of the data to modify
    const newData = new Uint8Array(data)
    const dataView = new DataView(newData.buffer, newData.byteOffset)

    const tempPos = new Vector3()
    const rotatedPos = new Vector3()

    for (const idx of selectedIndices) {
      if (idx >= splatCount) continue

      const offset = idx * bytesPerSplat

      // Read current position (with Y negation)
      const x = dataView.getFloat32(offset, true)
      const y = -dataView.getFloat32(offset + 4, true)  // Negate Y
      const z = dataView.getFloat32(offset + 8, true)

      // Transform position around pivot
      tempPos.set(x - pivot.x, y - pivot.y, z - pivot.z)
      tempPos.x *= scale.x
      tempPos.y *= scale.y
      tempPos.z *= scale.z
      tempPos.rotateByQuaternionToRef(rotation, rotatedPos)
      
      const newX = rotatedPos.x + pivot.x + translation.x
      const newY = rotatedPos.y + pivot.y + translation.y
      const newZ = rotatedPos.z + pivot.z + translation.z

      // Write back (with Y negation)
      dataView.setFloat32(offset, newX, true)
      dataView.setFloat32(offset + 4, -newY, true)  // Negate Y back
      dataView.setFloat32(offset + 8, newZ, true)

      // Note: .splat format doesn't store explicit rotation quaternions
      // The covariance/scale data at bytes 12-23 would need different handling
      // For now, only position transforms are applied to .splat files
    }

    // Update original file blob and reload
    const activeId = editorStore.activeObjectId
    const fileName = getActiveFileName() || 'transformed.splat'
    const newBlob = new Blob([newData], { type: 'application/octet-stream' })
    if (activeId) {
      storeOriginalFile(activeId, newBlob, fileName)
    }

    const url = URL.createObjectURL(newBlob)
    await loadSplat(url, fileName, false, true)
    URL.revokeObjectURL(url)
  }

  /**
   * Find all splat indices within a sphere centered at the given position
   */
  function getSplatsInSphere(center: Vector3, radius: number): number[] {
    const posData = getSplatPositions()
    if (!posData) {
      return []
    }

    const { positions: cachedSplatPositions, count: cachedSplatCount } = posData
    const radiusSq = radius * radius
    const indices: number[] = []

    for (let i = 0; i < cachedSplatCount; i++) {
      const x = cachedSplatPositions[i * 3]
      const y = cachedSplatPositions[i * 3 + 1]
      const z = cachedSplatPositions[i * 3 + 2]

      const dx = x - center.x
      const dy = y - center.y
      const dz = z - center.z
      const distSq = dx * dx + dy * dy + dz * dz

      if (distSq <= radiusSq) {
        indices.push(i)
      }
    }

    return indices
  }

  /**
   * Add splats within the current brush position to selection
   */
  function selectSplatsInBrush(): number {
    if (!selectionBrushMesh || !selectionBrushMesh.isEnabled()) {
      return 0
    }

    const brushPos = selectionBrushMesh.position
    const brushRadius = editorStore.selection.brushRadius
    const indices = getSplatsInSphere(brushPos, brushRadius)

    if (indices.length > 0) {
      editorStore.addToSelection(indices)
    }

    return indices.length
  }

  /**
   * Remove splats within the current brush position from selection
   */
  function deselectSplatsInBrush(): number {
    if (!selectionBrushMesh || !selectionBrushMesh.isEnabled()) {
      return 0
    }

    const brushPos = selectionBrushMesh.position
    const brushRadius = editorStore.selection.brushRadius
    const indices = getSplatsInSphere(brushPos, brushRadius)

    if (indices.length > 0) {
      editorStore.removeFromSelection(indices)
    }

    return indices.length
  }

  /**
   * Handle brush painting based on current mode
   * Returns the number of splats affected
   */
  function paintWithBrush(): number {
    const mode = editorStore.selection.brushMode
    if (mode === 'add') {
      return selectSplatsInBrush()
    } else {
      return deselectSplatsInBrush()
    }
  }

  /**
   * Update brush position from screen coordinates
   * Note: This is now handled automatically by the pointer observable
   * when the brush is enabled. This function is kept for manual control if needed.
   */
  function updateBrushFromScreenPosition(screenX: number, screenY: number): boolean {
    const position = findBrushPositionFromPointer(screenX, screenY)
    if (position) {
      setSelectionBrushPosition(position.x, position.y, position.z)
      return true
    }
    return false
  }

  /**
   * Delete selected splats from the file and reload
   * Returns the count of remaining splats, or null on error
   */
  async function deleteSelectedSplats(): Promise<{ originalCount: number; remainingCount: number } | null> {
    const originalFileBlob = getActiveBlob()
    if (!originalFileBlob) {
      console.error('[Babylon] No original file to delete from')
      return null
    }

    const selectedIndices = editorStore.selection.indices
    if (selectedIndices.size === 0) {
      console.log('[Babylon] No splats selected to delete')
      return null
    }

    const activeId = editorStore.activeObjectId
    if (!activeId) {
      console.error('[Babylon] No active object to delete from')
      return null
    }

    try {
      const arrayBuffer = await originalFileBlob.arrayBuffer()
      const uint8 = new Uint8Array(arrayBuffer)
      const header = new TextDecoder().decode(uint8.slice(0, 100))

      let result: { originalCount: number; remainingCount: number }
      if (header.startsWith('ply')) {
        result = await deletePlySelected(uint8, selectedIndices)
      } else {
        result = await deleteSplatFileSelected(uint8, selectedIndices)
      }

      // Clear selection after delete
      editorStore.clearSelection()
      clearSelectionPointCloud()

      // Re-cache positions from the new file
      await cacheSplatPositions(activeId)

      return result
    } catch (e) {
      console.error('[Babylon] Failed to delete selected splats:', e)
      return null
    }
  }

  async function deletePlySelected(
    data: Uint8Array,
    selectedIndices: Set<number>
  ): Promise<{ originalCount: number; remainingCount: number }> {
    const headerEnd = findPlyHeaderEnd(data)
    if (headerEnd < 0) {
      throw new Error('Invalid PLY file')
    }

    const headerStr = new TextDecoder().decode(data.slice(0, headerEnd))
    const vertexCountMatch = headerStr.match(/element vertex (\d+)/)
    if (!vertexCountMatch) {
      throw new Error('Invalid PLY file - no vertex count')
    }

    const originalCount = parseInt(vertexCountMatch[1])
    const properties = parsePlyProperties(headerStr)
    const vertexSize = properties.reduce((sum, p) => sum + p.size, 0)

    // Find indices to keep (not selected)
    const keepIndices: number[] = []
    for (let i = 0; i < originalCount; i++) {
      if (!selectedIndices.has(i)) {
        keepIndices.push(i)
      }
    }

    const remainingCount = keepIndices.length
    console.log('[Babylon] PLY delete: keeping', remainingCount, 'of', originalCount, 'splats')

    // Build new PLY file
    const newHeader = headerStr.replace(
      /element vertex \d+/,
      `element vertex ${remainingCount}`
    )
    const newHeaderBytes = new TextEncoder().encode(newHeader)
    
    const newDataSize = remainingCount * vertexSize
    const newFile = new Uint8Array(newHeaderBytes.length + newDataSize)
    newFile.set(newHeaderBytes)
    
    const dataStart = headerEnd
    
    // Copy vertex data for kept vertices
    for (let i = 0; i < keepIndices.length; i++) {
      const srcOffset = dataStart + keepIndices[i] * vertexSize
      const dstOffset = newHeaderBytes.length + i * vertexSize
      newFile.set(data.slice(srcOffset, srcOffset + vertexSize), dstOffset)
    }

    // Update original file blob and reload
    const activeId = editorStore.activeObjectId
    const fileName = getActiveFileName() || 'edited.ply'
    const newBlob = new Blob([newFile], { type: 'application/octet-stream' })
    if (activeId) {
      storeOriginalFile(activeId, newBlob, fileName)
    }

    const url = URL.createObjectURL(newBlob)
    await loadSplat(url, fileName, false, true)
    URL.revokeObjectURL(url)

    return { originalCount, remainingCount }
  }

  async function deleteSplatFileSelected(
    data: Uint8Array,
    selectedIndices: Set<number>
  ): Promise<{ originalCount: number; remainingCount: number }> {
    const bytesPerSplat = 32
    const originalCount = Math.floor(data.length / bytesPerSplat)

    // Find indices to keep (not selected)
    const keepIndices: number[] = []
    for (let i = 0; i < originalCount; i++) {
      if (!selectedIndices.has(i)) {
        keepIndices.push(i)
      }
    }

    const remainingCount = keepIndices.length
    console.log('[Babylon] Splat delete: keeping', remainingCount, 'of', originalCount, 'splats')

    // Build new file
    const newData = new Uint8Array(remainingCount * bytesPerSplat)
    
    for (let i = 0; i < keepIndices.length; i++) {
      const srcOffset = keepIndices[i] * bytesPerSplat
      const dstOffset = i * bytesPerSplat
      newData.set(data.slice(srcOffset, srcOffset + bytesPerSplat), dstOffset)
    }

    // Update original file blob and reload
    const activeId = editorStore.activeObjectId
    const fileName = getActiveFileName() || 'edited.splat'
    const newBlob = new Blob([newData], { type: 'application/octet-stream' })
    if (activeId) {
      storeOriginalFile(activeId, newBlob, fileName)
    }

    const url = URL.createObjectURL(newBlob)
    await loadSplat(url, fileName, false, true)
    URL.revokeObjectURL(url)

    return { originalCount, remainingCount }
  }

  // Fixed ID for preview splats - ensures we replace instead of accumulate
  // Must match the ID used in sceneStore.addOrUpdatePreview()
  const PREVIEW_SPLAT_ID = 'preview'

  async function loadSplat(url: string, name: string, isPreview: boolean = false, isInternalReload: boolean = false, existingId?: string, skipFlipPrompt: boolean = false): Promise<string | null> {
    if (!scene) {
      console.error('[Babylon] Cannot load splat - scene not initialized')
      return null
    }

    console.log('[Babylon] Loading splat:', name, 'from:', url, 'isPreview:', isPreview)

    // For previews, always use the fixed preview ID so we replace instead of accumulate
    // For internal reloads, use the existing ID; for new loads, generate new ID
    let objectId: string
    if (isPreview) {
      objectId = PREVIEW_SPLAT_ID
    } else if (existingId) {
      objectId = existingId
    } else if (isInternalReload && editorStore.activeObjectId) {
      objectId = editorStore.activeObjectId
    } else {
      objectId = crypto.randomUUID()
      // When loading a non-preview (final) splat, dispose any existing preview
      const existingPreview = splats.get(PREVIEW_SPLAT_ID)
      if (existingPreview) {
        console.log('[Babylon] Disposing preview splat before loading final result')
        existingPreview.dispose()
        splats.delete(PREVIEW_SPLAT_ID)
        // Also clear preview from scene hierarchy
        sceneStore.clearPreview()
      }
    }
    
    // Keep reference to old mesh for this ID for disposal after new one is ready
    const oldSplat = splats.get(objectId)
    
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

    try {
      // Only show loading indicator for non-preview loads (and not internal reloads to avoid flicker)
      if (!isPreview && !isInternalReload) {
        appStore.isLoading = true
      }

      // Store original file for clipping (only for non-preview loads from user imports)
      // Skip if this is an internal reload (like from clipping)
      if (!isPreview && url.startsWith('blob:') && !isInternalReload) {
        try {
          const response = await fetch(url)
          const blob = await response.blob()
          storeOriginalFile(objectId, blob, name)
        } catch (e) {
          console.warn('[Babylon] Could not store original file:', e)
        }
      }

      // Determine file extension for proper loader selection
      const extension = name.split('.').pop()?.toLowerCase() || 'splat'
      const pluginExtension = '.' + extension
      
      console.log('[Babylon] Loading splat via ImportMeshAsync, extension:', pluginExtension)
      
      // Use ImportMeshAsync with pluginOptions to set keepInRam for splat loader
      // This is required for baking transforms into splat data
      let newSplat: GaussianSplattingMesh
      try {
        const result = await ImportMeshAsync(url, scene, {
          pluginExtension: pluginExtension,
          pluginOptions: {
            splat: { keepInRam: true }   
          }
        })
        console.log('[Babylon] ImportMeshAsync result:', result.meshes.length, 'meshes loaded')
        
        // Check if splat data is kept in RAM
        const mesh = result.meshes[0] as any
        console.log('[Babylon] Mesh has _splatsData:', !!mesh._splatsData, 'type:', typeof mesh._splatsData)
        
        if (result.meshes.length === 0) {
          throw new Error('No meshes loaded from file')
        }
        
        // CRITICAL: Dispose any extra meshes that ImportMeshAsync created beyond the first one
        // This prevents orphaned meshes from accumulating in the scene
        if (result.meshes.length > 1) {
          console.warn(`[Babylon] ImportMeshAsync returned ${result.meshes.length} meshes, disposing ${result.meshes.length - 1} extra meshes`)
          for (let i = 1; i < result.meshes.length; i++) {
            console.log('[Babylon] Disposing extra mesh:', result.meshes[i].name)
            result.meshes[i].dispose()
          }
        }
        
        // The first mesh should be our GaussianSplattingMesh
        newSplat = result.meshes[0] as GaussianSplattingMesh
        newSplat.name = name
        console.log('[Babylon] File loaded successfully')
      } catch (loadError) {
        console.error('[Babylon] ImportMeshAsync failed:', loadError)
        throw loadError
      }
      
      // NOW dispose the old mesh (after new one is ready) to avoid flicker
      if (oldSplat) {
        const oldSplatCount = oldSplat.getTotalVertices()
        console.log(`[Babylon] Disposing previous splat mesh for ${objectId} (${oldSplatCount} splats)`)
        
        // Dispose the mesh and all its resources
        oldSplat.dispose()
        
        console.log(`[Babylon] ✓ Previous splat disposed, current scene meshes: ${scene?.meshes.length || 0}`)
        
        // Force immediate cleanup of disposed resources
        if (engine) {
          engine.wipeCaches(true)  // Force wipe including bind groups
        }
      } else {
        console.log('[Babylon] No previous splat to dispose for', objectId)
      }
      
      // Store the new splat in the map
      splats.set(objectId, newSplat)
      
      // Set this splat as active (if not a preview)
      if (!isPreview) {
        editorStore.setActiveObject(objectId)
      }

      // Get actual splat count from mesh (getTotalVertices returns the true vertex count)
      const splatCount = newSplat.getTotalVertices()
      console.log('[Babylon] Splat count from getTotalVertices():', splatCount)
      
      // Log texture dimensions to understand how splats are stored
      const textureSize = (newSplat as any)._covariancesATexture?.getSize()
      if (textureSize) {
        const texelCount = textureSize.width * textureSize.height
        console.log('[Babylon] Covariance texture dimensions:', textureSize.width, 'x', textureSize.height, '=', texelCount, 'texels')
        console.log('[Babylon] Texture utilization:', (splatCount / texelCount * 100).toFixed(1) + '%')
      }
      
      // Also check the internal vertex count
      const internalCount = (newSplat as any)._vertexCount
      if (internalCount && internalCount !== splatCount) {
        console.warn('[Babylon] ⚠️ Vertex count mismatch! getTotalVertices:', splatCount, '_vertexCount:', internalCount)
      }

      // Update scene store based on load type
      if (isInternalReload) {
        // Internal reload just updates the existing object's splat count
        sceneStore.updateSplatCount(splatCount)
      } else if (!isPreview) {
        // New non-preview load adds a new object
        sceneStore.addObject({
          id: objectId,
          name: name,
          visible: true,
          splatCount: splatCount
        })
      } else {
        // Update splat count in scene store if there's an existing preview entry
        sceneStore.updatePreviewSplatCount(splatCount)
      }

      // Focus camera on splat (only on first load, not for internal reloads or previews)
      if ((orbitCamera || flyCamera) && newSplat.getBoundingInfo()) {
        // Only reposition camera for first preview or non-preview loads (not internal reloads)
        if (!isInternalReload && (!isPreview || !sceneStore.hasPreviewObject)) {
          focusCamera()
        }
      }

      // Cache splat positions for selection tool (only for non-preview, non-internal reloads)
      if (!isPreview && !isInternalReload && workingBlobs.has(objectId)) {
        await cacheSplatPositions(objectId)
        
        // Compare cached count (from original file) vs loaded count (from mesh)
        const cachedCount = splatCounts.get(objectId)
        if (cachedCount && cachedCount !== splatCount) {
          console.warn('[Babylon] ⚠️ SPLAT COUNT MISMATCH!')
          console.warn('[Babylon]   Original file has:', cachedCount, 'splats')
          console.warn('[Babylon]   Babylon loaded:', splatCount, 'splats')
          console.warn('[Babylon]   Missing:', cachedCount - splatCount, 'splats (', ((cachedCount - splatCount) / cachedCount * 100).toFixed(1), '% lost)')
        } else if (cachedCount) {
          console.log('[Babylon] ✓ Splat counts match - all', cachedCount, 'splats loaded successfully')
        }
      }
      
      // Sync the initial mesh transform to the store so UI reflects actual values
      // This is important because PLY files may have Y scale = -1 from coordinate conversion
      syncTransformToStore()
      
      // Defensive cleanup: ensure no orphaned splat meshes remain in the scene
      cleanupOrphanedSplats()
      
      // Handle Y-axis flip
      if (!isPreview) {
        if (isInternalReload) {
          // Internal reload after operation - check if this splat was previously flipped
          // If so, automatically re-apply the flip and bake
          await reapplyFlipAfterReload(objectId)
        } else if (!skipFlipPrompt) {
          // User import - prompt for Y-axis flip (unless skipFlipPrompt is true, e.g. SQPZ import)
          // Babylon's loader applies scaling.y = -1 for ALL GS formats (PLY, SPZ, SPLAT)
          if (newSplat.scaling.y < 0) {
            pendingYFlipObjectId.value = objectId
            console.log('[Babylon] GS import detected with Y-flip — prompting user')
          }
        } else {
          console.log('[Babylon] Skipping Y-flip prompt (SQPZ import will handle flip state)')
        }
      }
      
      return objectId
    } catch (error) {
      console.error('[Babylon] Failed to load splat:', error)
      if (!isPreview) {
        appStore.error = 'Failed to load splat file'
        // Only show debug cube if we don't have any splats
        if (splats.size === 0) {
          showDebugCube(true)
        }
      }
      return null
    } finally {
      if (!isPreview && !isInternalReload) {
        appStore.isLoading = false
      }
    }
  }

  /**
   * Remove a specific splat by ID
   */
  function removeSplat(id: string) {
    const mesh = splats.get(id)
    if (mesh) {
      console.log('[Babylon] Disposing splat mesh:', id)
      mesh.dispose()
      splats.delete(id)
    }
    
    // Clean up associated data
    workingBlobs.delete(id)
    originalBlobs.delete(id)
    originalFileNames.delete(id)
    positionCaches.delete(id)
    splatCounts.delete(id)
    splatFlipStates.delete(id)
    
    // Remove from scene store
    sceneStore.removeObject(id)
    
    // If this was the active object, clear active selection
    if (editorStore.activeObjectId === id) {
      // Set active to next available splat, or null if none
      const remainingIds = Array.from(splats.keys())
      editorStore.setActiveObject(remainingIds.length > 0 ? remainingIds[0] : null)
      
      // If we switched to a different splat, sync its transform
      if (remainingIds.length > 0) {
        syncTransformToStore()
      }
    }
  }

  /**
   * Clear all splats from the scene
   */
  function clearAllSplats() {
    console.log('[Babylon] Clearing all splats')
    
    // Dispose all meshes
    for (const [id, mesh] of splats) {
      console.log('[Babylon] Disposing splat:', id)
      mesh.dispose()
    }
    
    // Clear all maps
    splats.clear()
    workingBlobs.clear()
    originalBlobs.clear()
    originalFileNames.clear()
    positionCaches.clear()
    splatCounts.clear()
    splatFlipStates.clear()
    
    // Clear stores
    sceneStore.clearAll()
    editorStore.clearActiveObject()
    
    // Clear selection-related state
    clearSelectionPointCloud()
    disposeSelectionProxy()
  }

  /**
   * Cleanup any orphaned GaussianSplattingMesh instances in the scene
   * that are not tracked in our splats Map
   */
  function cleanupOrphanedSplats() {
    if (!scene) return
    
    const orphans: GaussianSplattingMesh[] = []
    
    // Find all GaussianSplattingMesh instances in the scene
    for (const mesh of scene.meshes) {
      if (mesh instanceof GaussianSplattingMesh) {
        // Check if this mesh is tracked in our splats Map
        let isTracked = false
        for (const trackedMesh of splats.values()) {
          if (trackedMesh === mesh) {
            isTracked = true
            break
          }
        }
        
        if (!isTracked) {
          orphans.push(mesh)
        }
      }
    }
    
    if (orphans.length > 0) {
      console.warn(`[Babylon] Found ${orphans.length} orphaned splat meshes, disposing...`)
      for (const orphan of orphans) {
        console.log('[Babylon] Disposing orphaned mesh:', orphan.name)
        orphan.dispose()
      }
    }
  }

  /**
   * Set visibility of a specific splat by ID
   */
  function setSplatVisibility(id: string, visible: boolean) {
    const mesh = splats.get(id)
    if (mesh) {
      mesh.setEnabled(visible)
      // Also update scene store
      const obj = sceneStore.objects.find(o => o.id === id)
      if (obj) {
        obj.visible = visible
      }
      console.log('[Babylon] Set splat visibility:', id, visible)
    }
  }

  /**
   * Toggle visibility of a specific splat by ID
   */
  function toggleSplatVisibility(id: string) {
    const mesh = splats.get(id)
    if (mesh) {
      const newVisible = !mesh.isEnabled()
      mesh.setEnabled(newVisible)
      // Also update scene store
      sceneStore.toggleVisibility(id)
      console.log('[Babylon] Toggled splat visibility:', id, newVisible)
    }
  }

  /**
   * Legacy function - clears active splat (kept for compatibility)
   */
  function clearSplat(clearStore: boolean = true) {
    const activeId = editorStore.activeObjectId
    if (activeId) {
      removeSplat(activeId)
    }
    if (clearStore) {
      sceneStore.clearAll()
    }
  }

  function dispose() {
    // Remove global pointer observer
    if (scene && globalPointerObserver) {
      scene.onPointerObservable.remove(globalPointerObserver)
      globalPointerObserver = null
    }
    
    // Dispose view cube
    disposeViewCube()
    
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
    return getActiveSplat()
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

    const currentSplat = getActiveSplat()
    if (!target && currentSplat) {
      try {
        const boundingInfo = currentSplat.getBoundingInfo()
        if (boundingInfo) {
          targetPos = boundingInfo.boundingBox.centerWorld.clone()
          const radius = boundingInfo.boundingSphere.radiusWorld
          dist = Math.max(radius * 2.5, 5)
          // Store for dynamic zoom speed calculation
          currentSplatRadius = radius
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
   * Transform COLMAP coordinates to match OpenSplat/Babylon.js coordinate system
   * COLMAP uses a different convention that needs to be flipped on X and Y axes
   */
  function transformColmapPosition(x: number, y: number, z: number): Vector3 {
    // Flip X and Y to match the final splat output coordinate system
    return new Vector3(-x, -y, z)
  }

  /**
   * Transform COLMAP quaternion to match OpenSplat/Babylon.js coordinate system
   */
  function transformColmapRotation(qx: number, qy: number, qz: number, qw: number): Quaternion {
    // When we flip X and Y axes, we need to adjust the quaternion accordingly
    // Flipping X and Y is equivalent to a 180-degree rotation around Z axis
    // This changes the sign of qx and qy components
    return new Quaternion(-qx, -qy, qz, qw)
  }

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
    // Apply coordinate system transformation to match final splat output
    const position = transformColmapPosition(cam.position[0], cam.position[1], cam.position[2])
    
    // Convert quaternion [qx, qy, qz, qw] to Babylon Quaternion with coordinate transform
    const rotation = transformColmapRotation(cam.rotation[0], cam.rotation[1], cam.rotation[2], cam.rotation[3])
    
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
    
    // UVs: map image to corners (corrected for proper orientation)
    vertexData.uvs = [
      1, 0,  // bottom-left -> image bottom-right
      0, 0,  // bottom-right -> image bottom-left
      0, 1,  // top-right -> image top-left
      1, 1,  // top-left -> image top-right
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
      // Apply coordinate system transformation to match final splat output
      const transformed = transformColmapPosition(point.x, point.y, point.z)
      positions.push(transformed.x, transformed.y, transformed.z)
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
      // Calculate bounding box of transformed points
      let minX = Infinity, minY = Infinity, minZ = Infinity
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
      
      for (const point of data.points3D) {
        // Use transformed coordinates for bounding box
        const transformed = transformColmapPosition(point.x, point.y, point.z)
        minX = Math.min(minX, transformed.x)
        minY = Math.min(minY, transformed.y)
        minZ = Math.min(minZ, transformed.z)
        maxX = Math.max(maxX, transformed.x)
        maxY = Math.max(maxY, transformed.y)
        maxZ = Math.max(maxZ, transformed.z)
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

  // ============================================
  // Multi-View Capture for Semantic Selection
  // ============================================

  /**
   * Capture multiple views around the scene for semantic segmentation
   * Creates 8 virtual cameras at 45-degree intervals around the scene center
   * 
   * @param resolution Image resolution (default 512x512)
   * @returns Array of captured views with images and camera matrices
   */
  async function captureMultiViewImages(resolution: number = 512): Promise<CapturedView[]> {
    if (!scene || !engine) {
      throw new Error('Scene not initialized')
    }

    const splat = getActiveSplat()
    if (!splat) {
      throw new Error('No active splat to capture')
    }

    // Use the current camera's target and distance instead of bounding box
    // This captures views from the user's current viewpoint
    const currentCamera = scene.activeCamera as ArcRotateCamera
    if (!currentCamera || !currentCamera.target) {
      throw new Error('No active ArcRotate camera')
    }

    // Use the current camera's target (where user is looking) and radius (zoom level)
    const center = currentCamera.target.clone()
    const cameraDistance = currentCamera.radius

    console.log(`[Babylon] Capturing multi-view images - center: ${center}, distance: ${cameraDistance}`)

    const capturedViews: CapturedView[] = []
    const numViews = 8
    const canvas = engine.getRenderingCanvas()
    if (!canvas) {
      throw new Error('No rendering canvas')
    }

    // Store original camera
    const originalCamera = scene.activeCamera

    // Create a temporary camera for capturing
    const captureCamera = new ArcRotateCamera(
      'captureCamera',
      0,
      Math.PI * 0.4, // Slightly above horizontal
      cameraDistance,
      center,
      scene
    )
    captureCamera.minZ = 0.01
    captureCamera.maxZ = cameraDistance * 20

    try {
      for (let i = 0; i < numViews; i++) {
        // Position camera at 45-degree intervals
        const angle = (i / numViews) * Math.PI * 2
        captureCamera.alpha = angle
        
        // Vary elevation slightly for views 0, 2, 4, 6 vs 1, 3, 5, 7
        captureCamera.beta = i % 2 === 0 ? Math.PI * 0.35 : Math.PI * 0.45
        
        // Set as active camera
        scene.activeCamera = captureCamera

        // Force scene update
        scene.render()

        // Capture screenshot
        const dataUrl = await Tools.CreateScreenshotAsync(engine, captureCamera, {
          width: resolution,
          height: resolution
        })

        // Get camera matrices and compute combined transform (view * projection)
        const viewMatrix = captureCamera.getViewMatrix()
        const projMatrix = captureCamera.getProjectionMatrix()
        const transformMatrix = viewMatrix.multiply(projMatrix).toArray()
        const cameraPos = captureCamera.position

        capturedViews.push({
          filename: `view_${i.toString().padStart(2, '0')}.png`,
          dataUrl,
          width: resolution,
          height: resolution,
          transformMatrix: transformMatrix as number[],
          cameraPosition: { x: cameraPos.x, y: cameraPos.y, z: cameraPos.z }
        })

        console.log(`[Babylon] Captured view ${i + 1}/${numViews}`)
      }
    } finally {
      // Restore original camera
      scene.activeCamera = originalCamera
      captureCamera.dispose()
      
      // Re-render with original camera
      scene.render()
    }

    console.log(`[Babylon] Multi-view capture complete: ${capturedViews.length} views`)
    return capturedViews
  }

  /**
   * Project 2D masks back to 3D splat indices
   * Uses voting across multiple views - a splat is selected if it appears
   * inside the mask in at least `threshold` views
   * 
   * @param masks Array of mask info with base64 data and camera transform matrix
   * @param threshold Minimum number of views a splat must be in mask (default: 3)
   * @returns Set of selected splat indices
   */
  async function projectMasksToSplatIndices(
    masks: Array<{
      mask_base64: string
      width: number
      height: number
      transformMatrix: number[]
    }>,
    threshold: number = 3
  ): Promise<Set<number>> {
    if (!scene) {
      throw new Error('Scene not initialized')
    }

    const positions = getActivePositions()
    if (!positions) {
      throw new Error('No position data available')
    }

    const splatCount = positions.length / 3
    const votes = new Uint8Array(splatCount)

    console.log(`[Babylon] Projecting ${masks.length} masks onto ${splatCount} splats`)

    // Process each mask
    for (const maskInfo of masks) {
      // Decode mask from base64
      const maskData = await decodeMaskBase64(maskInfo.mask_base64, maskInfo.width, maskInfo.height)
      if (!maskData) continue

      // Reconstruct combined transform matrix (view * projection)
      const transformMatrix = Matrix.FromArray(maskInfo.transformMatrix)
      const viewport = new Viewport(0, 0, maskInfo.width, maskInfo.height)

      let maskHits = 0

      // Project each splat position and check if inside mask
      for (let i = 0; i < splatCount; i++) {
        const pos = new Vector3(
          positions[i * 3],
          positions[i * 3 + 1],
          positions[i * 3 + 2]
        )

        // Project 3D position to 2D screen coordinates
        const projected = Vector3.Project(
          pos,
          Matrix.Identity(),
          transformMatrix,
          viewport
        )

        // Check if within image bounds
        const px = Math.floor(projected.x)
        // Flip Y-axis: Babylon's projection has Y=0 at bottom, but image has Y=0 at top
        const py = Math.floor(maskInfo.height - 1 - projected.y)
        
        if (px >= 0 && px < maskInfo.width && py >= 0 && py < maskInfo.height) {
          // Check depth - only count if in front of camera (z between 0 and 1 in NDC)
          if (projected.z > 0 && projected.z < 1) {
            // Check mask value at this pixel
            const maskIdx = py * maskInfo.width + px
            if (maskData[maskIdx] > 0) {
              votes[i]++
              maskHits++
            }
          }
        }
      }
      
      console.log(`[Babylon] Mask processed: ${maskHits} splats hit`)
    }

    // Select splats that meet the vote threshold
    const selectedIndices = new Set<number>()
    for (let i = 0; i < splatCount; i++) {
      if (votes[i] >= threshold) {
        selectedIndices.add(i)
      }
    }

    console.log(`[Babylon] Projection complete: ${selectedIndices.size} splats selected (threshold: ${threshold}+ votes)`)
    return selectedIndices
  }

  /**
   * Toggle Babylon.js inspector for debugging
   */
  function toggleInspector() {
    if (!scene) {
      console.warn('[Babylon] Scene not initialized')
      return
    }
    
    if (scene.debugLayer.isVisible()) {
      scene.debugLayer.hide()
    } else {
      scene.debugLayer.show({
        embedMode: true,
        handleResize: true,
        overlay: true
      })
    }
  }

  // ============================================
  // WAYPOINT SYSTEM
  // ============================================

  /**
   * Create a 3D marker for a waypoint showing camera position and direction
   */
  function createWaypointMarker(
    waypointId: string, 
    alpha: number, 
    beta: number, 
    radius: number, 
    target: Vector3, 
    name: string
  ): Mesh | null {
    if (!scene) return null

    // Calculate camera position from orbit parameters
    const camX = target.x + radius * Math.sin(beta) * Math.cos(alpha)
    const camY = target.y + radius * Math.cos(beta)
    const camZ = target.z + radius * Math.sin(beta) * Math.sin(alpha)
    const cameraPos = new Vector3(camX, camY, camZ)

    // Create parent mesh to group all marker components
    const markerParent = new Mesh(`waypoint_${waypointId}`, scene)
    markerParent.position = cameraPos.clone()
    
    // Create sphere at camera position
    const sphere = MeshBuilder.CreateSphere(`waypoint_sphere_${waypointId}`, {
      diameter: 0.3,
      segments: 12
    }, scene)
    sphere.parent = markerParent
    sphere.position = Vector3.Zero()
    
    const sphereMaterial = new StandardMaterial(`waypoint_sphere_mat_${waypointId}`, scene)
    sphereMaterial.diffuseColor = new Color3(0.2, 0.8, 1.0)  // Cyan
    sphereMaterial.emissiveColor = new Color3(0.1, 0.4, 0.6)
    sphereMaterial.alpha = 0.9
    sphere.material = sphereMaterial
    
    // Create small sphere at target/focus point
    const targetSphere = MeshBuilder.CreateSphere(`waypoint_target_${waypointId}`, {
      diameter: 0.15,
      segments: 8
    }, scene)
    targetSphere.position = target.clone()
    
    const targetMaterial = new StandardMaterial(`waypoint_target_mat_${waypointId}`, scene)
    targetMaterial.diffuseColor = new Color3(1.0, 0.6, 0.2)  // Orange
    targetMaterial.emissiveColor = new Color3(0.5, 0.3, 0.1)
    targetMaterial.alpha = 0.8
    targetSphere.material = targetMaterial
    targetSphere.isPickable = false
    
    // Create line connecting camera to target focus point
    const connectionLine = MeshBuilder.CreateLines(`waypoint_line_${waypointId}`, {
      points: [Vector3.Zero(), target.subtract(cameraPos)]
    }, scene)
    connectionLine.color = new Color3(0.5, 0.7, 1.0)
    connectionLine.alpha = 0.6
    connectionLine.parent = markerParent
    connectionLine.isPickable = false
    
    // Create camera frustum lines
    const direction = target.subtract(cameraPos).normalize()
    const frustumDepth = radius * 0.15  // Small frustum relative to camera distance
    const frustumSize = frustumDepth * 0.5
    
    // Calculate right and up vectors for the camera
    const up = new Vector3(0, 1, 0)
    const right = Vector3.Cross(direction, up).normalize()
    const actualUp = Vector3.Cross(right, direction).normalize()
    
    // Calculate frustum corners
    const frustumCenter = cameraPos.add(direction.scale(frustumDepth))
    const corners = [
      frustumCenter.add(right.scale(-frustumSize)).add(actualUp.scale(-frustumSize)),  // Bottom-left
      frustumCenter.add(right.scale(frustumSize)).add(actualUp.scale(-frustumSize)),   // Bottom-right
      frustumCenter.add(right.scale(frustumSize)).add(actualUp.scale(frustumSize)),    // Top-right
      frustumCenter.add(right.scale(-frustumSize)).add(actualUp.scale(frustumSize))    // Top-left
    ]
    
    // Create frustum wireframe
    const frustumLines = [
      [Vector3.Zero(), corners[0].subtract(cameraPos)],
      [Vector3.Zero(), corners[1].subtract(cameraPos)],
      [Vector3.Zero(), corners[2].subtract(cameraPos)],
      [Vector3.Zero(), corners[3].subtract(cameraPos)],
      [corners[0].subtract(cameraPos), corners[1].subtract(cameraPos)],
      [corners[1].subtract(cameraPos), corners[2].subtract(cameraPos)],
      [corners[2].subtract(cameraPos), corners[3].subtract(cameraPos)],
      [corners[3].subtract(cameraPos), corners[0].subtract(cameraPos)]
    ]
    
    const frustum = MeshBuilder.CreateLineSystem(`waypoint_frustum_${waypointId}`, {
      lines: frustumLines
    }, scene)
    frustum.color = new Color3(0.2, 0.8, 1.0)
    frustum.parent = markerParent
    
    // Make the parent pickable
    markerParent.isPickable = true
    sphere.isPickable = false
    frustum.isPickable = false
    
    // Store references
    waypointMarkers.set(waypointId, markerParent)
    waypointTargetSpheres.set(waypointId, targetSphere)
    markerParent.setEnabled(waypointMarkersVisible)
    targetSphere.setEnabled(waypointMarkersVisible)
    
    console.log('[Babylon] Created waypoint marker:', name, 'at', cameraPos, 'looking at', target)
    return markerParent
  }

  /**
   * Remove waypoint marker
   */
  function removeWaypointMarker(waypointId: string) {
    const marker = waypointMarkers.get(waypointId)
    if (marker) {
      marker.dispose()
      waypointMarkers.delete(waypointId)
    }
    
    const targetSphere = waypointTargetSpheres.get(waypointId)
    if (targetSphere) {
      targetSphere.dispose()
      waypointTargetSpheres.delete(waypointId)
    }
    
    console.log('[Babylon] Removed waypoint marker:', waypointId)
  }

  /**
   * Update waypoint marker position
   */
  function updateWaypointMarkerPosition(waypointId: string, position: Vector3) {
    const marker = waypointMarkers.get(waypointId)
    if (marker) {
      marker.position = position.clone()
    }
  }

  /**
   * Clear all waypoint markers
   */
  function clearWaypointMarkers() {
    waypointMarkers.forEach(marker => marker.dispose())
    waypointMarkers.clear()
    waypointTargetSpheres.forEach(sphere => sphere.dispose())
    waypointTargetSpheres.clear()
    console.log('[Babylon] Cleared all waypoint markers')
  }

  /**
   * Set waypoint markers visibility
   */
  function setWaypointMarkersVisible(visible: boolean) {
    waypointMarkersVisible = visible
    waypointMarkers.forEach(marker => marker.setEnabled(visible))
    waypointTargetSpheres.forEach(sphere => sphere.setEnabled(visible))
  }

  /**
   * Resize engine (call when canvas size changes)
   */
  function resizeEngine() {
    if (engine) {
      engine.resize()
      console.log('[Babylon] Engine resized')
    }
  }

  /**
   * Animate camera to waypoint smoothly
   */
  function animateCameraToWaypoint(
    alpha: number,
    beta: number,
    radius: number,
    target: Vector3,
    duration: number = 1000
  ): Promise<void> {
    return new Promise((resolve) => {
      if (!scene || !orbitCamera) {
        resolve()
        return
      }

      // Force orbit camera to be active for waypoint navigation
      if (activeCamera !== orbitCamera) {
        scene.activeCamera = orbitCamera
        activeCamera = orbitCamera
      }

      const startAlpha = orbitCamera.alpha
      const startBeta = orbitCamera.beta
      const startRadius = orbitCamera.radius
      const startTarget = orbitCamera.target.clone()

      const startTime = Date.now()

      const animate = () => {
        const elapsed = Date.now() - startTime
        const t = Math.min(elapsed / duration, 1)
        
        // Easing function (ease-in-out)
        const ease = t < 0.5 
          ? 2 * t * t 
          : -1 + (4 - 2 * t) * t

        // Interpolate camera parameters
        orbitCamera.alpha = startAlpha + (alpha - startAlpha) * ease
        orbitCamera.beta = startBeta + (beta - startBeta) * ease
        orbitCamera.radius = startRadius + (radius - startRadius) * ease
        orbitCamera.target = Vector3.Lerp(startTarget, target, ease)

        if (t < 1) {
          requestAnimationFrame(animate)
        } else {
          console.log('[Babylon] Camera animation complete')
          resolve()
        }
      }

      animate()
    })
  }

  /**
   * Get current camera state for creating waypoints
   */
  function getCurrentCameraState(): { alpha: number; beta: number; radius: number; target: Vector3 } | null {
    if (!orbitCamera) return null
    
    return {
      alpha: orbitCamera.alpha,
      beta: orbitCamera.beta,
      radius: orbitCamera.radius,
      target: orbitCamera.target.clone()
    }
  }

  /**
   * Decode a base64 PNG mask into a Uint8Array
   */
  async function decodeMaskBase64(base64: string, width: number, height: number): Promise<Uint8Array | null> {
    return new Promise((resolve) => {
      const img = new Image()
      img.onload = () => {
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          resolve(null)
          return
        }

        ctx.drawImage(img, 0, 0)
        const imageData = ctx.getImageData(0, 0, width, height)
        
        // Extract single channel (grayscale mask)
        const mask = new Uint8Array(width * height)
        for (let i = 0; i < mask.length; i++) {
          // Use red channel (all channels should be same for grayscale)
          mask[i] = imageData.data[i * 4]
        }
        
        resolve(mask)
      }
      img.onerror = () => resolve(null)
      img.src = base64.startsWith('data:') ? base64 : `data:image/png;base64,${base64}`
    })
  }

  // ============================================
  // FLIP STATE TRACKING
  // ============================================

  /**
   * Get whether a splat was Y-flipped
   */
  function getSplatFlipState(id: string): boolean {
    return splatFlipStates.get(id) || false
  }

  /**
   * Set flip state for a splat (used when importing from SQPZ)
   */
  function setSplatFlipState(id: string, wasFlipped: boolean) {
    if (wasFlipped) {
      splatFlipStates.set(id, true)
    } else {
      splatFlipStates.delete(id)
    }
  }

  /**
   * Get all splat IDs and their flip states
   */
  function getAllSplatFlipStates(): Map<string, boolean> {
    return new Map(splatFlipStates)
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
    toggleInspector,
    // Multi-splat management
    removeSplat,
    clearAllSplats,
    cleanupOrphanedSplats,
    setSplatVisibility,
    toggleSplatVisibility,
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
    getMeshTransform,
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
    restoreToOriginal,
    // Bake transform
    bakeTransformToVertices,
    centerAtOrigin,
    // Auto Y-flip for PLY/SPZ imports
    showYFlipPrompt: pendingYFlipObjectId,
    autoFlipAndBake,
    dismissYFlipPrompt,
    // Selection
    createSelectionBrush,
    setSelectionBrushVisible,
    updateSelectionBrushRadius,
    setSelectionBrushPosition,
    findBrushPositionFromPointer,
    setupSelectionPointerObservable,
    removeSelectionPointerObservable,
    getSplatPositions,
    updateSelectionPointCloud,
    clearSelectionPointCloud,
    getSplatsInSphere,
    selectSplatsInBrush,
    deselectSplatsInBrush,
    paintWithBrush,
    updateBrushFromScreenPosition,
    deleteSelectedSplats,
    // Semantic selection (multi-view capture)
    captureMultiViewImages,
    projectMasksToSplatIndices,
    // View cube (camera orientation gizmo)
    setViewCubeVisible,
    // Waypoint system
    createWaypointMarker,
    removeWaypointMarker,
    updateWaypointMarkerPosition,
    clearWaypointMarkers,
    setWaypointMarkersVisible,
    animateCameraToWaypoint,
    getCurrentCameraState,
    resizeEngine,
    // Flip state tracking
    getSplatFlipState,
    setSplatFlipState,
    getAllSplatFlipStates,
    reapplyFlipAfterReload
  }
}
