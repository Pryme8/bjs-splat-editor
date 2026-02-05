/**
 * PLY Exporter - Converts splat data to PLY format
 */

export interface SplatData {
  positions: Float32Array
  scales: Float32Array
  rotations: Float32Array
  colors: Float32Array
  opacities: Float32Array
}

/**
 * Generate PLY file from splat data
 */
export function exportToPly(data: SplatData): Blob {
  const splatCount = data.opacities.length

  // Build header
  const header = [
    'ply',
    'format binary_little_endian 1.0',
    `element vertex ${splatCount}`,
    'property float x',
    'property float y', 
    'property float z',
    'property float scale_0',
    'property float scale_1',
    'property float scale_2',
    'property float rot_0',
    'property float rot_1',
    'property float rot_2',
    'property float rot_3',
    'property float f_dc_0',
    'property float f_dc_1',
    'property float f_dc_2',
    'property float opacity',
    'end_header\n'
  ].join('\n')

  const headerBytes = new TextEncoder().encode(header)
  
  // Each vertex: 16 floats = 64 bytes
  const vertexSize = 16 * 4
  const dataSize = splatCount * vertexSize
  const totalSize = headerBytes.length + dataSize

  const buffer = new ArrayBuffer(totalSize)
  const headerView = new Uint8Array(buffer)
  headerView.set(headerBytes)

  const dataView = new DataView(buffer, headerBytes.length)
  
  for (let i = 0; i < splatCount; i++) {
    const offset = i * vertexSize

    // Position
    dataView.setFloat32(offset + 0, data.positions[i * 3], true)
    dataView.setFloat32(offset + 4, data.positions[i * 3 + 1], true)
    dataView.setFloat32(offset + 8, data.positions[i * 3 + 2], true)

    // Scale
    dataView.setFloat32(offset + 12, data.scales[i * 3], true)
    dataView.setFloat32(offset + 16, data.scales[i * 3 + 1], true)
    dataView.setFloat32(offset + 20, data.scales[i * 3 + 2], true)

    // Rotation (quaternion)
    dataView.setFloat32(offset + 24, data.rotations[i * 4], true)
    dataView.setFloat32(offset + 28, data.rotations[i * 4 + 1], true)
    dataView.setFloat32(offset + 32, data.rotations[i * 4 + 2], true)
    dataView.setFloat32(offset + 36, data.rotations[i * 4 + 3], true)

    // Color (as SH DC coefficients)
    // Convert from [0,1] to SH DC space
    const SH_C0 = 0.28209479177387814
    dataView.setFloat32(offset + 40, (data.colors[i * 3] - 0.5) / SH_C0, true)
    dataView.setFloat32(offset + 44, (data.colors[i * 3 + 1] - 0.5) / SH_C0, true)
    dataView.setFloat32(offset + 48, (data.colors[i * 3 + 2] - 0.5) / SH_C0, true)

    // Opacity (inverse sigmoid)
    const op = Math.max(0.001, Math.min(0.999, data.opacities[i]))
    const invSigmoid = Math.log(op / (1 - op))
    dataView.setFloat32(offset + 52, invSigmoid, true)
  }

  return new Blob([buffer], { type: 'application/octet-stream' })
}

/**
 * Generate a downloadable PLY file
 */
export function downloadPly(data: SplatData, filename: string = 'splats.ply') {
  const blob = exportToPly(data)
  const url = URL.createObjectURL(blob)
  
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  
  URL.revokeObjectURL(url)
}

/**
 * Export to .splat format (antimatter15/splat compatible, works with Babylon.js)
 * Format: 32 bytes per splat
 * - position: 3 floats (12 bytes)
 * - scale: 3 floats (12 bytes) - actual scale values, shader applies exp()
 * - color: 4 uint8 RGBA (4 bytes)
 * - rotation: 4 uint8 quaternion normalized to [0,255] (4 bytes)
 */
export function exportToSplat(data: SplatData): Blob {
  const splatCount = data.opacities.length
  
  console.log('[PlyExporter] Exporting', splatCount, 'splats to .splat format')
  
  const bytesPerSplat = 32
  const buffer = new ArrayBuffer(splatCount * bytesPerSplat)
  const view = new DataView(buffer)

  for (let i = 0; i < splatCount; i++) {
    const offset = i * bytesPerSplat

    // Position (12 bytes) - world space coordinates
    view.setFloat32(offset + 0, data.positions[i * 3], true)
    view.setFloat32(offset + 4, data.positions[i * 3 + 1], true)
    view.setFloat32(offset + 8, data.positions[i * 3 + 2], true)

    // Scale (12 bytes) - store as log scale (shader will exp() them)
    const sx = Math.max(0.001, data.scales[i * 3])
    const sy = Math.max(0.001, data.scales[i * 3 + 1])
    const sz = Math.max(0.001, data.scales[i * 3 + 2])
    view.setFloat32(offset + 12, Math.log(sx), true)
    view.setFloat32(offset + 16, Math.log(sy), true)
    view.setFloat32(offset + 20, Math.log(sz), true)

    // Color (4 bytes) - RGBA as uint8 [0-255]
    const r = Math.floor(Math.min(1, Math.max(0, data.colors[i * 3])) * 255)
    const g = Math.floor(Math.min(1, Math.max(0, data.colors[i * 3 + 1])) * 255)
    const b = Math.floor(Math.min(1, Math.max(0, data.colors[i * 3 + 2])) * 255)
    const a = Math.floor(Math.min(1, Math.max(0, data.opacities[i])) * 255)
    
    view.setUint8(offset + 24, r)
    view.setUint8(offset + 25, g)
    view.setUint8(offset + 26, b)
    view.setUint8(offset + 27, a)

    // Rotation (4 bytes) - quaternion as uint8
    // Normalize quaternion first
    let qx = data.rotations[i * 4]
    let qy = data.rotations[i * 4 + 1]
    let qz = data.rotations[i * 4 + 2]
    let qw = data.rotations[i * 4 + 3]
    
    const qlen = Math.sqrt(qx*qx + qy*qy + qz*qz + qw*qw) || 1
    qx /= qlen
    qy /= qlen
    qz /= qlen
    qw /= qlen
    
    // Ensure w is positive (quaternion double cover)
    if (qw < 0) {
      qx = -qx
      qy = -qy
      qz = -qz
      qw = -qw
    }
    
    // Map [-1, 1] to [0, 255] with 128 as zero
    view.setUint8(offset + 28, Math.floor((qw + 1) * 127.5))
    view.setUint8(offset + 29, Math.floor((qx + 1) * 127.5))
    view.setUint8(offset + 30, Math.floor((qy + 1) * 127.5))
    view.setUint8(offset + 31, Math.floor((qz + 1) * 127.5))
  }

  console.log('[PlyExporter] Export complete, buffer size:', buffer.byteLength, 'bytes')
  return new Blob([buffer], { type: 'application/octet-stream' })
}

/**
 * Download as .splat format
 */
export function downloadSplat(data: SplatData, filename: string = 'splats.splat') {
  const blob = exportToSplat(data)
  const url = URL.createObjectURL(blob)
  
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  
  URL.revokeObjectURL(url)
}
