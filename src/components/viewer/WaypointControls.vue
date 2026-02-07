<template>
  <div class="waypoint-controls">
    <!-- Waypoint name display -->
    <div v-if="currentWaypoint" class="waypoint-name">
      {{ currentWaypoint.name }}
    </div>

    <!-- Navigation controls -->
    <div class="waypoint-navigation">
      <!-- Previous button -->
      <v-btn
        icon
        size="small"
        variant="flat"
        color="primary"
        class="nav-button"
        :disabled="isAnimating"
        @click="$emit('prev')"
      >
        <v-icon>mdi-chevron-left</v-icon>
      </v-btn>

      <!-- Waypoint dots -->
      <div class="waypoint-dots">
        <div
          v-for="(waypoint, index) in waypoints"
          :key="index"
          class="waypoint-dot"
          :class="{ active: index === currentIndex }"
          @click="$emit('go-to', index)"
          :title="waypoint.name"
        ></div>
      </div>

      <!-- Next button -->
      <v-btn
        icon
        size="small"
        variant="flat"
        color="primary"
        class="nav-button"
        :disabled="isAnimating"
        @click="$emit('next')"
      >
        <v-icon>mdi-chevron-right</v-icon>
      </v-btn>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { SqpzWaypoint } from '@/types/sqpz'

interface Props {
  waypoints: SqpzWaypoint[]
  currentIndex: number
  isAnimating: boolean
}

interface Emits {
  (e: 'go-to', index: number): void
  (e: 'next'): void
  (e: 'prev'): void
}

const props = defineProps<Props>()
defineEmits<Emits>()

const currentWaypoint = computed(() => {
  if (props.currentIndex >= 0 && props.currentIndex < props.waypoints.length) {
    return props.waypoints[props.currentIndex]
  }
  return null
})
</script>

<style scoped>
.waypoint-controls {
  position: absolute;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 100;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  pointer-events: none;
}

.waypoint-name {
  background: rgba(0, 0, 0, 0.75);
  color: white;
  padding: 8px 16px;
  border-radius: 20px;
  font-size: 14px;
  font-weight: 500;
  backdrop-filter: blur(10px);
  pointer-events: auto;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
}

.waypoint-navigation {
  display: flex;
  align-items: center;
  gap: 16px;
  background: rgba(0, 0, 0, 0.75);
  padding: 12px 20px;
  border-radius: 30px;
  backdrop-filter: blur(10px);
  pointer-events: auto;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
}

.nav-button {
  flex-shrink: 0;
}

.waypoint-dots {
  display: flex;
  gap: 8px;
  align-items: center;
}

.waypoint-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.3);
  cursor: pointer;
  transition: all 0.3s ease;
  flex-shrink: 0;
}

.waypoint-dot:hover {
  background: rgba(255, 255, 255, 0.5);
  transform: scale(1.2);
}

.waypoint-dot.active {
  background: white;
  transform: scale(1.4);
}
</style>
