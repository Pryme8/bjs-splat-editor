<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import AppToolbar from './components/layout/AppToolbar.vue'
import AppSidebar from './components/layout/AppSidebar.vue'
import AppRightPanel from './components/layout/AppRightPanel.vue'
import AppCanvas from './components/layout/AppCanvas.vue'
import ConsolePanel from './components/panels/ConsolePanel.vue'
import { useSplatEditor } from './composables/useSplatEditor'
import { useAppStore } from './stores/appStore'

const sidebarOpen = ref(true)
const editor = useSplatEditor()
const appStore = useAppStore()

// Console panel height when open
const consolePanelHeight = ref(180)

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
  // Ctrl+` or F12: Toggle console panel
  else if ((e.ctrlKey && e.key === '`') || e.key === 'F12') {
    e.preventDefault()
    appStore.toggleConsolePanel()
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
    <AppToolbar 
      @toggle-sidebar="sidebarOpen = !sidebarOpen" 
      @toggle-right-panel="appStore.toggleRightPanel"
      @toggle-console="appStore.toggleConsolePanel"
    />
    
    <v-main class="app-main">
      <div class="app-content">
        <div class="app-layout">
          <transition name="slide-left">
            <AppSidebar v-if="sidebarOpen" />
          </transition>
          
          <AppCanvas />
          
          <transition name="slide-right">
            <AppRightPanel v-if="appStore.showRightPanel" />
          </transition>
        </div>
        
        <transition name="slide-up">
          <div 
            v-if="appStore.showConsolePanel" 
            class="console-wrapper"
            :style="{ height: consolePanelHeight + 'px' }"
          >
            <ConsolePanel />
          </div>
        </transition>
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

.app-content {
  display: flex;
  flex-direction: column;
  flex: 1;
  height: 100%;
  max-height: 100%;
  min-height: 0;
  overflow: hidden;
}

.app-layout {
  display: flex;
  flex: 1;
  height: 100%;
  max-height: 100%;
  min-height: 0;
  overflow: hidden;
}

.console-wrapper {
  flex-shrink: 0;
  min-height: 100px;
  max-height: 50vh;
  overflow: hidden;
}

// Slide transitions for panels
.slide-left-enter-active,
.slide-left-leave-active {
  transition: transform 0.2s ease, opacity 0.2s ease;
}

.slide-left-enter-from,
.slide-left-leave-to {
  transform: translateX(-100%);
  opacity: 0;
}

.slide-right-enter-active,
.slide-right-leave-active {
  transition: transform 0.2s ease, opacity 0.2s ease;
}

.slide-right-enter-from,
.slide-right-leave-to {
  transform: translateX(100%);
  opacity: 0;
}

.slide-up-enter-active,
.slide-up-leave-active {
  transition: transform 0.2s ease, opacity 0.2s ease, height 0.2s ease;
}

.slide-up-enter-from,
.slide-up-leave-to {
  transform: translateY(100%);
  opacity: 0;
}
</style>
