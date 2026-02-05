/**
 * Splat Editor Composable - Bridge between UI and Babylon scene for editing operations
 */

import { computed, ref } from 'vue'
import { useEditorStore, type GizmoType, type TransformSpace } from '@/stores/editorStore'
import { useAppStore } from '@/stores/appStore'
import { useBabylon } from '@/composables/useBabylon'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'

export function useSplatEditor() {
  const editorStore = useEditorStore()
  const appStore = useAppStore()
  const babylon = useBabylon()

  // Clipping state
  const isClipping = ref(false)
  const lastClipResult = ref<{ originalCount: number; clippedCount: number } | null>(null)

  // Computed state
  const hasScene = computed(() => appStore.hasScene)
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
    editorStore.updateTransform({ position: { x, y, z } })
    babylon.applySplatTransform({ x, y, z }, undefined, undefined)
    if (before) {
      const after = editorStore.getTransformSnapshot()
      editorStore.pushCommand({ type: 'transform', before, after })
    }
  }

  function setRotation(x: number, y: number, z: number, recordHistory = false) {
    const before = recordHistory ? editorStore.getTransformSnapshot() : null
    editorStore.updateTransform({ rotation: { x, y, z } })
    babylon.applySplatTransform(undefined, { x, y, z }, undefined)
    if (before) {
      const after = editorStore.getTransformSnapshot()
      editorStore.pushCommand({ type: 'transform', before, after })
    }
  }

  function setScale(x: number, y: number, z: number, recordHistory = false) {
    const before = recordHistory ? editorStore.getTransformSnapshot() : null
    editorStore.updateTransform({ scale: { x, y, z } })
    babylon.applySplatTransform(undefined, undefined, { x, y, z })
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

  // Bake transform functions
  /**
   * Bake the current mesh transform into the vertex data.
   * After baking, the mesh will be at identity but visually appear the same.
   */
  function bakeTransform(): void {
    const splat = babylon.getCurrentSplat()
    if (splat) {
      splat.bakeCurrentTransformIntoVertices()
    }
  }

  /**
   * Center the splat at the world origin.
   * This computes the bounding box center and shifts all vertices.
   */
  function centerSplatAtOrigin(): void {
    const splat = babylon.getCurrentSplat()
    if (splat) {
     splat.position = Vector3.Zero()
     splat.rotation = Vector3.Zero()
     splat.scaling = new Vector3(1, 1, 1)
     editorStore.resetTransform()
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

    // Bake transform
    bakeTransform,
    centerSplatAtOrigin,

    // Undo/Redo
    undo,
    redo
  }
}
