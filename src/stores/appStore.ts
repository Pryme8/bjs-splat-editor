import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { SqpzFile } from '@/types/sqpz'

export interface SplatFile {
  name: string
  size: number
  type: 'ply' | 'splat' | 'spz'
  url: string
  isPreview?: boolean  // True for intermediate/preview files during generation
  skipFlipPrompt?: boolean  // True for SQPZ imports that handle flip state via metadata
}

export const useAppStore = defineStore('app', () => {
  const currentFile = ref<SplatFile | null>(null)
  const isLoading = ref(false)
  const error = ref<string | null>(null)
  const undoStack = ref<unknown[]>([])
  const redoStack = ref<unknown[]>([])
  
  // Panel visibility
  const showRightPanel = ref(true)
  const showConsolePanel = ref(false)  // Start collapsed
  
  // Viewer mode
  const viewerMode = ref(false)
  const currentSqpzData = ref<SqpzFile | null>(null)
  const currentSqpzBuffers = ref<ArrayBuffer[]>([])

  const hasScene = computed(() => currentFile.value !== null)
  const canUndo = computed(() => undoStack.value.length > 0)
  const canRedo = computed(() => redoStack.value.length > 0)

  async function loadFile(file: File) {
    isLoading.value = true
    error.value = null

    try {
      const extension = file.name.split('.').pop()?.toLowerCase()
      if (!extension || !['ply', 'splat', 'spz'].includes(extension)) {
        throw new Error('Unsupported file format')
      }

      const url = URL.createObjectURL(file)
      
      currentFile.value = {
        name: file.name,
        size: file.size,
        type: extension as 'ply' | 'splat' | 'spz',
        url
      }

      // Clear undo/redo on new file load
      undoStack.value = []
      redoStack.value = []
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to load file'
      throw e
    } finally {
      isLoading.value = false
    }
  }

  async function loadFromBlob(blob: Blob, name: string = 'preview.ply', isPreview: boolean = true, skipFlipPrompt: boolean = false) {
    // Revoke previous URL if exists
    if (currentFile.value?.url) {
      console.log('[AppStore] Revoking previous blob URL:', currentFile.value.name)
      URL.revokeObjectURL(currentFile.value.url)
    }

    const url = URL.createObjectURL(blob)
    const extension = name.split('.').pop()?.toLowerCase() || 'ply'
    
    currentFile.value = {
      name,
      size: blob.size,
      type: extension as 'ply' | 'splat' | 'spz',
      url,
      isPreview,
      skipFlipPrompt
    }
    
    console.log('[AppStore] Created new blob URL:', name, 'size:', blob.size, 'bytes, isPreview:', isPreview)
  }

  function setCurrentFile(file: SplatFile) {
    // Revoke previous URL if exists
    if (currentFile.value?.url) {
      URL.revokeObjectURL(currentFile.value.url)
    }
    currentFile.value = file
    console.log('[AppStore] Current file set to', file.name)
  }

  function clearScene() {
    if (currentFile.value?.url) {
      URL.revokeObjectURL(currentFile.value.url)
    }
    currentFile.value = null
    undoStack.value = []
    redoStack.value = []
  }

  function pushUndo(state: unknown) {
    undoStack.value.push(state)
    redoStack.value = []
  }

  function undo() {
    const state = undoStack.value.pop()
    if (state) {
      redoStack.value.push(state)
    }
    return state
  }

  function redo() {
    const state = redoStack.value.pop()
    if (state) {
      undoStack.value.push(state)
    }
    return state
  }
  
  function toggleRightPanel() {
    showRightPanel.value = !showRightPanel.value
  }
  
  function setRightPanelVisible(visible: boolean) {
    showRightPanel.value = visible
  }
  
  function toggleConsolePanel() {
    showConsolePanel.value = !showConsolePanel.value
  }
  
  function setConsolePanelVisible(visible: boolean) {
    showConsolePanel.value = visible
  }
  
  function toggleViewerMode() {
    viewerMode.value = !viewerMode.value
  }
  
  function setViewerMode(enabled: boolean) {
    viewerMode.value = enabled
  }
  
  function setCurrentSqpzData(data: SqpzFile | null, buffers: ArrayBuffer[] = []) {
    currentSqpzData.value = data
    currentSqpzBuffers.value = buffers
  }

  return {
    currentFile,
    isLoading,
    error,
    showRightPanel,
    showConsolePanel,
    viewerMode,
    currentSqpzData,
    currentSqpzBuffers,
    hasScene,
    canUndo,
    canRedo,
    loadFile,
    loadFromBlob,
    setCurrentFile,
    clearScene,
    pushUndo,
    undo,
    redo,
    toggleRightPanel,
    setRightPanelVisible,
    toggleConsolePanel,
    setConsolePanelVisible,
    toggleViewerMode,
    setViewerMode,
    setCurrentSqpzData
  }
})
