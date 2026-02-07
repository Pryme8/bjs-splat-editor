<script setup lang="ts">
import { ref } from 'vue'
import { useAppStore } from '@/stores/appStore'
import { useSplatEditor } from '@/composables/useSplatEditor'
import { useBabylon } from '@/composables/useBabylon'
import { useSqpzExport } from '@/composables/useSqpzExport'
import { useSqpzImport } from '@/composables/useSqpzImport'

const emit = defineEmits<{
  toggleSidebar: []
  toggleRightPanel: []
  toggleConsole: []
}>()

const appStore = useAppStore()
const editor = useSplatEditor()
const babylon = useBabylon()
const sqpzExport = useSqpzExport()
const sqpzImport = useSqpzImport()
const showExportMenu = ref(false)
const showSqpzExportMenu = ref(false)

function handleFileImport() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.ply,.splat,.spz'
  input.onchange = async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0]
    if (file) {
      appStore.loadFile(file)
    }
  }
  input.click()
}

function handleSqpzImport() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.sqpz'
  input.onchange = async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0]
    if (file) {
      const success = await sqpzImport.importWorkspace(file)
      if (success) {
        console.log('[Toolbar] SQPZ imported successfully')
      } else {
        console.error('[Toolbar] SQPZ import failed')
      }
    }
  }
  input.click()
}

function handleExport(format: 'ply' | 'splat') {
  // Get the WORKING file (with all modifications) not the original
  const workingFile = babylon.getOriginalFile()
  if (!workingFile) {
    console.error('[Export] No working file available')
    return
  }
  
  const timestamp = new Date().toISOString().slice(0, 19).replace(/[:-]/g, '')
  const filename = `export-${timestamp}.${format}`
  
  // Create a temporary blob URL from the working file
  const url = URL.createObjectURL(workingFile.blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  
  // Clean up the temporary URL
  URL.revokeObjectURL(url)
  
  showExportMenu.value = false
}

async function handleSqpzExport(developmentMode: boolean) {
  const projectName = appStore.currentFile?.name.replace(/\.[^/.]+$/, '') || 'project'
  const success = await sqpzExport.exportAndDownload({
    developmentMode,
    projectName
  })
  
  if (success) {
    console.log('[Toolbar] SQPZ exported successfully')
  } else {
    console.error('[Toolbar] SQPZ export failed')
  }
  
  showSqpzExportMenu.value = false
}

async function toggleViewerMode() {
  if (!appStore.viewerMode) {
    // Entering viewer mode - export current state to SQPZ
    console.log('[Toolbar] Exporting workspace for viewer mode')
    const result = await sqpzExport.exportWorkspace({
      developmentMode: false,
      projectName: appStore.currentFile?.name.replace(/\.[^/.]+$/, '') || 'preview'
    })
    
    if (result) {
      console.log('[Toolbar] Export successful:', {
        splats: result.file.splats.length,
        waypoints: result.file.waypoints.length,
        buffers: result.buffers.length
      })
      appStore.setCurrentSqpzData(result.file, result.buffers)
      appStore.setViewerMode(true)
    } else {
      console.error('[Toolbar] Export failed, cannot enter viewer mode')
    }
  } else {
    // Exiting viewer mode
    console.log('[Toolbar] Exiting viewer mode')
    appStore.setViewerMode(false)
    appStore.setCurrentSqpzData(null, [])
  }
}
</script>

<template>
  <v-app-bar 
    density="compact" 
    elevation="0"
    class="toolbar"
  >
    <v-btn
      icon="mdi-menu"
      variant="text"
      size="small"
      @click="emit('toggleSidebar')"
    />
    
    <v-toolbar-title class="toolbar-title">
      <span class="title-text">Quantum</span>
      <span class="title-accent">Splat</span>
    </v-toolbar-title>
    
    <v-spacer />
    
    <v-btn-group density="compact" variant="text">
      <v-btn 
        prepend-icon="mdi-folder-open-outline"
        @click="handleFileImport"
      >
        Import
      </v-btn>
      
      <v-btn 
        prepend-icon="mdi-folder-open"
        @click="handleSqpzImport"
      >
        Import SQPZ
      </v-btn>
      
      <v-menu v-model="showExportMenu" :close-on-content-click="false">
        <template #activator="{ props }">
          <v-btn 
            prepend-icon="mdi-content-save-outline"
            :disabled="!appStore.hasScene"
            v-bind="props"
          >
            Export
          </v-btn>
        </template>
        <v-list density="compact">
          <v-list-item 
            prepend-icon="mdi-cube-scan" 
            title="Export as PLY"
            @click="handleExport('ply')"
          />
          <v-list-item 
            prepend-icon="mdi-cube-outline" 
            title="Export as SPLAT"
            @click="handleExport('splat')"
          />
        </v-list>
      </v-menu>
      
      <v-menu v-model="showSqpzExportMenu" :close-on-content-click="false">
        <template #activator="{ props }">
          <v-btn 
            prepend-icon="mdi-package-variant"
            :disabled="!appStore.hasScene"
            v-bind="props"
          >
            Export SQPZ
          </v-btn>
        </template>
        <v-list density="compact">
          <v-list-item 
            prepend-icon="mdi-wrench" 
            title="Development Mode"
            subtitle="Editable, includes editor state"
            @click="handleSqpzExport(true)"
          />
          <v-list-item 
            prepend-icon="mdi-eye" 
            title="Production Mode"
            subtitle="Viewer only, optimized"
            @click="handleSqpzExport(false)"
          />
        </v-list>
      </v-menu>
    </v-btn-group>
    
    <v-divider vertical class="mx-2" />
    
    <v-btn
      prepend-icon="mdi-eye"
      size="small"
      variant="text"
      :color="appStore.viewerMode ? 'primary' : undefined"
      :disabled="!appStore.hasScene"
      @click="toggleViewerMode"
    >
      {{ appStore.viewerMode ? 'Exit Viewer' : 'Viewer Mode' }}
    </v-btn>
    
    <v-divider vertical class="mx-2" />
    
    <v-btn-group density="compact" variant="text">
      <v-btn 
        icon="mdi-undo"
        size="small"
        :disabled="!editor.canUndo.value"
        @click="editor.undo"
        title="Undo (Ctrl+Z)"
      />
      <v-btn 
        icon="mdi-redo"
        size="small"
        :disabled="!editor.canRedo.value"
        @click="editor.redo"
        title="Redo (Ctrl+Y)"
      />
    </v-btn-group>
    
    <v-divider vertical class="mx-2" />
    
    <v-btn
      icon="mdi-console"
      size="small"
      variant="text"
      :color="appStore.showConsolePanel ? 'primary' : undefined"
      title="Toggle Console (Ctrl+` or F12)"
      @click="emit('toggleConsole')"
    />
    
    <v-btn
      :icon="appStore.showRightPanel ? 'mdi-dock-right' : 'mdi-dock-right'"
      size="small"
      variant="text"
      :color="appStore.showRightPanel ? 'primary' : undefined"
      title="Toggle Hierarchy Panel"
      @click="emit('toggleRightPanel')"
    />
  </v-app-bar>
</template>

<style scoped lang="scss">
.toolbar {
  border-bottom: 1px solid #3A3A4A !important;
  background: #1A1A24 !important;
}

.toolbar-title {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 1rem;
  font-weight: 600;
  margin-left: 8px;
}

.title-text {
  color: #E8E8F0;
}

.title-accent {
  color: #6B8AFF;
}
</style>
