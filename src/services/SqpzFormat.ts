/**
 * SQPZ Format Service
 * Handles compression, decompression, export, and import of SQPZ files
 */

import * as pako from 'pako'
import type { SqpzFile, SqpzImportResult } from '@/types/sqpz'

const SQPZ_VERSION = '1.0.0'

/**
 * Convert Blob to ArrayBuffer for more efficient storage
 */
async function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  return await blob.arrayBuffer()
}

/**
 * Convert ArrayBuffer back to Blob
 */
function arrayBufferToBlob(buffer: ArrayBuffer, mimeType: string = 'application/octet-stream'): Blob {
  return new Blob([buffer], { type: mimeType })
}

/**
 * Compress SQPZ data structure to gzipped binary
 * Uses a custom binary format for better performance with large splat files
 */
export function compressSqpz(data: SqpzFile, splatBuffers: ArrayBuffer[]): Uint8Array {
  // Calculate splat sizes first
  let totalSplatSize = 0
  const splatSizes: number[] = []
  for (const buffer of splatBuffers) {
    splatSizes.push(buffer.byteLength)
    totalSplatSize += buffer.byteLength
  }

  // Separate metadata from binary data for better compression
  const metadata = {
    version: data.version,
    transforms: data.transforms,
    waypoints: data.waypoints,
    metadata: data.metadata,
    editorData: data.editorData,
    splats: data.splats.map((s, i) => ({
      name: s.name,
      type: s.type,
      wasFlipped: s.wasFlipped,
      size: splatSizes[i] // Set size immediately
    }))
  }

  // Calculate metadata size AFTER all data is set
  const metadataJson = JSON.stringify(metadata)
  const metadataBytes = new TextEncoder().encode(metadataJson)
  const metadataSize = metadataBytes.length

  // Create header: [metadataSize (4 bytes)][splatCount (4 bytes)]
  const header = new ArrayBuffer(8)
  const headerView = new DataView(header)
  headerView.setUint32(0, metadataSize, true)
  headerView.setUint32(4, splatBuffers.length, true)

  // Combine: header + metadata + splat buffers
  const totalSize = 8 + metadataSize + totalSplatSize
  const combined = new Uint8Array(totalSize)
  
  combined.set(new Uint8Array(header), 0)
  combined.set(metadataBytes, 8)
  
  let offset = 8 + metadataSize
  for (const buffer of splatBuffers) {
    combined.set(new Uint8Array(buffer), offset)
    offset += buffer.byteLength
  }

  console.log('[SqpzFormat] Compressing:', totalSize, 'bytes')
  const compressed = pako.gzip(combined)
  
  console.log('[SqpzFormat] Compressed:', totalSize, 'bytes →', compressed.length, 'bytes',
    `(${((compressed.length / totalSize) * 100).toFixed(1)}%)`)
  
  return compressed
}

/**
 * Decompress gzipped binary back to SQPZ data structure
 */
export function decompressSqpz(compressed: Uint8Array): { file: SqpzFile; splatBuffers: ArrayBuffer[] } {
  console.log('[SqpzFormat] Decompressing:', compressed.length, 'bytes')
  const decompressed = pako.ungzip(compressed)
  
  // Read header
  const headerView = new DataView(decompressed.buffer, decompressed.byteOffset, 8)
  const metadataSize = headerView.getUint32(0, true)
  const splatCount = headerView.getUint32(4, true)

  // Extract metadata JSON
  const metadataBytes = decompressed.slice(8, 8 + metadataSize)
  const metadataJson = new TextDecoder().decode(metadataBytes)
  const metadata = JSON.parse(metadataJson)

  // Extract splat buffers
  const splatBuffers: ArrayBuffer[] = []
  let offset = 8 + metadataSize
  
  for (let i = 0; i < splatCount; i++) {
    const size = metadata.splats[i].size
    const buffer = decompressed.slice(offset, offset + size).buffer
    splatBuffers.push(buffer)
    offset += size
  }

  // Reconstruct file with base64 placeholders (will be replaced during import)
  const file: SqpzFile = {
    version: metadata.version,
    transforms: metadata.transforms,
    waypoints: metadata.waypoints,
    metadata: metadata.metadata,
    editorData: metadata.editorData,
    splats: metadata.splats.map((s: any) => ({
      name: s.name,
      type: s.type,
      wasFlipped: s.wasFlipped,
      data: '' // Will use buffer directly instead
    }))
  }
  
  console.log('[SqpzFormat] Decompressed:', compressed.length, 'bytes →', decompressed.length, 'bytes')
  
  return { file, splatBuffers }
}

