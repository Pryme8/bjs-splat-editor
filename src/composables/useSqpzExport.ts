/**
 * SQPZ Export Composable
 * High-level logic for exporting workspace to SQPZ format
 */

import { useAppStore } from '@/stores/appStore'
import { useEditorStore } from '@/stores/editorStore'
import { useWaypointStore } from '@/stores/waypointStore'
import { useSceneStore } from '@/stores/sceneStore'
import { useBabylon } from '@/composables/useBabylon'
import { createSqpzData, downloadSqpz } from '@/services/SqpzFormat'
import type { SqpzFile, SqpzExportOptions, SqpzMetadata, SqpzEditorData } from '@/types/sqpz'

export function useSqpzExport() {
  const appStore = useAppStore()
  const editorStore = useEditorStore()
  const waypointStore = useWaypointStore()
  const sceneStore = useSceneStore()
  const babylon = useBabylon()

  /**
   * Export current workspace to SQPZ format
   */
  async function exportWorkspace(options: SqpzExportOptions): Promise<{ file: SqpzFile; buffers: ArrayBuffer[] } | null> {
    try {
      // Gather all splat data from the scene
      const splats: Array<{ name: string; blob: Blob; type: 'ply' | 'splat' | 'spz'; wasFlipped: boolean }> = []
      const transforms: SqpzFile['transforms'] = []

      // Get all loaded splats from the scene store
      const allObjects = sceneStore.objects
      if (allObjects.length === 0) {
        throw new Error('No splats loaded in workspace')
      }

      console.log('[SqpzExport] Exporting', allObjects.length, 'splat(s)')

      // Iterate through all splats in the scene
      for (const obj of allObjects) {
        const objectId = obj.id
        
        // Get the working blob (clipped/edited version) from Babylon
        const fileData = babylon.getOriginalFile(objectId)
        if (!fileData) {
          console.warn('[SqpzExport] Could not retrieve splat data for', objectId, '- skipping')
          continue
        }

        // Get flip state for the splat
        const wasFlipped = babylon.getSplatFlipState(objectId)

        // Determine file type from name extension
        const extension = fileData.name.split('.').pop()?.toLowerCase() as 'ply' | 'splat' | 'spz' | undefined
        const type = extension || 'ply'

        splats.push({
          name: fileData.name,
          blob: fileData.blob,
          type: type,
          wasFlipped: wasFlipped
        })

        // Get transform for this splat by temporarily setting it as active
        const previousActiveId = editorStore.activeObjectId
        editorStore.setActiveObject(objectId)
        babylon.syncTransformToStore()
        
        // For flipped splats, negate scale.y to convert from Babylon's coordinate system
        // to the logical scale (Babylon stores -1 for flipped splats, we save 1)
        const scaleY = wasFlipped ? -editorStore.splatTransform.scale.y : editorStore.splatTransform.scale.y
        
        transforms.push({
          position: { ...editorStore.splatTransform.position },
          rotation: { ...editorStore.splatTransform.rotation },
          scale: { 
            x: editorStore.splatTransform.scale.x, 
            y: scaleY, 
            z: editorStore.splatTransform.scale.z 
          }
        })
        
        // Restore previous active object
        if (previousActiveId && previousActiveId !== objectId) {
          editorStore.setActiveObject(previousActiveId)
          babylon.syncTransformToStore()
        }

        console.log('[SqpzExport] Added splat:', fileData.name, 'wasFlipped:', wasFlipped)
      }

      // Get waypoints
      const waypoints = waypointStore.exportToSqpz()

      // Get camera state
      const cameraState = babylon.getCurrentCameraState()
      if (!cameraState) {
        throw new Error('Unable to get camera state')
      }

      // Build metadata
      const metadata: SqpzMetadata = {
        projectName: options.projectName || 'Untitled Project',
        created: new Date().toISOString(),
        modified: new Date().toISOString(),
        appVersion: '0.1.0',
        camera: {
          alpha: cameraState.alpha,
          beta: cameraState.beta,
          radius: cameraState.radius,
          target: {
            x: cameraState.target.x,
            y: cameraState.target.y,
            z: cameraState.target.z
          }
        },
        scene: {
          backgroundColor: '#0D0D12',
          showGrid: editorStore.showGroundPlane,
          showAxes: editorStore.showAxes
        }
      }

      // Build editor data if in development mode
      // Only save state that makes sense to persist (not temporary UI state)
      let editorData: SqpzEditorData | undefined
      if (options.developmentMode) {
        editorData = {
          clipSphere: {
            enabled: editorStore.clipSphere.enabled,
            center: { ...editorStore.clipSphere.center },
            radius: editorStore.clipSphere.radius
          },
          clipBox: {
            enabled: editorStore.clipBox.enabled,
            center: { ...editorStore.clipBox.center },
            size: { ...editorStore.clipBox.size }
          },
          activeObjectId: editorStore.activeObjectId
        }
      }

      // Create SQPZ data structure
      const { file: sqpzFile, buffers } = await createSqpzData(
        splats,
        transforms,
        waypoints,
        metadata,
        editorData
      )

      console.log('[SqpzExport] Exported workspace:', {
        splats: sqpzFile.splats.length,
        waypoints: sqpzFile.waypoints.length,
        developmentMode: options.developmentMode
      })

      return { file: sqpzFile, buffers }
    } catch (error) {
      console.error('[SqpzExport] Export failed:', error)
      return null
    }
  }

  /**
   * Export and download SQPZ file
   */
  async function exportAndDownload(options: SqpzExportOptions): Promise<boolean> {
    const result = await exportWorkspace(options)
    if (!result) {
      return false
    }

    const filename = `${options.projectName || 'project'}${options.developmentMode ? '.dev' : ''}.sqpz`
    downloadSqpz(result.file, result.buffers, filename)
    return true
  }

  return {
    exportWorkspace,
    exportAndDownload
  }
}
