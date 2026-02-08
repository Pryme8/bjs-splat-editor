<script setup lang="ts">
import { useNotificationStore } from '@/stores/notificationStore'

const store = useNotificationStore()
</script>

<template>
  <div class="notification-stack">
    <TransitionGroup name="notif">
      <div
        v-for="notif in store.notifications"
        :key="notif.id"
        class="notification-item"
        :class="{ dismissable: notif.duration === 0 }"
        @click="notif.duration === 0 && store.Dismiss(notif.id)"
      >
        <span class="notification-text">{{ notif.message }}</span>
        <button
          v-if="notif.duration === 0"
          class="notification-close"
          @click.stop="store.Dismiss(notif.id)"
        >
          &times;
        </button>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped lang="scss">
.notification-stack {
  position: fixed;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 9999;
  display: flex;
  flex-direction: column-reverse;
  align-items: center;
  gap: 8px;
  pointer-events: none;
}

.notification-item {
  pointer-events: auto;
  background: #1E1E2E;
  border: 1px solid #3A3A4A;
  border-radius: 8px;
  padding: 10px 16px;
  color: #E0E0E0;
  font-size: 0.8rem;
  line-height: 1.4;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
  max-width: 420px;
  min-width: 200px;
  display: flex;
  align-items: center;
  gap: 10px;
  backdrop-filter: blur(12px);
  white-space: nowrap;

  &.dismissable {
    cursor: pointer;
    border-color: #5A5A6A;

    &:hover {
      background: #2A2A3E;
      border-color: #6A6A7A;
    }
  }
}

.notification-text {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
}

.notification-close {
  flex-shrink: 0;
  background: none;
  border: none;
  color: #888;
  font-size: 1.1rem;
  cursor: pointer;
  padding: 0 2px;
  line-height: 1;

  &:hover {
    color: #ccc;
  }
}

// Animations - enter from center, slide down to position
.notif-enter-active {
  transition: all 0.35s cubic-bezier(0.16, 1, 0.3, 1);
}

.notif-leave-active {
  transition: all 0.25s cubic-bezier(0.4, 0, 1, 1);
}

.notif-move {
  transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1);
}

.notif-enter-from {
  opacity: 0;
  transform: translateY(-40px) scale(0.9);
}

.notif-leave-to {
  opacity: 0;
  transform: translateY(20px) scale(0.95);
}
</style>
