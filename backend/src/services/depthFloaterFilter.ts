/**
 * Depth-Based Floater Filter
 * 
 * Uses depth maps from Depth Anything to detect and remove floating splats
 * that don't correspond to actual geometry.
 * 
 * Approach:
 * 1. Project each splat to each camera view
 * 2. Compare splat depth to estimated depth from Depth Anything
 * 3. If splat depth differs significantly, it's likely a floater
 */

import path from 'path'
import fs from 'fs/promises'
import { loadDepthMap, getDepthAt, type DepthSummary } from './depthEstimation.js'

export interface Camera {
  id: number
  position: [number, number, number]
  rotation: [number, number, number, number]  // Quaternion [qx, qy, qz, qw]
  focalLength: number
  width: number
  height: number
  imageName: string
}

export interface FloaterFilterConfig {
  /** Depth difference threshold (0-1 normalized). Default: 0.15 */
  depthThreshold?: number
  /** Minimum number of cameras that must agree splat is a floater. Default: 2 */
  minCamerasAgreeing?: number
  /** Whether to use median depth in neighborhood. Default: true */
  useNeighborhoodMedian?: boolean
  /** Neighborhood size for median (pixels). Default: 5 */
  neighborhoodSize?: number
}

export interface FloaterFilterResult {
  totalSplats: number
  floatersDetected: number
  floaterIndices: number[]
  confidence: number[]  // How confident we are each floater is actually a floater
}

/**
 * Quaternion to rotation matrix
 */
function quaternionToMatrix(qx: number, qy: number, qz: number, qw: number): number[][] {
  const xx = qx * qx
  const yy = qy * qy
  const zz = qz * qz
  const xy = qx * qy
  const xz = qx * qz
  const yz = qy * qz
  const wx = qw * qx
  const wy = qw * qy
  const wz = qw * qz
  
  return [
    [1 - 2 * (yy + zz), 2 * (xy - wz), 2 * (xz + wy)],
    [2 * (xy + wz), 1 - 2 * (xx + zz), 2 * (yz - wx)],
    [2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (xx + yy)]
  ]
}

/**
 * Project a 3D point to camera image coordinates
 */
function projectToCamera(
  point: [number, number, number],
  camera: Camera
): { x: number; y: number; depth: number } | null {
  // Transform point to camera space
  const R = quaternionToMatrix(
    camera.rotation[0],
    camera.rotation[1],
    camera.rotation[2],
    camera.rotation[3]
  )
  
  // Point relative to camera
  const dx = point[0] - camera.position[0]
  const dy = point[1] - camera.position[1]
  const dz = point[2] - camera.position[2]
  
  // Rotate to camera coordinates
  const camX = R[0][0] * dx + R[0][1] * dy + R[0][2] * dz
  const camY = R[1][0] * dx + R[1][1] * dy + R[1][2] * dz
  const camZ = R[2][0] * dx + R[2][1] * dy + R[2][2] * dz
  
  // Check if point is in front of camera
  if (camZ <= 0) {
    return null
  }
  
  // Project to image plane
  const imgX = (camX / camZ) * camera.focalLength + camera.width / 2
  const imgY = (camY / camZ) * camera.focalLength + camera.height / 2
  
  // Check if within image bounds
  if (imgX < 0 || imgX >= camera.width || imgY < 0 || imgY >= camera.height) {
    return null
  }
  
  return { x: imgX, y: imgY, depth: camZ }
}

/**
 * Get median depth in a neighborhood
 */
function getMedianDepthInNeighborhood(
  depthMap: Float32Array,
  width: number,
  height: number,
  x: number,
  y: number,
  radius: number
): number {
  const values: number[] = []
  
  const startX = Math.max(0, Math.floor(x - radius))
  const endX = Math.min(width - 1, Math.ceil(x + radius))
  const startY = Math.max(0, Math.floor(y - radius))
  const endY = Math.min(height - 1, Math.ceil(y + radius))
  
  for (let py = startY; py <= endY; py++) {
    for (let px = startX; px <= endX; px++) {
      const idx = py * width + px
      if (idx >= 0 && idx < depthMap.length) {
        values.push(depthMap[idx])
      }
    }
  }
  
  if (values.length === 0) {
    return 0
  }
  
  values.sort((a, b) => a - b)
  return values[Math.floor(values.length / 2)]
}

/**
 * Detect floaters using depth maps
 */
