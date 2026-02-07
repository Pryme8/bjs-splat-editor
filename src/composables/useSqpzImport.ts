/**
 * SQPZ Import Composable
 * High-level logic for importing SQPZ files into the workspace
 */

import { useAppStore } from '@/stores/appStore'
import { useEditorStore } from '@/stores/editorStore'
import { useWaypointStore } from '@/stores/waypointStore'
import { useSceneStore } from '@/stores/sceneStore'
import { useBabylon } from '@/composables/useBabylon'
import { importSqpzFromBlob, getSplatBlobFromBuffer } from '@/services/SqpzFormat'
import type { SqpzFile } from '@/types/sqpz'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'

export function useSqpzImport() {
  const appStore = useAppStore()
  const editorStore = useEditorStore()
  const waypointStore = useWaypointStore()
  const sceneStore = useSceneStore()
  const babylon = useBabylon()

  /**
   * Import SQPZ file into the workspace
   */
  async function importWorkspace(file: File): Promise<boolean> {
    try {
      console.log('[SqpzImport] Importing:', file.name)

      // Parse SQPZ file
      const { file: sqpzFile, isDevelopmentFile, splatBuffers } = await importSqpzFromBlob(file)

      // Clear current workspace
      clearWorkspace()

      // Load splats
      await loadSplats(sqpzFile, splatBuffers)

      // Restore waypoints
      restoreWaypoints(sqpzFile)

      // Restore editor state if development file
      if (isDevelopmentFile && sqpzFile.editorData) {
        restoreEditorState(sqpzFile)
      }

      // Apply camera state from metadata
      const cameraState = sqpzFile.metadata.camera
      await babylon.animateCameraToWaypoint(
        cameraState.alpha,
        cameraState.beta,
        cameraState.radius,
        new Vector3(cameraState.target.x, cameraState.target.y, cameraState.target.z),
        500
      )

      // Apply scene settings
      editorStore.showGroundPlane = sqpzFile.metadata.scene.showGrid
      editorStore.showAxes = sqpzFile.metadata.scene.showAxes

      console.log('[SqpzImport] Import complete:', {
        splats: sqpzFile.splats.length,
        waypoints: sqpzFile.waypoints.length,
        developmentFile: isDevelopmentFile
      })

      return true
    } catch (error) {
      console.error('[SqpzImport] Import failed:', error)
      return false
    }
  }

  /**
   * Load splats from SQPZ file
   */
  async function loadSplats(sqpzFile: SqpzFile, splatBuffers: ArrayBuffer[]) {
    for (let i = 0; i < sqpzFile.splats.length; i++) {
      const splatInfo = sqpzFile.splats[i]
      const { blob, name, type } = getSplatBlobFromBuffer(splatBuffers[i], splatInfo.name, splatInfo.type)
      const transform = sqpzFile.transforms[i]

      // Load the splat directly, bypassing loadFromBlob to avoid duplicate load via watcher
      // We pass skipFlipPrompt=true because we handle flip state via SQPZ metadata
      const url = URL.createObjectURL(blob)
      const objectId = await babylon.loadSplat(url, name, false, false, undefined, true)
      
      if (!objectId) {
        console.error('[SqpzImport] Failed to load splat:', name)
        URL.revokeObjectURL(url)
        continue
      }

      // If this splat was previously flipped and baked, just mark the flip state
      // The baked file + Babylon's -Y scale = correct orientation
      // IMPORTANT: For flipped splats, we must keep Babylon's -Y scale, so override the saved scale.y
      if (splatInfo.wasFlipped) {
        babylon.setSplatFlipState(objectId, true)
        console.log('[SqpzImport] Marked flip state (will preserve Babylon\'s -Y scale)')
      }

      // Now apply the saved transform
      // For flipped splats, negate scale.y to account for Babylon's -Y coordinate system
      if (transform) {
        const scaleY = splatInfo.wasFlipped ? -transform.scale.y : transform.scale.y
        babylon.applySplatTransform(
          { x: transform.position.x, y: transform.position.y, z: transform.position.z },
          { x: transform.rotation.x, y: transform.rotation.y, z: transform.rotation.z },
          { x: transform.scale.x, y: scaleY, z: transform.scale.z }
        )
        babylon.syncTransformToStore()
      }

      // Update appStore.currentFile to reflect the loaded splat
      // This removes the drop file prompt and updates UI
      // We use setCurrentFile with the same URL to prevent watcher from reloading
      appStore.setCurrentFile({
        name,
        size: blob.size,
        type: type,
        url: url, // Use the same URL we already loaded
        isPreview: false,
        skipFlipPrompt: true
      })

      console.log('[SqpzImport] Loaded splat:', name, 'with transform (wasFlipped:', splatInfo.wasFlipped, ')')
    }
  }

  /**
   * Restore waypoints and create 3D markers
   */
  function restoreWaypoints(sqpzFile: SqpzFile) {
    waypointStore.importFromSqpz(sqpzFile.waypoints)

    // Create 3D markers for each waypoint
    waypointStore.waypoints.forEach((waypoint) => {
      const target = new Vector3(
        waypoint.target.x,
        waypoint.target.y,
        waypoint.target.z
      )
      babylon.createWaypointMarker(
        waypoint.id, 
        waypoint.alpha, 
        waypoint.beta, 
        waypoint.radius, 
        target, 
        waypoint.name
      )
    })

    console.log('[SqpzImport] Restored', waypointStore.waypointCount, 'waypoints')
  }

  /**
   * Restore editor state from development file
   * Only restores persistent editing state (clipping tools, active object)
   */
  function restoreEditorState(sqpzFile: SqpzFile) {
    const editorData = sqpzFile.editorData
    if (!editorData) return

    // Restore clipping sphere
    if (editorData.clipSphere) {
      editorStore.clipSphere.enabled = editorData.clipSphere.enabled
      editorStore.clipSphere.center = { ...editorData.clipSphere.center }
      editorStore.clipSphere.radius = editorData.clipSphere.radius
      
      if (editorData.clipSphere.enabled) {
        babylon.setClipSphereVisible(true)
        babylon.updateClipSpherePosition(
          editorData.clipSphere.center.x,
          editorData.clipSphere.center.y,
          editorData.clipSphere.center.z
        )
        babylon.updateClipSphereRadius(editorData.clipSphere.radius)
      }
    }

    // Restore clipping box
    if (editorData.clipBox) {
      editorStore.clipBox.enabled = editorData.clipBox.enabled
      editorStore.clipBox.center = { ...editorData.clipBox.center }
      editorStore.clipBox.size = { ...editorData.clipBox.size }
      
      if (editorData.clipBox.enabled) {
        babylon.setClipBoxVisible(true)
        babylon.updateClipBoxPosition(
          editorData.clipBox.center.x,
          editorData.clipBox.center.y,
          editorData.clipBox.center.z
        )
        babylon.updateClipBoxSize(
          editorData.clipBox.size.x,
          editorData.clipBox.size.y,
          editorData.clipBox.size.z
        )
      }
    }

    // Restore active object ID
    if (editorData.activeObjectId) {
      editorStore.setActiveObject(editorData.activeObjectId)
    }

    console.log('[SqpzImport] Restored editor state (clipping tools, active object)')
  }

  /**
   * Clear current workspace
   */
  function clearWorkspace() {
    // Clear scene
    sceneStore.clearAll()
    
    // Clear waypoints and markers
    babylon.clearWaypointMarkers()
    waypointStore.clearAll()
    
    // Clear editor state
    editorStore.clearSelection()
    editorStore.clearHistory()
    editorStore.resetClipSphere()
    editorStore.resetClipBox()
    
    // Clear Babylon scene
    babylon.clearAllSplats()
    
    console.log('[SqpzImport] Workspace cleared')
  }

  return {
    importWorkspace,
    clearWorkspace
  }
}
