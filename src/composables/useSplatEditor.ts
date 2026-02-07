/**
 * Splat Editor Composable - Bridge between UI and Babylon scene for editing operations
 */

import { computed, ref } from 'vue'
import { useEditorStore, type GizmoType, type TransformSpace, type BrushMode } from '@/stores/editorStore'
import { useAppStore } from '@/stores/appStore'
import { useBabylon } from '@/composables/useBabylon'
import { BackendApi } from '@/services/BackendApi'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'

export function useSplatEditor() {
  const editorStore = useEditorStore()
  const appStore = useAppStore()
  const babylon = useBabylon()

  // Clipping state
  const isClipping = ref(false)
  const lastClipResult = ref<{ originalCount: number; clippedCount: number } | null>(null)

  // Selection state
  const isDeleting = ref(false)
  const lastDeleteResult = ref<{ originalCount: number; remainingCount: number } | null>(null)

  // Semantic selection state
  const isSemanticSelecting = ref(false)
  const semanticSelectProgress = ref('')
  const lastSemanticSelectResult = ref<{ 
    prompt: string
    selectedCount: number 
    imagesProcessed: number
    imagesWithDetections: number
    // Debug: store masks with original images for review
    debugMasks?: Array<{
      originalImage: string  // data URL of captured view
      maskImage: string      // data URL of mask (if detection)
      hasDetection: boolean
    }>
  } | null>(null)
  
  // Pending semantic capture (preview state)
  const pendingSemanticCapture = ref<{
    prompt: string
    views: Array<{
      filename: string
      dataUrl: string
      transformMatrix: number[]
    }>
    options: {
      voteThreshold: number
      boxThreshold: number
      textThreshold: number
      addToSelection: boolean
    }
  } | null>(null)

  // Computed state
  const hasScene = computed(() => appStore.hasScene)
  const selection = computed(() => editorStore.selection)
  const selectionCount = computed(() => editorStore.selectionCount)
  const hasSelection = computed(() => editorStore.hasSelection)
  const showAxes = computed(() => editorStore.showAxes)
  const showGroundPlane = computed(() => editorStore.showGroundPlane)
  const groundPlaneSize = computed(() => editorStore.groundPlaneSize)
  const activeGizmo = computed(() => editorStore.activeGizmo)
  const transformSpace = computed(() => editorStore.transformSpace)
  const splatTransform = computed(() => editorStore.splatTransform)
  const clipSphere = computed(() => editorStore.clipSphere)
  const clipBox = computed(() => editorStore.clipBox)
  const cameraMode = computed(() => editorStore.cameraMode)
  const canUndo = computed(() => editorStore.canUndo)
  const canRedo = computed(() => editorStore.canRedo)

  // View helper toggles
  function toggleAxes() {
    editorStore.toggleAxes()
  }

  function toggleGroundPlane() {
    editorStore.toggleGroundPlane()
  }

  function setGroundPlaneSize(size: number) {
    editorStore.setGroundPlaneSize(size)
  }

  // Gizmo controls
  function setGizmo(gizmo: GizmoType) {
    editorStore.setActiveGizmo(gizmo)
  }

  function toggleRotateGizmo() {
    editorStore.setActiveGizmo(editorStore.activeGizmo === 'rotate' ? 'none' : 'rotate')
  }

  function toggleTranslateGizmo() {
    editorStore.setActiveGizmo(editorStore.activeGizmo === 'translate' ? 'none' : 'translate')
  }

  function toggleScaleGizmo() {
    editorStore.setActiveGizmo(editorStore.activeGizmo === 'scale' ? 'none' : 'scale')
  }

  function clearGizmo() {
    editorStore.setActiveGizmo('none')
  }

  // Transform space
  function setTransformSpace(space: TransformSpace) {
    editorStore.setTransformSpace(space)
  }

  function toggleTransformSpace() {
    editorStore.toggleTransformSpace()
  }

  // Transform operations (with optional history tracking)
  function setPosition(x: number, y: number, z: number, recordHistory = false) {
    const before = recordHistory ? editorStore.getTransformSnapshot() : null
    // Update the mesh (source of truth)
    babylon.applySplatTransform({ x, y, z }, undefined, undefined)
    // Sync mesh back to store for undo/redo
    babylon.syncTransformToStore()
    if (before) {
      const after = editorStore.getTransformSnapshot()
      editorStore.pushCommand({ type: 'transform', before, after })
    }
  }

  function setRotation(x: number, y: number, z: number, recordHistory = false) {
    const before = recordHistory ? editorStore.getTransformSnapshot() : null
    // Update the mesh (source of truth)
    babylon.applySplatTransform(undefined, { x, y, z }, undefined)
    // Sync mesh back to store for undo/redo
    babylon.syncTransformToStore()
    if (before) {
      const after = editorStore.getTransformSnapshot()
      editorStore.pushCommand({ type: 'transform', before, after })
    }
  }

  function setScale(x: number, y: number, z: number, recordHistory = false) {
    const before = recordHistory ? editorStore.getTransformSnapshot() : null
    // Update the mesh (source of truth)
    babylon.applySplatTransform(undefined, undefined, { x, y, z })
    // Sync mesh back to store for undo/redo
    babylon.syncTransformToStore()
    if (before) {
      const after = editorStore.getTransformSnapshot()
      editorStore.pushCommand({ type: 'transform', before, after })
    }
  }

  function updatePosition(axis: 'x' | 'y' | 'z', value: number, recordHistory = false) {
    const pos = { ...editorStore.splatTransform.position }
    pos[axis] = value
    setPosition(pos.x, pos.y, pos.z, recordHistory)
  }

  function updateRotation(axis: 'x' | 'y' | 'z', value: number, recordHistory = false) {
    const rot = { ...editorStore.splatTransform.rotation }
    rot[axis] = value
    setRotation(rot.x, rot.y, rot.z, recordHistory)
  }

  function updateScale(axis: 'x' | 'y' | 'z', value: number, recordHistory = false) {
    const scl = { ...editorStore.splatTransform.scale }
    scl[axis] = value
    setScale(scl.x, scl.y, scl.z, recordHistory)
  }

  // Quick rotation controls (90 degree increments) - always record history
  function rotateX90() {
    const before = editorStore.getTransformSnapshot()
    babylon.rotateSplat90('x')
    const after = editorStore.getTransformSnapshot()
    editorStore.pushCommand({ type: 'transform', before, after })
  }

  function rotateY90() {
    const before = editorStore.getTransformSnapshot()
    babylon.rotateSplat90('y')
    const after = editorStore.getTransformSnapshot()
    editorStore.pushCommand({ type: 'transform', before, after })
  }

  function rotateZ90() {
    const before = editorStore.getTransformSnapshot()
    babylon.rotateSplat90('z')
    const after = editorStore.getTransformSnapshot()
    editorStore.pushCommand({ type: 'transform', before, after })
  }

  // Reset transform - record history
  function resetTransform() {
    const before = editorStore.getTransformSnapshot()
    babylon.resetSplatTransform()
    const after = editorStore.getTransformSnapshot()
    // Only record if there was actually a change
    if (before.position.x !== 0 || before.position.y !== 0 || before.position.z !== 0 ||
        before.rotation.x !== 0 || before.rotation.y !== 0 || before.rotation.z !== 0 ||
        before.scale.x !== 1 || before.scale.y !== 1 || before.scale.z !== 1) {
      editorStore.pushCommand({ type: 'transform', before, after })
    }
  }

  // Focus camera on splat
  function focusOnSplat() {
    babylon.focusCamera()
  }

  // Camera mode controls
  function setCameraMode(mode: 'fly' | 'orbit') {
    editorStore.setCameraMode(mode)
  }

  function toggleCameraMode() {
    const newMode = editorStore.cameraMode === 'orbit' ? 'fly' : 'orbit'
    editorStore.setCameraMode(newMode)
  }

  // Clipping sphere controls
  function toggleClipSphere() {
    editorStore.toggleClipSphere()
  }

  function setClipSphereEnabled(enabled: boolean) {
    editorStore.setClipSphereEnabled(enabled)
  }

  function setClipSphereRadius(radius: number) {
    editorStore.setClipSphereRadius(radius)
  }

  function setClipSphereCenter(x: number, y: number, z: number) {
    editorStore.setClipSphereCenter(x, y, z)
  }

  async function applyCrop() {
    if (isClipping.value) return
    
    isClipping.value = true
    try {
      const result = await babylon.applyClipSphere()
      if (result) {
        lastClipResult.value = result
        console.log('[Editor] Crop applied:', result.clippedCount, 'of', result.originalCount, 'kept')
      }
    } finally {
      isClipping.value = false
    }
    return lastClipResult.value
  }

  function resetClipSphere() {
    editorStore.resetClipSphere()
    lastClipResult.value = null
  }

  // Clipping box controls
  function toggleClipBox() {
    editorStore.toggleClipBox()
  }

  function setClipBoxEnabled(enabled: boolean) {
    editorStore.setClipBoxEnabled(enabled)
  }

  function setClipBoxSize(x: number, y: number, z: number) {
    editorStore.setClipBoxSize(x, y, z)
  }

  function setClipBoxCenter(x: number, y: number, z: number) {
    editorStore.setClipBoxCenter(x, y, z)
  }

  async function applyBoxCrop() {
    if (isClipping.value) return
    
    isClipping.value = true
    try {
      const result = await babylon.applyClipBox()
      if (result) {
        lastClipResult.value = result
        console.log('[Editor] Box crop applied:', result.clippedCount, 'of', result.originalCount, 'kept')
      }
    } finally {
      isClipping.value = false
    }
    return lastClipResult.value
  }

  function resetClipBox() {
    editorStore.resetClipBox()
    lastClipResult.value = null
  }

  // Restore to original
  async function restoreToOriginal() {
    const result = await babylon.restoreToOriginal()
    if (result) {
      // Clear any crop result since we've restored
      lastClipResult.value = null
      console.log('[Editor] Restored to original file')
    }
    return result
  }

  // Bake transform functions
  /**
   * Bake the current mesh transform into the vertex data.
   * After baking, the mesh will be at identity but visually appear the same.
   * This also syncs the actual mesh state to the UI.
   */
  async function bakeTransform(): Promise<void> {
    await babylon.bakeTransformToVertices()
    // Force sync to ensure UI reflects actual mesh state after bake
    babylon.syncTransformToStore()
  }

  /**
   * Center the splat at the world origin.
   * This computes the bounding box center and shifts all vertices.
   */
  async function centerSplatAtOrigin(): Promise<void> {
    await babylon.centerAtOrigin()
    // Sync the mesh state to store
    babylon.syncTransformToStore()
  }

  // Selection controls
  function toggleSelectionBrush() {
    editorStore.toggleSelectionBrush()
  }

  function setSelectionBrushEnabled(enabled: boolean) {
    editorStore.setSelectionBrushEnabled(enabled)
  }

  function setSelectionBrushRadius(radius: number) {
    editorStore.setSelectionBrushRadius(radius)
  }

  function setSelectionBrushMode(mode: BrushMode) {
    editorStore.setSelectionBrushMode(mode)
  }

  function clearSelection() {
    editorStore.clearSelection()
    babylon.clearSelectionPointCloud()
  }

  function selectAll() {
    const positions = babylon.getSplatPositions()
    if (positions) {
      editorStore.selectAll(positions.count)
    }
  }

  function invertSelection() {
    const positions = babylon.getSplatPositions()
    if (positions) {
      editorStore.invertSelection(positions.count)
    }
  }

  // Note: Painting is now handled automatically by Babylon's pointer observable
  // when the selection brush is enabled. The isPainting state is managed internally.

  /**
   * Delete selected splats
   */
  async function deleteSelected(): Promise<boolean> {
    if (isDeleting.value || !editorStore.hasSelection) return false
    
    isDeleting.value = true
    try {
      const result = await babylon.deleteSelectedSplats()
      if (result) {
        lastDeleteResult.value = result
        console.log('[Editor] Deleted splats:', result.originalCount - result.remainingCount, 
          '- remaining:', result.remainingCount)
        return true
      }
    } finally {
      isDeleting.value = false
    }
    return false
  }

  // ============================================
  // Semantic Selection (Text-Based)
  // ============================================

  /**
   * Select splats by text prompt using AI-powered semantic segmentation
   * 
   * Flow:
   * 1. Capture multi-view images from Babylon scene
   * 2. Send to backend for segmentation with prompt
   * 3. Project masks back to 3D splat indices
   * 4. Update selection store
   * 
   * @param prompt Text describing what to select (e.g., "bike", "red car")
   * @param options Configuration options
   * @returns True if capture succeeded, false otherwise
   */
  async function captureForSemanticSelect(
    prompt: string,
    options?: {
      voteThreshold?: number      // Min views a splat must appear in (default: 3)
      resolution?: number         // Capture resolution (default: 512)
      boxThreshold?: number       // Detection confidence (default: 0.25)
      textThreshold?: number      // Text matching threshold (default: 0.25)
      addToSelection?: boolean    // Add to existing selection vs replace (default: false)
    }
  ): Promise<boolean> {
    if (isSemanticSelecting.value || pendingSemanticCapture.value) {
      console.warn('[Editor] Semantic selection already in progress')
      return false
    }

    if (!prompt.trim()) {
      console.warn('[Editor] Empty prompt provided')
      return false
    }

    const {
      voteThreshold = 3,
      resolution = 512,
      boxThreshold = 0.25,
      textThreshold = 0.25,
      addToSelection = false
    } = options || {}

    semanticSelectProgress.value = 'Capturing views...'

    try {
      console.log(`[Editor] Capturing views for semantic selection: "${prompt}"`)
      const capturedViews = await babylon.captureMultiViewImages(resolution)
      
      if (capturedViews.length === 0) {
        throw new Error('No views captured')
      }

      // Store for preview
      pendingSemanticCapture.value = {
        prompt,
        views: capturedViews,
        options: {
          voteThreshold,
          boxThreshold,
          textThreshold,
          addToSelection
        }
      }

      semanticSelectProgress.value = ''
      console.log(`[Editor] Captured ${capturedViews.length} views, awaiting confirmation`)
      return true

    } catch (error) {
      console.error('[Editor] View capture failed:', error)
      semanticSelectProgress.value = ''
      return false
    }
  }

  /**
   * Cancel pending semantic selection and clear captured views
   */
  function cancelSemanticSelect(): void {
    pendingSemanticCapture.value = null
    semanticSelectProgress.value = ''
    console.log('[Editor] Semantic selection cancelled')
  }

  /**
   * Confirm and process the pending semantic selection
   * @returns Number of splats selected, or null on error
   */
  async function confirmSemanticSelect(): Promise<number | null> {
    if (!pendingSemanticCapture.value) {
      console.warn('[Editor] No pending semantic capture to confirm')
      return null
    }

    if (isSemanticSelecting.value) {
      console.warn('[Editor] Semantic selection already processing')
      return null
    }

    const { prompt, views, options } = pendingSemanticCapture.value
    const { voteThreshold, boxThreshold, textThreshold, addToSelection } = options

    isSemanticSelecting.value = true
    semanticSelectProgress.value = `Analyzing ${views.length} views...`
    lastSemanticSelectResult.value = null

    try {
      // Send to backend for segmentation
      const images = views.map(view => ({
        filename: view.filename,
        data: view.dataUrl
      }))

      const result = await BackendApi.RunSemanticSelect(images, prompt, {
        boxThreshold,
        textThreshold
      })

      if (!result || !result.success) {
        throw new Error('Backend segmentation failed')
      }

      semanticSelectProgress.value = 'Projecting masks to 3D...'

      // Prepare masks with camera transform matrix for projection
      const masksWithMatrices = result.masks
        .filter(m => m.has_detection && m.mask_base64)
        .map((mask, index) => ({
          mask_base64: mask.mask_base64!,
          width: mask.width,
          height: mask.height,
          transformMatrix: views[index].transformMatrix
        }))

      if (masksWithMatrices.length === 0) {
        console.log('[Editor] No detections found for prompt:', prompt)
        lastSemanticSelectResult.value = {
          prompt,
          selectedCount: 0,
          imagesProcessed: result.images_processed,
          imagesWithDetections: 0
        }
        pendingSemanticCapture.value = null
        return 0
      }

      // Project masks to splat indices
      const selectedIndices = await babylon.projectMasksToSplatIndices(
        masksWithMatrices,
        voteThreshold
      )

      // Update selection
      if (!addToSelection) {
        editorStore.clearSelection()
      }

      editorStore.addToSelection(Array.from(selectedIndices))
      babylon.updateSelectionPointCloud()

      // Build debug masks array pairing original images with their masks
      const debugMasks = views.map((view, index) => {
        const maskResult = result.masks[index]
        return {
          originalImage: view.dataUrl,
          maskImage: maskResult?.mask_base64 
            ? `data:image/png;base64,${maskResult.mask_base64}` 
            : '',
          hasDetection: maskResult?.has_detection ?? false
        }
      })

      lastSemanticSelectResult.value = {
        prompt,
        selectedCount: selectedIndices.size,
        imagesProcessed: result.images_processed,
        imagesWithDetections: result.images_with_detections,
        debugMasks
      }

      console.log(`[Editor] Semantic selection complete: ${selectedIndices.size} splats selected for "${prompt}"`)
      pendingSemanticCapture.value = null
      return selectedIndices.size

    } catch (error) {
      console.error('[Editor] Semantic selection failed:', error)
      semanticSelectProgress.value = error instanceof Error ? error.message : 'Selection failed'
      return null
    } finally {
      isSemanticSelecting.value = false
      semanticSelectProgress.value = ''
    }
  }

  /**
   * Select splats using text prompt - direct version without preview
   */
  async function selectByText(
    prompt: string,
    options?: {
      voteThreshold?: number
      resolution?: number
      boxThreshold?: number
      textThreshold?: number
      addToSelection?: boolean
    }
  ): Promise<number | null> {
    const captured = await captureForSemanticSelect(prompt, options)
    if (!captured) return null
    return confirmSemanticSelect()
  }

  /**
   * Check if semantic selection is available (backend has required dependencies)
   */
  async function checkSemanticSelectAvailable(): Promise<boolean> {
    try {
      const status = await BackendApi.CheckSemanticSelectStatus()
      return status?.available ?? false
    } catch {
      return false
    }
  }

  // Undo/Redo operations
  function undo(): boolean {
    const transform = editorStore.undo()
    if (transform) {
      babylon.applyTransformFromHistory(transform)
      return true
    }
    return false
  }

  function redo(): boolean {
    const transform = editorStore.redo()
    if (transform) {
      babylon.applyTransformFromHistory(transform)
      return true
    }
    return false
  }

  return {
    // State
    hasScene,
    showAxes,
    showGroundPlane,
    groundPlaneSize,
    activeGizmo,
    transformSpace,
    splatTransform,
    clipSphere,
    clipBox,
    cameraMode,
    isClipping,
    lastClipResult,
    canUndo,
    canRedo,

    // View helpers
    toggleAxes,
    toggleGroundPlane,
    setGroundPlaneSize,
    
    // Inspector
    toggleInspector: babylon.toggleInspector,

    // Gizmo controls
    setGizmo,
    toggleRotateGizmo,
    toggleTranslateGizmo,
    toggleScaleGizmo,
    clearGizmo,

    // Transform space
    setTransformSpace,
    toggleTransformSpace,

    // Transform operations
    setPosition,
    setRotation,
    setScale,
    updatePosition,
    updateRotation,
    updateScale,

    // Quick controls
    rotateX90,
    rotateY90,
    rotateZ90,
    resetTransform,
    focusOnSplat,

    // Camera mode
    setCameraMode,
    toggleCameraMode,

    // Clipping sphere
    toggleClipSphere,
    setClipSphereEnabled,
    setClipSphereRadius,
    setClipSphereCenter,
    applyCrop,
    resetClipSphere,

    // Clipping box
    toggleClipBox,
    setClipBoxEnabled,
    setClipBoxSize,
    setClipBoxCenter,
    applyBoxCrop,
    resetClipBox,
    restoreToOriginal,

    // Bake transform
    bakeTransform,
    centerSplatAtOrigin,

    // Selection (painting is handled automatically by Babylon's pointer observable)
    selection,
    selectionCount,
    hasSelection,
    isDeleting,
    lastDeleteResult,
    toggleSelectionBrush,
    setSelectionBrushEnabled,
    setSelectionBrushRadius,
    setSelectionBrushMode,
    clearSelection,
    selectAll,
    invertSelection,
    deleteSelected,

    // Semantic selection (text-based)
    isSemanticSelecting,
    semanticSelectProgress,
    lastSemanticSelectResult,
    pendingSemanticCapture,
    captureForSemanticSelect,
    confirmSemanticSelect,
    cancelSemanticSelect,
    selectByText,
    checkSemanticSelectAvailable,

    // Undo/Redo
    undo,
    redo
  }
}