export async function detectFloaters(
  splatPositions: Float32Array,  // Flat array [x0,y0,z0, x1,y1,z1, ...]
  cameras: Camera[],
  depthMapsDir: string,
  depthSummary: DepthSummary,
  config: FloaterFilterConfig = {}
): Promise<FloaterFilterResult> {
  const {
    depthThreshold = 0.15,
    minCamerasAgreeing = 2,
    useNeighborhoodMedian = true,
    neighborhoodSize = 5
  } = config
  
  const splatCount = splatPositions.length / 3
  const floaterVotes = new Int32Array(splatCount)  // Count of cameras voting "floater"
  const totalVotes = new Int32Array(splatCount)    // Total cameras that could see this splat
  
  console.log(`[FloaterFilter] Analyzing ${splatCount} splats against ${cameras.length} cameras`)
  
  // Load all depth maps
  const depthMaps = new Map<string, { data: Float32Array; width: number; height: number }>()
  
  for (const depthResult of depthSummary.images) {
    if (depthResult.error || !depthResult.output_file) continue
    
    try {
      const depthPath = path.join(depthMapsDir, depthResult.output_file)
      const depthData = await loadDepthMap(depthPath)
      depthMaps.set(depthResult.source, {
        data: depthData,
        width: depthResult.width!,
        height: depthResult.height!
      })
    } catch (e) {
      console.warn(`[FloaterFilter] Failed to load depth map for ${depthResult.source}:`, e)
    }
  }
  
  console.log(`[FloaterFilter] Loaded ${depthMaps.size} depth maps`)
  
  // For each camera, check splats
  for (const camera of cameras) {
    const depthInfo = depthMaps.get(camera.imageName)
    if (!depthInfo) {
      console.warn(`[FloaterFilter] No depth map for camera ${camera.imageName}`)
      continue
    }
    
    // Calculate depth range for this view (for normalization)
    let minDepth = Infinity
    let maxDepth = -Infinity
    
    // First pass: find depth range of visible splats
    for (let i = 0; i < splatCount; i++) {
      const point: [number, number, number] = [
        splatPositions[i * 3],
        splatPositions[i * 3 + 1],
        splatPositions[i * 3 + 2]
      ]
      
      const proj = projectToCamera(point, camera)
      if (proj) {
        minDepth = Math.min(minDepth, proj.depth)
        maxDepth = Math.max(maxDepth, proj.depth)
      }
    }
    
    if (minDepth === Infinity) continue
    
    const depthRange = maxDepth - minDepth
    if (depthRange < 0.001) continue
    
    // Second pass: compare depths
    for (let i = 0; i < splatCount; i++) {
      const point: [number, number, number] = [
        splatPositions[i * 3],
        splatPositions[i * 3 + 1],
        splatPositions[i * 3 + 2]
      ]
      
      const proj = projectToCamera(point, camera)
      if (!proj) continue
      
      totalVotes[i]++
      
      // Get expected depth from depth map (normalized 0-1, where 0 = far, 1 = close)
      let expectedDepthNorm: number
      if (useNeighborhoodMedian) {
        expectedDepthNorm = getMedianDepthInNeighborhood(
          depthInfo.data,
          depthInfo.width,
          depthInfo.height,
          proj.x,
          proj.y,
          neighborhoodSize
        )
      } else {
        expectedDepthNorm = getDepthAt(depthInfo.data, depthInfo.width, proj.x, proj.y)
      }
      
      // Normalize actual depth to 0-1 range (invert so close = higher value like depth map)
      const actualDepthNorm = 1.0 - (proj.depth - minDepth) / depthRange
      
      // Compare depths
      const depthDiff = Math.abs(actualDepthNorm - expectedDepthNorm)
      
      if (depthDiff > depthThreshold) {
        floaterVotes[i]++
      }
    }
  }
  
  // Identify floaters based on voting
  const floaterIndices: number[] = []
  const confidence: number[] = []
  
  for (let i = 0; i < splatCount; i++) {
    if (totalVotes[i] < minCamerasAgreeing) continue
    
    const floaterRatio = floaterVotes[i] / totalVotes[i]
    
    // If majority of views vote floater, mark it
    if (floaterVotes[i] >= minCamerasAgreeing && floaterRatio > 0.5) {
      floaterIndices.push(i)
      confidence.push(floaterRatio)
    }
  }
  
  console.log(`[FloaterFilter] Detected ${floaterIndices.length} potential floaters`)
  
  return {
    totalSplats: splatCount,
    floatersDetected: floaterIndices.length,
    floaterIndices,
    confidence
  }
}

/**
 * Remove floaters from PLY data
 */
export async function removeFloatersFromPly(
  inputPlyPath: string,
  outputPlyPath: string,
  floaterIndices: Set<number>
): Promise<{ originalCount: number; newCount: number }> {
  const content = await fs.readFile(inputPlyPath)
  
  // Find header end
  const headerEnd = content.indexOf(Buffer.from('end_header\n'))
  if (headerEnd === -1) {
    throw new Error('Invalid PLY file: no end_header found')
  }
  
  const headerStr = content.slice(0, headerEnd).toString('utf-8')
  const dataStart = headerEnd + 'end_header\n'.length
  
  // Parse vertex count from header
  const vertexMatch = headerStr.match(/element vertex (\d+)/)
  if (!vertexMatch) {
    throw new Error('Invalid PLY file: no vertex count found')
  }
  const vertexCount = parseInt(vertexMatch[1], 10)
  
  // Calculate bytes per vertex (assuming standard Gaussian splat format)
  const dataLength = content.length - dataStart
  const bytesPerVertex = Math.floor(dataLength / vertexCount)
  
  // Filter vertices
  const newVertices: Buffer[] = []
  for (let i = 0; i < vertexCount; i++) {
    if (!floaterIndices.has(i)) {
      const start = dataStart + i * bytesPerVertex
      const end = start + bytesPerVertex
      newVertices.push(content.slice(start, end))
    }
  }
  
  // Update header with new vertex count
  const newHeader = headerStr.replace(
    /element vertex \d+/,
    `element vertex ${newVertices.length}`
  )
  
  // Write new file
  const newContent = Buffer.concat([
    Buffer.from(newHeader + 'end_header\n'),
    ...newVertices
  ])
  
  await fs.writeFile(outputPlyPath, newContent)
  
  return {
    originalCount: vertexCount,
    newCount: newVertices.length
  }
}

export default {
  detectFloaters,
  removeFloatersFromPly
}
