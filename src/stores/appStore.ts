import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export interface SplatFile {
  name: string
  size: number
  type: 'ply' | 'splat' | 'spz'
  url: string
  isPreview?: boolean  // True for intermediate/preview files during generation
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

  async function loadFromBlob(blob: Blob, name: string = 'preview.ply', isPreview: boolean = true) {
    // Revoke previous URL if exists
    if (currentFile.value?.url) {
      URL.revokeObjectURL(currentFile.value.url)
    }

    const url = URL.createObjectURL(blob)
    const extension = name.split('.').pop()?.toLowerCase() || 'ply'
    
    currentFile.value = {
      name,
      size: blob.size,
      type: extension as 'ply' | 'splat' | 'spz',
      url,
      isPreview
    }
    
    console.log('[AppStore] Loaded blob as', name, 'size:', blob.size, 'isPreview:', isPreview)
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

  return {
    currentFile,
    isLoading,
    error,
    showRightPanel,
    showConsolePanel,
    hasScene,
    canUndo,
    canRedo,
    loadFile,
    loadFromBlob,
    clearScene,
    pushUndo,
    undo,
    redo,
    toggleRightPanel,
    setRightPanelVisible,
    toggleConsolePanel,
    setConsolePanelVisible
  }
})
