import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export type GizmoType = 'none' | 'rotate' | 'translate' | 'scale'
export type TransformSpace = 'local' | 'world'
export type CameraMode = 'fly' | 'orbit'
export type BrushMode = 'add' | 'remove'

export interface Transform {
  position: { x: number; y: number; z: number }
  rotation: { x: number; y: number; z: number }
  scale: { x: number; y: number; z: number }
}

// Command for undo/redo history
export interface TransformCommand {
  type: 'transform'
  before: Transform
  after: Transform
}

export interface ClipSphere {
  enabled: boolean
  center: { x: number; y: number; z: number }
  radius: number
}

export interface ClipBox {
  enabled: boolean
  center: { x: number; y: number; z: number }
  size: { x: number; y: number; z: number }
}

export interface SelectionState {
  indices: Set<number>
  brushEnabled: boolean
  brushRadius: number
  brushMode: BrushMode
}

const MAX_HISTORY_SIZE = 50

export const useEditorStore = defineStore('editor', () => {
  // Active object (for multi-splat support)
  const activeObjectId = ref<string | null>(null)
  
  // View helpers
  const showAxes = ref(true)
  const showGroundPlane = ref(true)
  const groundPlaneSize = ref(10)
  const groundPlaneOpacity = ref(0.5)
  
  // Gizmo state
  const activeGizmo = ref<GizmoType>('none')
  const transformSpace = ref<TransformSpace>('world')
  
  // Camera state
  const cameraMode = ref<CameraMode>('orbit')
  
  // Current splat transform (synced with Babylon mesh)
  const splatTransform = ref<Transform>({
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 }
  })
  
  // Undo/Redo history
  const undoStack = ref<TransformCommand[]>([])
  const redoStack = ref<TransformCommand[]>([])
  
  // Clipping sphere
  const clipSphere = ref<ClipSphere>({
    enabled: false,
    center: { x: 0, y: 0, z: 0 },
    radius: 5
  })
  
  // Clipping box
  const clipBox = ref<ClipBox>({
    enabled: false,
    center: { x: 0, y: 0, z: 0 },
    size: { x: 5, y: 5, z: 5 }
  })
  
  // Selection state
  const selection = ref<SelectionState>({
    indices: new Set<number>(),
    brushEnabled: false,
    brushRadius: 1,
    brushMode: 'add'
  })
  
  // Computed helpers
  const hasActiveObject = computed(() => activeObjectId.value !== null)
  const hasActiveGizmo = computed(() => activeGizmo.value !== 'none')
  const selectionCount = computed(() => selection.value.indices.size)
  const hasSelection = computed(() => selection.value.indices.size > 0)
  const canUndo = computed(() => undoStack.value.length > 0)
  const canRedo = computed(() => redoStack.value.length > 0)
  
  // Helper to deep clone a transform
  function cloneTransform(t: Transform): Transform {
    return {
      position: { ...t.position },
      rotation: { ...t.rotation },
      scale: { ...t.scale }
    }
  }

  // Push a command to history (clears redo stack)
  function pushCommand(command: TransformCommand) {
    undoStack.value.push(command)
    if (undoStack.value.length > MAX_HISTORY_SIZE) {
      undoStack.value.shift()
    }
    redoStack.value = []
  }

  // Get current transform snapshot
  function getTransformSnapshot(): Transform {
    return cloneTransform(splatTransform.value)
  }

  // Actions
  function toggleAxes() {
    showAxes.value = !showAxes.value
  }
  
  function toggleGroundPlane() {
    showGroundPlane.value = !showGroundPlane.value
  }
  
  function setActiveGizmo(gizmo: GizmoType) {
    activeGizmo.value = gizmo
  }
  
  function setTransformSpace(space: TransformSpace) {
    transformSpace.value = space
  }
  
  function toggleTransformSpace() {
    transformSpace.value = transformSpace.value === 'local' ? 'world' : 'local'
  }
  
  function setCameraMode(mode: CameraMode) {
    cameraMode.value = mode
  }
  
  // Active object actions
  function setActiveObject(id: string | null) {
    // Clear selection when switching objects
    if (activeObjectId.value !== id) {
      clearSelection()
    }
    activeObjectId.value = id
  }
  
  function clearActiveObject() {
    clearSelection()
    activeObjectId.value = null
  }
  
  function setGroundPlaneSize(size: number) {
    groundPlaneSize.value = Math.max(1, Math.min(100, size))
  }
  
  function updateTransform(transform: Partial<Transform>) {
    if (transform.position) {
      splatTransform.value.position = { ...transform.position }
    }
    if (transform.rotation) {
      splatTransform.value.rotation = { ...transform.rotation }
    }
    if (transform.scale) {
      splatTransform.value.scale = { ...transform.scale }
    }
  }
  
  function resetTransform() {
    splatTransform.value = {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 }
    }
  }

  // Undo last transform - returns the transform to apply, or null if nothing to undo
  function undo(): Transform | null {
    const command = undoStack.value.pop()
    if (!command) return null

    redoStack.value.push(command)
    splatTransform.value = cloneTransform(command.before)
    return cloneTransform(command.before)
  }

  // Redo last undone transform - returns the transform to apply, or null if nothing to redo
  function redo(): Transform | null {
    const command = redoStack.value.pop()
    if (!command) return null

    undoStack.value.push(command)
    splatTransform.value = cloneTransform(command.after)
    return cloneTransform(command.after)
  }

  // Clear all history
  function clearHistory() {
    undoStack.value = []
    redoStack.value = []
  }
  
  // Clipping sphere actions
  function toggleClipSphere() {
    clipSphere.value.enabled = !clipSphere.value.enabled
  }
  
  function setClipSphereEnabled(enabled: boolean) {
    clipSphere.value.enabled = enabled
  }
  
  function setClipSphereCenter(x: number, y: number, z: number) {
    clipSphere.value.center = { x, y, z }
  }
  
  function setClipSphereRadius(radius: number) {
    clipSphere.value.radius = Math.max(0.1, radius)
  }
  
  function resetClipSphere() {
    clipSphere.value = {
      enabled: false,
      center: { x: 0, y: 0, z: 0 },
      radius: 5
    }
  }
  
  // Clipping box actions
  function toggleClipBox() {
    clipBox.value.enabled = !clipBox.value.enabled
  }
  
  function setClipBoxEnabled(enabled: boolean) {
    clipBox.value.enabled = enabled
  }
  
  function setClipBoxCenter(x: number, y: number, z: number) {
    clipBox.value.center = { x, y, z }
  }
  
  function setClipBoxSize(x: number, y: number, z: number) {
    clipBox.value.size = { 
      x: Math.max(0.1, x), 
      y: Math.max(0.1, y), 
      z: Math.max(0.1, z) 
    }
  }
  
  function resetClipBox() {
    clipBox.value = {
      enabled: false,
      center: { x: 0, y: 0, z: 0 },
      size: { x: 5, y: 5, z: 5 }
    }
  }
  
  // Selection actions
  function toggleSelectionBrush() {
    selection.value.brushEnabled = !selection.value.brushEnabled
  }
  
  function setSelectionBrushEnabled(enabled: boolean) {
    selection.value.brushEnabled = enabled
  }
  
  function setSelectionBrushRadius(radius: number) {
    selection.value.brushRadius = Math.max(0.1, radius)
  }
  
  function setSelectionBrushMode(mode: BrushMode) {
    selection.value.brushMode = mode
  }
  
  function addToSelection(indices: number[]) {
    for (const idx of indices) {
      selection.value.indices.add(idx)
    }
  }
  
  function removeFromSelection(indices: number[]) {
    for (const idx of indices) {
      selection.value.indices.delete(idx)
    }
  }
  
  function clearSelection() {
    selection.value.indices = new Set<number>()
  }
  
  function selectAll(totalCount: number) {
    selection.value.indices = new Set<number>(
      Array.from({ length: totalCount }, (_, i) => i)
    )
  }
  
  function invertSelection(totalCount: number) {
    const newSelection = new Set<number>()
    for (let i = 0; i < totalCount; i++) {
      if (!selection.value.indices.has(i)) {
        newSelection.add(i)
      }
    }
    selection.value.indices = newSelection
  }
  
  function resetSelection() {
    selection.value = {
      indices: new Set<number>(),
      brushEnabled: false,
      brushRadius: 1,
      brushMode: 'add'
    }
  }
  
  return {
    // State
    activeObjectId,
    showAxes,
    showGroundPlane,
    groundPlaneSize,
    groundPlaneOpacity,
    activeGizmo,
    transformSpace,
    cameraMode,
    splatTransform,
    clipSphere,
    clipBox,
    
    // Computed
    hasActiveObject,
    hasActiveGizmo,
    canUndo,
    canRedo,
    
    // Actions
    setActiveObject,
    clearActiveObject,
    toggleAxes,
    toggleGroundPlane,
    setActiveGizmo,
    setTransformSpace,
    toggleTransformSpace,
    setCameraMode,
    setGroundPlaneSize,
    updateTransform,
    resetTransform,
    
    // Undo/Redo
    getTransformSnapshot,
    pushCommand,
    undo,
    redo,
    clearHistory,
    
    // Clipping sphere
    toggleClipSphere,
    setClipSphereEnabled,
    setClipSphereCenter,
    setClipSphereRadius,
    resetClipSphere,
    
    // Clipping box
    toggleClipBox,
    setClipBoxEnabled,
    setClipBoxCenter,
    setClipBoxSize,
    resetClipBox,
    
    // Selection
    selection,
    selectionCount,
    hasSelection,
    toggleSelectionBrush,
    setSelectionBrushEnabled,
    setSelectionBrushRadius,
    setSelectionBrushMode,
    addToSelection,
    removeFromSelection,
    clearSelection,
    selectAll,
    invertSelection,
    resetSelection
  }
})
