import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export interface SplatObject {
  id: string
  name: string
  visible: boolean
  splatCount: number
  isPreview?: boolean
}

export interface SelectionState {
  objectId: string | null
  splatIndices: number[]
}

export const useSceneStore = defineStore('scene', () => {
  const objects = ref<SplatObject[]>([])
  const selection = ref<SelectionState>({
    objectId: null,
    splatIndices: []
  })

  const selectedObject = computed(() => {
    if (!selection.value.objectId) return null
    return objects.value.find(o => o.id === selection.value.objectId) ?? null
  })

  const hasSelection = computed(() => selection.value.objectId !== null)
  
  const hasPreviewObject = computed(() => objects.value.some(o => o.isPreview))
  
  const previewObject = computed(() => objects.value.find(o => o.isPreview) ?? null)

  function addObject(obj: SplatObject) {
    objects.value.push(obj)
  }
  
  function addOrUpdatePreview(splatCount: number) {
    const existing = objects.value.find(o => o.isPreview)
    if (existing) {
      existing.splatCount = splatCount
    } else {
      objects.value.push({
        id: 'preview',
        name: 'Preview (generating...)',
        visible: true,
        splatCount,
        isPreview: true
      })
    }
  }
  
  function updatePreviewSplatCount(splatCount: number) {
    const preview = objects.value.find(o => o.isPreview)
    if (preview) {
      preview.splatCount = splatCount
    } else {
      // Create preview entry if it doesn't exist
      addOrUpdatePreview(splatCount)
    }
  }
  
  function clearPreview() {
    const index = objects.value.findIndex(o => o.isPreview)
    if (index >= 0) {
      objects.value.splice(index, 1)
    }
  }

  function removeObject(id: string) {
    const index = objects.value.findIndex(o => o.id === id)
    if (index >= 0) {
      objects.value.splice(index, 1)
      if (selection.value.objectId === id) {
        clearSelection()
      }
    }
  }

  function selectObject(id: string) {
    selection.value = {
      objectId: id,
      splatIndices: []
    }
  }

  function selectSplats(objectId: string, indices: number[]) {
    selection.value = {
      objectId,
      splatIndices: indices
    }
  }

  function clearSelection() {
    selection.value = {
      objectId: null,
      splatIndices: []
    }
  }

  function toggleVisibility(id: string) {
    const obj = objects.value.find(o => o.id === id)
    if (obj) {
      obj.visible = !obj.visible
    }
  }

  function updateSplatCount(splatCount: number) {
    // Update the first non-preview object's splat count
    const obj = objects.value.find(o => !o.isPreview)
    if (obj) {
      obj.splatCount = splatCount
    }
  }

  function clearAll() {
    objects.value = []
    clearSelection()
  }

  return {
    objects,
    selection,
    selectedObject,
    hasSelection,
    hasPreviewObject,
    previewObject,
    addObject,
    addOrUpdatePreview,
    updatePreviewSplatCount,
    updateSplatCount,
    clearPreview,
    removeObject,
    selectObject,
    selectSplats,
    clearSelection,
    toggleVisibility,
    clearAll
  }
})
