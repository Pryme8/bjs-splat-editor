/**
 * Viewer Composable - Lightweight splat viewer for SQPZ files
 * Separate from the main editor, optimized for viewing only
 */

import { ref, onUnmounted } from 'vue'
import {
  Engine,
  Scene,
  ArcRotateCamera,
  Vector3,
  HemisphericLight,
  Color4
} from '@babylonjs/core'
import { GaussianSplattingMesh } from '@babylonjs/core/Meshes/GaussianSplatting/gaussianSplattingMesh'
import { ImportMeshAsync } from '@babylonjs/core/Loading/sceneLoader'
import { registerBuiltInLoaders } from "@babylonjs/loaders/dynamic"
import type { SqpzFile } from '@/types/sqpz'
import { importSqpzFromBlob } from '@/services/SqpzFormat'

// Register Babylon loaders (including splat loader)
registerBuiltInLoaders()

let engine: Engine | null = null
let scene: Scene | null = null
let camera: ArcRotateCamera | null = null
const splatMeshes: GaussianSplattingMesh[] = []
let currentWaypointIndex = ref(0)
let isAnimating = ref(false)

export function useViewer() {
  const isReady = ref(false)
  const isLoading = ref(false)
  const error = ref<string | null>(null)

  /**
   * Initialize the viewer scene
   */
  function initScene(canvas: HTMLCanvasElement, sqpzData: SqpzFile) {
    try {
      // If already initialized, dispose first
      if (engine || scene) {
        console.log('[Viewer] Disposing existing viewer before re-initializing')
        dispose()
      }
      
      // Create engine
      engine = new Engine(canvas, true, {
        useHighPrecisionMatrix: true,
        premultipliedAlpha: false,
        preserveDrawingBuffer: true,
        antialias: true,
        stencil: false,
        powerPreference: 'high-performance'
      })

      // Create scene
      scene = new Scene(engine)
      scene.clearColor = Color4.FromHexString(sqpzData.metadata.scene.backgroundColor + 'FF')
      scene.skipFrustumClipping = true
      scene.skipPointerMovePicking = true
      scene.autoClear = true
      scene.autoClearDepthAndStencil = true

      // Create camera from metadata
      camera = new ArcRotateCamera(
        'viewerCamera',
        sqpzData.metadata.camera.alpha,
        sqpzData.metadata.camera.beta,
        sqpzData.metadata.camera.radius,
        new Vector3(
          sqpzData.metadata.camera.target.x,
          sqpzData.metadata.camera.target.y,
          sqpzData.metadata.camera.target.z
        ),
        scene
      )

      camera.attachControl(canvas, true)
      camera.wheelPrecision = 50
      camera.pinchPrecision = 50
      camera.panningSensibility = 50
      camera.minZ = 0.1
      camera.maxZ = 10000
      
      // Use natural zoom - zoom speed is proportional to distance (faster when far, slower when close)
      camera.useNaturalPinchZoom = true

      // Limit camera movement
      camera.lowerRadiusLimit = camera.minZ  // Match minimum distance to near clipping plane
      camera.upperRadiusLimit = 1000
      camera.lowerBetaLimit = 0.1
      camera.upperBetaLimit = Math.PI - 0.1

      // Create light
      const light = new HemisphericLight('viewerLight', new Vector3(0, 1, 0), scene)
      light.intensity = 1.0

      // Start render loop
      engine.runRenderLoop(() => {
        if (scene) {
          scene.render()
        }
      })
      
      console.log('[Viewer] Camera initialized at:', {
        alpha: camera.alpha,
        beta: camera.beta,
        radius: camera.radius,
        target: camera.target,
        position: camera.position
      })

      // Handle resize
      window.addEventListener('resize', handleResize)

      isReady.value = true
      console.log('[Viewer] Scene initialized')
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to initialize viewer'
      console.error('[Viewer] Initialization error:', e)
    }
  }

  /**
   * Load splats from SQPZ data
   */
  async function loadSplats(sqpzData: SqpzFile, splatBuffers: ArrayBuffer[]) {
    if (!scene) {
      error.value = 'Scene not initialized'
      return
    }

    isLoading.value = true
    error.value = null

    try {
      // Clear any existing splats
      clearSplats()

      // Load each splat
      for (let i = 0; i < sqpzData.splats.length; i++) {
        const splatInfo = sqpzData.splats[i]
        const buffer = splatBuffers[i]
        const transform = sqpzData.transforms[i]

        console.log('[Viewer] Loading splat:', splatInfo.name)

        // Create blob from buffer
        const blob = new Blob([buffer], { type: 'application/octet-stream' })
        const url = URL.createObjectURL(blob)

        try {
          // Determine file extension for proper loader selection
          const extension = splatInfo.name.split('.').pop()?.toLowerCase() || 'splat'
          const pluginExtension = '.' + extension

          // Use ImportMeshAsync to load the splat
          const result = await ImportMeshAsync(url, scene, {
            pluginExtension: pluginExtension,
            pluginOptions: {
              splat: { keepInRam: false }
            }
          })

          if (result.meshes.length === 0) {
            throw new Error('No meshes loaded from file')
          }

          // Get the splat mesh (first mesh)
          const splatMesh = result.meshes[0] as GaussianSplattingMesh
          splatMesh.name = splatInfo.name

          // Dispose any extra meshes
          if (result.meshes.length > 1) {
            for (let j = 1; j < result.meshes.length; j++) {
              result.meshes[j].dispose()
            }
          }

          // Apply transform
          if (transform) {
            splatMesh.position.set(
              transform.position.x,
              transform.position.y,
              transform.position.z
            )
            splatMesh.rotation.set(
              transform.rotation.x,
              transform.rotation.y,
              transform.rotation.z
            )
            splatMesh.scaling.set(
              transform.scale.x,
              transform.scale.y,
              transform.scale.z
            )
          }

          splatMeshes.push(splatMesh)
        } finally {
          URL.revokeObjectURL(url)
        }
      }

      console.log('[Viewer] Loaded', splatMeshes.length, 'splats')
      
      // Log camera and splat positions for debugging
      if (camera && splatMeshes.length > 0) {
        console.log('[Viewer] Camera state:', {
          alpha: camera.alpha,
          beta: camera.beta,
          radius: camera.radius,
          target: camera.target
        })
        splatMeshes.forEach((mesh, idx) => {
          console.log(`[Viewer] Splat ${idx}:`, {
            position: mesh.position,
            rotation: mesh.rotation,
            scaling: mesh.scaling,
            visible: mesh.isVisible,
            enabled: mesh.isEnabled()
          })
        })
      }
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to load splats'
      console.error('[Viewer] Load error:', e)
    } finally {
      isLoading.value = false
    }
  }

  /**
   * Clear all splats from scene
   */
  function clearSplats() {
    splatMeshes.forEach(mesh => mesh.dispose())
    splatMeshes.length = 0
  }

  /**
   * Animate camera to waypoint
   */
  function goToWaypoint(index: number, waypoints: SqpzFile['waypoints'], duration: number = 1000): Promise<void> {
    return new Promise((resolve) => {
      if (!camera || !waypoints[index]) {
        resolve()
        return
      }

      isAnimating.value = true
      const waypoint = waypoints[index]
      currentWaypointIndex.value = index

      const startAlpha = camera.alpha
      const startBeta = camera.beta
      const startRadius = camera.radius
      const startTarget = camera.target.clone()
      const endTarget = new Vector3(waypoint.target.x, waypoint.target.y, waypoint.target.z)

      const startTime = Date.now()

      const animate = () => {
        const elapsed = Date.now() - startTime
        const t = Math.min(elapsed / duration, 1)

        // Ease-in-out
        const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t

        camera.alpha = startAlpha + (waypoint.alpha - startAlpha) * ease
        camera.beta = startBeta + (waypoint.beta - startBeta) * ease
        camera.radius = startRadius + (waypoint.radius - startRadius) * ease
        camera.target = Vector3.Lerp(startTarget, endTarget, ease)

        if (t < 1) {
          requestAnimationFrame(animate)
        } else {
          isAnimating.value = false
          resolve()
        }
      }

      animate()
    })
  }

  /**
   * Navigate to next waypoint
   */
  async function nextWaypoint(waypoints: SqpzFile['waypoints']) {
    if (waypoints.length === 0) return
    const nextIndex = (currentWaypointIndex.value + 1) % waypoints.length
    await goToWaypoint(nextIndex, waypoints)
  }

  /**
   * Navigate to previous waypoint
   */
  async function prevWaypoint(waypoints: SqpzFile['waypoints']) {
    if (waypoints.length === 0) return
    const prevIndex = currentWaypointIndex.value === 0 
      ? waypoints.length - 1 
      : currentWaypointIndex.value - 1
    await goToWaypoint(prevIndex, waypoints)
  }

  /**
   * Handle window resize
   */
  function handleResize() {
    if (engine) {
      engine.resize()
    }
  }

  /**
   * Resize engine (call when canvas size changes)
   */
  function resizeEngine() {
    if (engine) {
      engine.resize()
      console.log('[Viewer] Engine resized')
    }
  }

  /**
   * Dispose viewer resources
   */
  function dispose() {
    window.removeEventListener('resize', handleResize)
    
    clearSplats()
    
    if (scene) {
      scene.dispose()
      scene = null
    }
    
    if (engine) {
      engine.dispose()
      engine = null
    }
    
    camera = null
    isReady.value = false
    
    console.log('[Viewer] Disposed')
  }

  // Auto cleanup
  onUnmounted(() => {
    dispose()
  })

  return {
    isReady,
    isLoading,
    isAnimating,
    error,
    currentWaypointIndex,
    initScene,
    loadSplats,
    clearSplats,
    goToWaypoint,
    nextWaypoint,
    prevWaypoint,
    resizeEngine,
    dispose
  }
}
