/**
 * Generator Composable - Bridge between generator and Babylon scene
 */

import { computed } from 'vue'
import { useGeneratorStore } from '@/stores/generatorStore'
import { useAppStore } from '@/stores/appStore'
import { useSceneStore } from '@/stores/sceneStore'
import { useBabylon } from '@/composables/useBabylon'
import { exportToPly, exportToSplat, downloadPly, downloadSplat } from '@/services/PlyExporter'
import { BackendApi } from '@/services/BackendApi'
import type { GenerationResult } from '@/generator/GeneratorService'

export function useGenerator() {
  const generatorStore = useGeneratorStore()
  const appStore = useAppStore()
  const sceneStore = useSceneStore()
  const babylon = useBabylon()

  const hasResult = computed(() => generatorStore.result !== null)
  const isGenerating = computed(() => generatorStore.isGenerating)
  const progress = computed(() => generatorStore.progress)

  /**
   * Load generation result into the Babylon scene
   */
  async function loadResultToScene(name: string = 'Generated Splats') {
    const result = generatorStore.result as any
    if (!result) {
      throw new Error('No generation result available')
    }

    try {
      let splatBlob: Blob
      let url: string

      // Check if result came from backend (has _blob property)
      if (result._blob) {
        console.log('[useGenerator] Loading backend result blob')
        splatBlob = result._blob
        url = URL.createObjectURL(splatBlob)
      } else {
        // Convert browser result to .splat format
        console.log('[useGenerator] Converting browser result to splat')
        splatBlob = exportToSplat(result)
        url = URL.createObjectURL(splatBlob)
      }

      // Update app store - the watcher in useBabylon will handle loading
      appStore.currentFile = {
        name: `${name}.splat`,
        size: splatBlob.size,
        type: 'splat',
        url
      }

      return true
    } catch (e) {
      console.error('Failed to load generated splats:', e)
      appStore.error = 'Failed to load generated splats'
      return false
    }
  }

  /**
   * Download generation result as PLY file
   */
  function downloadAsPly(filename: string = 'generated-splats.ply') {
    const result = generatorStore.result as any
    if (!result) {
      throw new Error('No generation result available')
    }
    
    // For backend results, we have the original blob
    if (result._blob) {
      console.log('[useGenerator] Downloading backend PLY blob:', result._blob.size, 'bytes')
      downloadBlob(result._blob, filename)
    } else {
      // For browser-generated results, export from arrays
      downloadPly(result, filename)
    }
  }

  /**
   * Download generation result as .splat file
   */
  function downloadAsSplat(filename: string = 'generated-splats.splat') {
    const result = generatorStore.result as any
    if (!result) {
      throw new Error('No generation result available')
    }
    
    // For backend results, we have the original blob (which is PLY format)
    // For now, download as PLY since that's what the backend produces
    if (result._blob) {
      console.log('[useGenerator] Downloading backend blob as splat:', result._blob.size, 'bytes')
      // The backend produces PLY, so download that with .ply extension
      // TODO: Add server-side conversion to .splat format
      downloadBlob(result._blob, filename.replace('.splat', '.ply'))
    } else {
      // For browser-generated results, export from arrays
      downloadSplat(result, filename)
    }
  }
  
  /**
   * Helper to download a blob directly
   */
  function downloadBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  /**
   * Get splat count from result
   */
  function getSplatCount(): number {
    return generatorStore.result?.opacities.length ?? 0
  }

  /**
   * Clear generation result
   */
  function clearResult() {
    generatorStore.reset()
  }

  return {
    // State
    hasResult,
    isGenerating,
    progress,

    // Actions
    loadResultToScene,
    downloadAsPly,
    downloadAsSplat,
    getSplatCount,
    clearResult,

    // Direct store access for advanced usage
    store: generatorStore
  }
}