/**
 * Create SQPZ file structure from data (doesn't compress yet)
 * Returns both the file structure and the binary buffers
 */
export async function createSqpzData(
  splats: Array<{ name: string; blob: Blob; type: 'ply' | 'splat' | 'spz'; wasFlipped: boolean }>,
  transforms: SqpzFile['transforms'],
  waypoints: SqpzFile['waypoints'],
  metadata: SqpzFile['metadata'],
  editorData?: SqpzFile['editorData']
): Promise<{ file: SqpzFile; buffers: ArrayBuffer[] }> {
  console.log('[SqpzFormat] Creating SQPZ data for', splats.length, 'splats')
  
  // Convert all blobs to ArrayBuffers (more efficient than base64)
  const buffers: ArrayBuffer[] = []
  const splatData: SqpzFile['splats'] = []
  
  for (const splat of splats) {
    const buffer = await blobToArrayBuffer(splat.blob)
    buffers.push(buffer)
    splatData.push({
      name: splat.name,
      data: '', // Not used in new format
      type: splat.type,
      wasFlipped: splat.wasFlipped
    })
  }
  
  const sqpzFile: SqpzFile = {
    version: SQPZ_VERSION,
    splats: splatData,
    transforms,
    waypoints,
    metadata
  }
  
  // Only include editorData if provided (development mode)
  if (editorData) {
    sqpzFile.editorData = editorData
  }
  
  return { file: sqpzFile, buffers }
}

/**
 * Export SQPZ file as a downloadable Blob
 */
export function exportSqpzToBlob(data: SqpzFile, buffers: ArrayBuffer[]): Blob {
  const compressed = compressSqpz(data, buffers)
  return new Blob([compressed], { type: 'application/x-sqpz' })
}

/**
 * Import SQPZ file from Blob
 */
export async function importSqpzFromBlob(blob: Blob): Promise<SqpzImportResult & { splatBuffers: ArrayBuffer[] }> {
  console.log('[SqpzFormat] Importing SQPZ file, size:', (blob.size / 1024 / 1024).toFixed(2), 'MB')
  
  const arrayBuffer = await blob.arrayBuffer()
  const compressed = new Uint8Array(arrayBuffer)
  const { file, splatBuffers } = decompressSqpz(compressed)
  
  // Check if this is a development file
  const isDevelopmentFile = file.editorData !== undefined
  
  console.log('[SqpzFormat] Imported SQPZ v' + file.version,
    '- Splats:', file.splats.length,
    '- Waypoints:', file.waypoints.length,
    '- Development:', isDevelopmentFile)
  
  return { file, isDevelopmentFile, splatBuffers }
}

/**
 * Create splat blob from buffer for loading
 */
export function getSplatBlobFromBuffer(
  buffer: ArrayBuffer,
  name: string,
  type: 'ply' | 'splat' | 'spz'
): { blob: Blob; name: string; type: 'ply' | 'splat' | 'spz' } {
  const blob = new Blob([buffer], { type: 'application/octet-stream' })
  
  return {
    blob,
    name,
    type
  }
}

/**
 * Download SQPZ file to user's computer
 */
export function downloadSqpz(data: SqpzFile, buffers: ArrayBuffer[], filename: string = 'project.sqpz') {
  const blob = exportSqpzToBlob(data, buffers)
  const url = URL.createObjectURL(blob)
  
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  
  URL.revokeObjectURL(url)
  
  console.log('[SqpzFormat] Downloaded:', filename, `(${(blob.size / 1024 / 1024).toFixed(2)} MB)`)
}
