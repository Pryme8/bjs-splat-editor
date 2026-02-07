<template>
  <v-card>
    <v-card-title class="d-flex align-center">
      <v-icon class="mr-2">mdi-camera-marker</v-icon>
      Waypoints
      <v-spacer></v-spacer>
      <v-btn
        icon="mdi-plus"
        size="small"
        variant="text"
        @click="createWaypointFromCamera"
        :disabled="!hasScene"
      ></v-btn>
    </v-card-title>

    <v-divider></v-divider>

    <v-card-text class="pa-0">
      <v-list v-if="waypointStore.hasWaypoints" dense>
        <v-list-item
          v-for="(waypoint, index) in waypointStore.waypoints"
          :key="waypoint.id"
          :active="waypointStore.currentWaypointIndex === index"
          @click="goToWaypoint(index)"
        >
          <template v-slot:prepend>
            <v-icon size="small">mdi-camera-marker-outline</v-icon>
          </template>

          <v-list-item-title>
            {{ waypoint.name }}
          </v-list-item-title>

          <template v-slot:append>
            <div class="d-flex align-center">
              <v-btn
                icon="mdi-pencil"
                size="x-small"
                variant="text"
                @click.stop="editWaypoint(waypoint)"
              ></v-btn>
              <v-btn
                icon="mdi-delete"
                size="x-small"
                variant="text"
                @click.stop="deleteWaypoint(waypoint.id)"
              ></v-btn>
            </div>
          </template>
        </v-list-item>
      </v-list>

      <div v-else class="pa-4 text-center text-grey">
        <v-icon size="large" class="mb-2">mdi-camera-marker-outline</v-icon>
        <div class="text-caption">No waypoints yet</div>
        <v-btn
          size="small"
          variant="outlined"
          class="mt-2"
          @click="createWaypointFromCamera"
          :disabled="!hasScene"
        >
          Create First Waypoint
        </v-btn>
      </div>
    </v-card-text>

    <!-- Edit Waypoint Dialog -->
    <v-dialog v-model="editDialog" max-width="400">
      <v-card v-if="editingWaypoint">
        <v-card-title>Edit Waypoint</v-card-title>
        <v-card-text>
          <v-text-field
            v-model="editingWaypoint.name"
            label="Name"
            variant="outlined"
            density="compact"
          ></v-text-field>
        </v-card-text>
        <v-card-actions>
          <v-spacer></v-spacer>
          <v-btn variant="text" @click="cancelEdit">Cancel</v-btn>
          <v-btn variant="text" color="primary" @click="saveEdit">Save</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Create Waypoint Dialog -->
    <v-dialog v-model="createDialog" max-width="400">
      <v-card>
        <v-card-title>Create Waypoint</v-card-title>
        <v-card-text>
          <v-text-field
            v-model="newWaypointName"
            label="Name"
            variant="outlined"
            density="compact"
            autofocus
            @keyup.enter="confirmCreate"
          ></v-text-field>
        </v-card-text>
        <v-card-actions>
          <v-spacer></v-spacer>
          <v-btn variant="text" @click="cancelCreate">Cancel</v-btn>
          <v-btn variant="text" color="primary" @click="confirmCreate">Create</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-card>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useWaypointStore, type Waypoint } from '@/stores/waypointStore'
import { useAppStore } from '@/stores/appStore'
import { useBabylon } from '@/composables/useBabylon'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'

const waypointStore = useWaypointStore()
const appStore = useAppStore()
const babylon = useBabylon()

const hasScene = computed(() => appStore.hasScene)

// Edit state
const editDialog = ref(false)
const editingWaypoint = ref<Waypoint | null>(null)
const originalWaypoint = ref<Waypoint | null>(null)

// Create state
const createDialog = ref(false)
const newWaypointName = ref('')
const pendingCameraState = ref<any>(null)

function createWaypointFromCamera() {
  const cameraState = babylon.getCurrentCameraState()
  if (!cameraState) {
    console.warn('[WaypointPanel] No camera state available')
    return
  }

  // Generate default name
  newWaypointName.value = `Waypoint ${waypointStore.waypointCount + 1}`
  pendingCameraState.value = cameraState
  createDialog.value = true
}

function confirmCreate() {
  if (!pendingCameraState.value || !newWaypointName.value.trim()) {
    return
  }

  const waypoint = waypointStore.addWaypoint({
    name: newWaypointName.value.trim(),
    alpha: pendingCameraState.value.alpha,
    beta: pendingCameraState.value.beta,
    radius: pendingCameraState.value.radius,
    target: {
      x: pendingCameraState.value.target.x,
      y: pendingCameraState.value.target.y,
      z: pendingCameraState.value.target.z
    }
  })

  // Create 3D marker in scene
  const target = new Vector3(
    pendingCameraState.value.target.x,
    pendingCameraState.value.target.y,
    pendingCameraState.value.target.z
  )
  babylon.createWaypointMarker(
    waypoint.id, 
    pendingCameraState.value.alpha, 
    pendingCameraState.value.beta, 
    pendingCameraState.value.radius, 
    target, 
    waypoint.name
  )

  cancelCreate()
}

function cancelCreate() {
  createDialog.value = false
  newWaypointName.value = ''
  pendingCameraState.value = null
}

function goToWaypoint(index: number) {
  const waypoint = waypointStore.getWaypointByIndex(index)
  if (!waypoint) return

  waypointStore.setCurrentWaypoint(index)
  
  const target = new Vector3(waypoint.target.x, waypoint.target.y, waypoint.target.z)
  babylon.animateCameraToWaypoint(waypoint.alpha, waypoint.beta, waypoint.radius, target, 800)
}

function editWaypoint(waypoint: Waypoint) {
  editingWaypoint.value = { ...waypoint }
  originalWaypoint.value = waypoint
  editDialog.value = true
}

function saveEdit() {
  if (!editingWaypoint.value || !originalWaypoint.value) return

  waypointStore.updateWaypoint(originalWaypoint.value.id, {
    name: editingWaypoint.value.name
  })

  cancelEdit()
}

function cancelEdit() {
  editDialog.value = false
  editingWaypoint.value = null
  originalWaypoint.value = null
}

function deleteWaypoint(id: string) {
  // Remove 3D marker
  babylon.removeWaypointMarker(id)
  
  // Remove from store
  waypointStore.removeWaypoint(id)
}
</script>

<style scoped>
.v-list-item {
  cursor: pointer;
}
</style>
