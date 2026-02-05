<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import AppToolbar from './components/layout/AppToolbar.vue'
import AppSidebar from './components/layout/AppSidebar.vue'
import AppCanvas from './components/layout/AppCanvas.vue'
import { useSplatEditor } from './composables/useSplatEditor'

const sidebarOpen = ref(true)
const editor = useSplatEditor()

// Keyboard shortcuts
function handleKeyDown(e: KeyboardEvent) {
  // Skip if user is typing in an input field
  const target = e.target as HTMLElement
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
    return
  }

  // Ctrl+Z: Undo
  if (e.ctrlKey && !e.shiftKey && e.key === 'z') {
    e.preventDefault()
    editor.undo()
  }
  // Ctrl+Y or Ctrl+Shift+Z: Redo
  else if ((e.ctrlKey && e.key === 'y') || (e.ctrlKey && e.shiftKey && e.key === 'z') || (e.ctrlKey && e.shiftKey && e.key === 'Z')) {
    e.preventDefault()
    editor.redo()
  }
}

onMounted(() => {
  window.addEventListener('keydown', handleKeyDown)
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeyDown)
})
</script>

<template>
  <v-app>
    <AppToolbar @toggle-sidebar="sidebarOpen = !sidebarOpen" />
    
    <v-main class="app-main">
      <div class="app-layout">
        <transition name="slide">
          <AppSidebar v-if="sidebarOpen" />
        </transition>
        
        <AppCanvas />
      </div>
    </v-main>
  </v-app>
</template>

<style scoped lang="scss">
.app-main {
  height: 100%;
  overflow: hidden;
  
  // Override Vuetify's internal v-main wrapper to prevent scrolling
  :deep(.v-main__wrap) {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
  }
}

.app-layout {
  display: flex;
  flex: 1;
  height: 100%;
  max-height: 100%;
  min-height: 0;
  overflow: hidden;
}
</style>
