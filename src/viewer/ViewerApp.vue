<template>
  <v-app>
    <v-app-bar density="compact" elevation="0" class="toolbar">
      <v-toolbar-title class="toolbar-title">
        <span class="title-text">Quantum</span>
        <span class="title-accent">Splat</span>
        <span class="title-viewer">Viewer</span>
      </v-toolbar-title>
      
      <v-spacer></v-spacer>
      
      <v-btn
        prepend-icon="mdi-folder-open"
        variant="text"
        @click="handleFileOpen"
      >
        Open SQPZ
      </v-btn>
    </v-app-bar>

    <v-main>
      <div class="viewer-container">
        <SplatViewer
          v-if="sqpzData && splatBuffers.length > 0"
          :sqpz-data="sqpzData"
          :splat-buffers="splatBuffers"
          :show-controls="true"
        />
        
        <div v-else class="drop-zone" @dragover="handleDragOver" @drop="handleDrop">
          <div class="drop-content">
            <v-icon size="80" color="grey-darken-1">mdi-package-variant</v-icon>
            <h2 class="mt-4 text-grey">Drop SQPZ file here</h2>
            <p class="text-grey-darken-1">or use the Open button above</p>
            <v-btn
              variant="outlined"
              size="large"
              class="mt-6"
              @click="handleFileOpen"
            >
              <v-icon left>mdi-folder-open</v-icon>
              Open SQPZ File
            </v-btn>
          </div>
        </div>

        <!-- Loading overlay -->
        <div v-if="isLoading" class="loading-overlay">
          <v-progress-circular indeterminate color="primary" size="64"></v-progress-circular>
          <p class="mt-4">Loading...</p>
        </div>

        <!-- Error snackbar -->
        <v-snackbar v-model="showError" color="error" timeout="5000">
          {{ errorMessage }}
          <template v-slot:actions>
            <v-btn variant="text" @click="showError = false">Close</v-btn>
          </template>
        </v-snackbar>
      </div>
    </v-main>
  </v-app>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import SplatViewer from './components/viewer/SplatViewer.vue'
import { importSqpzFromBlob } from './services/SqpzFormat'
import type { SqpzFile } from './types/sqpz'

const sqpzData = ref<SqpzFile | null>(null)
const splatBuffers = ref<ArrayBuffer[]>([])
const isLoading = ref(false)
const showError = ref(false)
const errorMessage = ref('')

// Check for file parameter in URL
const urlParams = new URLSearchParams(window.location.search)
const fileUrl = urlParams.get('file')
if (fileUrl) {
  loadFromUrl(fileUrl)
}

async function loadFromUrl(url: string) {
  try {
    isLoading.value = true
    const response = await fetch(url)
    const blob = await response.blob()
    await loadSqpzFile(blob)
  } catch (error) {
    console.error('[ViewerApp] Failed to load from URL:', error)
    errorMessage.value = 'Failed to load file from URL'
    showError.value = true
  } finally {
    isLoading.value = false
  }
}

async function loadSqpzFile(blob: Blob) {
  try {
    isLoading.value = true
    const { file, splatBuffers: buffers } = await importSqpzFromBlob(blob)
    sqpzData.value = file
    splatBuffers.value = buffers
    console.log('[ViewerApp] Loaded SQPZ:', file.metadata.projectName)
  } catch (error) {
    console.error('[ViewerApp] Failed to load SQPZ:', error)
    errorMessage.value = error instanceof Error ? error.message : 'Failed to load SQPZ file'
    showError.value = true
  } finally {
    isLoading.value = false
  }
}

function handleFileOpen() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.sqpz'
  input.onchange = async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0]
    if (file) {
      await loadSqpzFile(file)
    }
  }
  input.click()
}

function handleDragOver(e: DragEvent) {
  e.preventDefault()
  e.dataTransfer!.dropEffect = 'copy'
}

async function handleDrop(e: DragEvent) {
  e.preventDefault()
  const file = e.dataTransfer?.files[0]
  if (file && file.name.endsWith('.sqpz')) {
    await loadSqpzFile(file)
  } else {
    errorMessage.value = 'Please drop a .sqpz file'
    showError.value = true
  }
}
</script>

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

.title-viewer {
  color: #8B8B9A;
  font-weight: 400;
  margin-left: 4px;
}

.viewer-container {
  width: 100%;
  height: 100vh;
  position: relative;
  background: #0D0D12;
}

.drop-zone {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  border: 3px dashed rgba(107, 138, 255, 0.3);
  border-radius: 12px;
  margin: 16px;
  transition: all 0.3s ease;
}

.drop-zone:hover {
  border-color: rgba(107, 138, 255, 0.6);
  background: rgba(107, 138, 255, 0.05);
}

.drop-content {
  text-align: center;
  pointer-events: none;
  
  .v-btn {
    pointer-events: auto;
  }
}

.loading-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.85);
  color: white;
  z-index: 1000;
}
</style>
