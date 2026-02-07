import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { SqpzWaypoint } from '@/types/sqpz'

export interface Waypoint extends SqpzWaypoint {
  id: string  // Unique identifier for internal use
}

export const useWaypointStore = defineStore('waypoint', () => {
  const waypoints = ref<Waypoint[]>([])
  const currentWaypointIndex = ref<number>(-1)  // -1 means no waypoint active
  
  // Computed
  const waypointCount = computed(() => waypoints.value.length)
  const hasWaypoints = computed(() => waypoints.value.length > 0)
  const currentWaypoint = computed(() => {
    if (currentWaypointIndex.value >= 0 && currentWaypointIndex.value < waypoints.value.length) {
      return waypoints.value[currentWaypointIndex.value]
    }
    return null
  })
  
  // Generate unique ID
  function generateId(): string {
    return `waypoint_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  }
  
  // Add waypoint from camera state
  function addWaypoint(waypoint: Omit<Waypoint, 'id'>): Waypoint {
    const newWaypoint: Waypoint = {
      ...waypoint,
      id: generateId()
    }
    waypoints.value.push(newWaypoint)
    console.log('[WaypointStore] Added waypoint:', newWaypoint.name)
    return newWaypoint
  }
  
  // Remove waypoint by ID
  function removeWaypoint(id: string): boolean {
    const index = waypoints.value.findIndex(w => w.id === id)
    if (index >= 0) {
      waypoints.value.splice(index, 1)
      // Adjust current index if needed
      if (currentWaypointIndex.value >= waypoints.value.length) {
        currentWaypointIndex.value = waypoints.value.length - 1
      }
      console.log('[WaypointStore] Removed waypoint:', id)
      return true
    }
    return false
  }
  
  // Update waypoint
  function updateWaypoint(id: string, updates: Partial<Omit<Waypoint, 'id'>>): boolean {
    const waypoint = waypoints.value.find(w => w.id === id)
    if (waypoint) {
      Object.assign(waypoint, updates)
      console.log('[WaypointStore] Updated waypoint:', id, updates)
      return true
    }
    return false
  }
  
  // Reorder waypoints (for drag-and-drop)
  function reorderWaypoints(fromIndex: number, toIndex: number) {
    if (fromIndex < 0 || fromIndex >= waypoints.value.length ||
        toIndex < 0 || toIndex >= waypoints.value.length) {
      return
    }
    
    const item = waypoints.value.splice(fromIndex, 1)[0]
    waypoints.value.splice(toIndex, 0, item)
    
    // Adjust current index if it was affected
    if (currentWaypointIndex.value === fromIndex) {
      currentWaypointIndex.value = toIndex
    } else if (fromIndex < currentWaypointIndex.value && toIndex >= currentWaypointIndex.value) {
      currentWaypointIndex.value--
    } else if (fromIndex > currentWaypointIndex.value && toIndex <= currentWaypointIndex.value) {
      currentWaypointIndex.value++
    }
  }
  
  // Set current waypoint by index
  function setCurrentWaypoint(index: number) {
    if (index >= -1 && index < waypoints.value.length) {
      currentWaypointIndex.value = index
    }
  }
  
  // Navigate to next waypoint
  function nextWaypoint(): Waypoint | null {
    if (waypoints.value.length === 0) return null
    currentWaypointIndex.value = (currentWaypointIndex.value + 1) % waypoints.value.length
    return waypoints.value[currentWaypointIndex.value]
  }
  
  // Navigate to previous waypoint
  function prevWaypoint(): Waypoint | null {
    if (waypoints.value.length === 0) return null
    currentWaypointIndex.value = currentWaypointIndex.value <= 0 
      ? waypoints.value.length - 1 
      : currentWaypointIndex.value - 1
    return waypoints.value[currentWaypointIndex.value]
  }
  
  // Go to specific waypoint by ID
  function goToWaypointById(id: string): Waypoint | null {
    const index = waypoints.value.findIndex(w => w.id === id)
    if (index >= 0) {
      currentWaypointIndex.value = index
      return waypoints.value[index]
    }
    return null
  }
  
  // Clear all waypoints
  function clearAll() {
    waypoints.value = []
    currentWaypointIndex.value = -1
  }
  
  // Export waypoints to SQPZ format (strips internal IDs)
  function exportToSqpz(): SqpzWaypoint[] {
    return waypoints.value.map(({ id, ...rest }) => rest)
  }
  
  // Import waypoints from SQPZ format
  function importFromSqpz(sqpzWaypoints: SqpzWaypoint[]) {
    waypoints.value = sqpzWaypoints.map(wp => ({
      ...wp,
      id: generateId()
    }))
    currentWaypointIndex.value = waypoints.value.length > 0 ? 0 : -1
    console.log('[WaypointStore] Imported', waypoints.value.length, 'waypoints')
  }
  
  // Get waypoint by index
  function getWaypointByIndex(index: number): Waypoint | null {
    if (index >= 0 && index < waypoints.value.length) {
      return waypoints.value[index]
    }
    return null
  }
  
  return {
    // State
    waypoints,
    currentWaypointIndex,
    
    // Computed
    waypointCount,
    hasWaypoints,
    currentWaypoint,
    
    // Actions
    addWaypoint,
    removeWaypoint,
    updateWaypoint,
    reorderWaypoints,
    setCurrentWaypoint,
    nextWaypoint,
    prevWaypoint,
    goToWaypointById,
    getWaypointByIndex,
    clearAll,
    exportToSqpz,
    importFromSqpz
  }
})
