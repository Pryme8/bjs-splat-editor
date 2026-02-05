/**
 * PLY Cleanup Service
 * Post-processing for Gaussian Splat PLY files to remove floaters and artifacts
 * Supports both ASCII and Binary PLY formats
 */

import * as fs from 'fs/promises'

export interface CleanupConfig {
  // Opacity: Remove splats with opacity below this (0-1, default 0.05)
  minOpacity?: number
  // Scale: Remove splats larger than this percentile (0-100, default 99)
  maxScalePercentile?: number
  // SOR: Remove outliers beyond this many standard deviations (default 3.0)
  sorStdDevs?: number
  // Whether cleanup is enabled at all
  enabled?: boolean
}

export const DefaultCleanupConfig: CleanupConfig = {
  minOpacity: 0.05,
  maxScalePercentile: 99,
  sorStdDevs: 3.0,
  enabled: true
}

interface PropertyInfo {
  name: string
  type: string
  byteSize: number
  offset: number
}

interface GaussianSplat {
  // Position
  x: number
  y: number
  z: number
  // Scale (log scale in PLY)
  scale0: number
  scale1: number
  scale2: number
  // Opacity (logit in PLY, we'll convert)
  opacity: number
  // Index in original data
  index: number
}

interface CleanupStats {
  originalCount: number
  afterOpacity: number
  afterScale: number
  afterSOR: number
  finalCount: number
  removedOpacity: number
  removedScale: number
  removedSOR: number
}

interface PlyHeader {
  format: 'ascii' | 'binary_little_endian' | 'binary_big_endian'
  vertexCount: number
  headerEndByte: number
  headerText: string
  properties: PropertyInfo[]
  vertexByteSize: number
}

/**
 * Get byte size for PLY property type
 */
function getTypeSize(type: string): number {
  switch (type) {
    case 'float': case 'float32': return 4
    case 'double': case 'float64': return 8
    case 'int': case 'int32': return 4
    case 'uint': case 'uint32': return 4
    case 'short': case 'int16': return 2
    case 'ushort': case 'uint16': return 2
    case 'char': case 'int8': return 1
    case 'uchar': case 'uint8': return 1
    default: return 4 // Default to float
  }
}

/**
 * Sigmoid function to convert logit opacity to 0-1 range
 */
function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x))
}

/**
 * Calculate the magnitude of a scale vector (for filtering large splats)
 */
function scaleMagnitude(s0: number, s1: number, s2: number): number {
  // Scale values are log-scale in PLY, so exp them first
  const exp0 = Math.exp(s0)
  const exp1 = Math.exp(s1)
  const exp2 = Math.exp(s2)
  return Math.sqrt(exp0 * exp0 + exp1 * exp1 + exp2 * exp2)
}

/**
 * Calculate percentile value from sorted array
 */
function percentile(sortedValues: number[], p: number): number {
  const index = Math.floor((p / 100) * (sortedValues.length - 1))
  return sortedValues[index]
}

/**
 * Parse PLY header from buffer
 */
function parsePlyHeaderFromBuffer(buffer: Buffer): PlyHeader {
  // Find end_header
  const headerEndMarker = 'end_header\n'
  let headerEndPos = buffer.indexOf(headerEndMarker)
  if (headerEndPos === -1) {
    // Try with \r\n
    const headerEndMarker2 = 'end_header\r\n'
    headerEndPos = buffer.indexOf(headerEndMarker2)
    if (headerEndPos === -1) {
      throw new Error('Could not find end_header in PLY file')
    }
    headerEndPos += headerEndMarker2.length
  } else {
    headerEndPos += headerEndMarker.length
  }

  const headerText = buffer.toString('utf-8', 0, headerEndPos)
  const lines = headerText.split('\n')
  
  let format: 'ascii' | 'binary_little_endian' | 'binary_big_endian' = 'ascii'
  let vertexCount = 0
  const properties: PropertyInfo[] = []
  let currentOffset = 0
  let inVertexElement = false

  for (const line of lines) {
    const trimmed = line.trim()
    
    if (trimmed.startsWith('format ')) {
      const formatStr = trimmed.split(' ')[1]
      if (formatStr === 'binary_little_endian') format = 'binary_little_endian'
      else if (formatStr === 'binary_big_endian') format = 'binary_big_endian'
      else format = 'ascii'
    } else if (trimmed.startsWith('element vertex ')) {
      vertexCount = parseInt(trimmed.split(' ')[2])
      inVertexElement = true
    } else if (trimmed.startsWith('element ') && inVertexElement) {
      // Another element started, stop collecting vertex properties
      inVertexElement = false
    } else if (trimmed.startsWith('property ') && inVertexElement) {
      const parts = trimmed.split(' ')
      // property <type> <name>
      const type = parts[1]
      const name = parts[parts.length - 1]
      const byteSize = getTypeSize(type)
      
      properties.push({
        name,
        type,
        byteSize,
        offset: currentOffset
      })
      currentOffset += byteSize
    }
  }

  return {
    format,
    vertexCount,
    headerEndByte: headerEndPos,
    headerText,
    properties,
    vertexByteSize: currentOffset
  }
}

/**
 * Find property by name in header
 */
function findProperty(header: PlyHeader, name: string): PropertyInfo | undefined {
  return header.properties.find(p => p.name === name)
}

/**
 * Read a float value from buffer at offset
 */
function readFloat(buffer: Buffer, offset: number, littleEndian: boolean): number {
  return littleEndian ? buffer.readFloatLE(offset) : buffer.readFloatBE(offset)
}

/**
 * Parse binary PLY file and extract splat data
 */
function parseBinaryPly(buffer: Buffer, header: PlyHeader): GaussianSplat[] {
  const splats: GaussianSplat[] = []
  const littleEndian = header.format === 'binary_little_endian'
  
  const xProp = findProperty(header, 'x')
  const yProp = findProperty(header, 'y')
  const zProp = findProperty(header, 'z')
  const scale0Prop = findProperty(header, 'scale_0')
  const scale1Prop = findProperty(header, 'scale_1')
  const scale2Prop = findProperty(header, 'scale_2')
  const opacityProp = findProperty(header, 'opacity')

  if (!xProp || !yProp || !zProp) {
    throw new Error('PLY file missing required position properties (x, y, z)')
  }

  const dataStart = header.headerEndByte
  const vertexSize = header.vertexByteSize

  for (let i = 0; i < header.vertexCount; i++) {
    const vertexOffset = dataStart + (i * vertexSize)
    
    const x = readFloat(buffer, vertexOffset + xProp.offset, littleEndian)
    const y = readFloat(buffer, vertexOffset + yProp.offset, littleEndian)
    const z = readFloat(buffer, vertexOffset + zProp.offset, littleEndian)
    
    const scale0 = scale0Prop ? readFloat(buffer, vertexOffset + scale0Prop.offset, littleEndian) : 0
    const scale1 = scale1Prop ? readFloat(buffer, vertexOffset + scale1Prop.offset, littleEndian) : 0
    const scale2 = scale2Prop ? readFloat(buffer, vertexOffset + scale2Prop.offset, littleEndian) : 0
    
    const opacityRaw = opacityProp ? readFloat(buffer, vertexOffset + opacityProp.offset, littleEndian) : 0
    const opacity = sigmoid(opacityRaw)

    splats.push({
      x, y, z,
      scale0, scale1, scale2,
      opacity,
      index: i
    })
  }

  return splats
}

/**
 * Filter splats by minimum opacity
 */
function filterByOpacity(splats: GaussianSplat[], minOpacity: number): GaussianSplat[] {
  return splats.filter(s => s.opacity >= minOpacity)
}

/**
 * Filter splats by maximum scale (percentile-based)
 */
function filterByScale(splats: GaussianSplat[], maxPercentile: number): GaussianSplat[] {
  if (splats.length === 0) return splats
  
  // Calculate scale magnitudes
  const scales = splats.map(s => scaleMagnitude(s.scale0, s.scale1, s.scale2))
  const sortedScales = [...scales].sort((a, b) => a - b)
  const maxScale = percentile(sortedScales, maxPercentile)

  return splats.filter((s, i) => scales[i] <= maxScale)
}

/**
 * Statistical Outlier Removal - remove splats far from the centroid
 */
function filterBySOR(splats: GaussianSplat[], stdDevs: number): GaussianSplat[] {
  if (splats.length < 10) return splats // Not enough points for statistics

  // Calculate centroid
  let sumX = 0, sumY = 0, sumZ = 0
  for (const s of splats) {
    sumX += s.x
    sumY += s.y
    sumZ += s.z
  }
  const centroidX = sumX / splats.length
  const centroidY = sumY / splats.length
  const centroidZ = sumZ / splats.length

  // Calculate distances from centroid
  const distances = splats.map(s => {
    const dx = s.x - centroidX
    const dy = s.y - centroidY
    const dz = s.z - centroidZ
    return Math.sqrt(dx * dx + dy * dy + dz * dz)
  })

  // Calculate mean and standard deviation of distances
  const meanDist = distances.reduce((a, b) => a + b, 0) / distances.length
  const variance = distances.reduce((sum, d) => sum + (d - meanDist) ** 2, 0) / distances.length
  const stdDev = Math.sqrt(variance)

  // Filter out points beyond threshold
  const maxDist = meanDist + (stdDevs * stdDev)
  return splats.filter((s, i) => distances[i] <= maxDist)
}

/**
 * Write filtered splats back to binary PLY file
 * Only keeps vertices that are in the filteredSplats array (by index)
 */
async function writeBinaryPly(
  originalBuffer: Buffer,
  header: PlyHeader,
  filteredSplats: GaussianSplat[],
  outputPath: string
): Promise<void> {
  // Create new header with updated vertex count
  const newHeaderText = header.headerText.replace(
    /element vertex \d+/,
    `element vertex ${filteredSplats.length}`
  )
  
  // Calculate new buffer size
  const headerBuffer = Buffer.from(newHeaderText, 'utf-8')
  const dataSize = filteredSplats.length * header.vertexByteSize
  const newBuffer = Buffer.alloc(headerBuffer.length + dataSize)
  
  // Copy header
  headerBuffer.copy(newBuffer, 0)
  
  // Copy filtered vertex data
  const dataStart = header.headerEndByte
  const vertexSize = header.vertexByteSize
  
  for (let i = 0; i < filteredSplats.length; i++) {
    const originalIndex = filteredSplats[i].index
    const srcOffset = dataStart + (originalIndex * vertexSize)
    const dstOffset = headerBuffer.length + (i * vertexSize)
    
    originalBuffer.copy(newBuffer, dstOffset, srcOffset, srcOffset + vertexSize)
  }
  
  await fs.writeFile(outputPath, newBuffer)
}

/**
 * Main cleanup function - supports both ASCII and Binary PLY
 */
export async function cleanupPly(
  inputPath: string,
  outputPath: string,
  config: CleanupConfig = DefaultCleanupConfig
): Promise<CleanupStats> {
  console.log(`[PLY Cleanup] Starting cleanup of ${inputPath}`)
  console.log(`[PLY Cleanup] Config:`, config)

  // Read file as buffer (works for both ASCII and binary)
  const buffer = await fs.readFile(inputPath)
  
  // Parse header
  const header = parsePlyHeaderFromBuffer(buffer)
  console.log(`[PLY Cleanup] Format: ${header.format}, Vertices: ${header.vertexCount}, Vertex size: ${header.vertexByteSize} bytes`)

  // Parse splats based on format
  let splats: GaussianSplat[]
  
  if (header.format === 'ascii') {
    // For ASCII, convert buffer to string and parse
    const content = buffer.toString('utf-8')
    splats = parseAsciiPlyFromString(content, header)
  } else {
    // Binary format
    splats = parseBinaryPly(buffer, header)
  }
  
  const originalCount = splats.length
  console.log(`[PLY Cleanup] Parsed ${originalCount} splats`)

  const stats: CleanupStats = {
    originalCount,
    afterOpacity: originalCount,
    afterScale: originalCount,
    afterSOR: originalCount,
    finalCount: originalCount,
    removedOpacity: 0,
    removedScale: 0,
    removedSOR: 0
  }

  // Apply filters
  if (config.minOpacity !== undefined && config.minOpacity > 0) {
    splats = filterByOpacity(splats, config.minOpacity)
    stats.afterOpacity = splats.length
    stats.removedOpacity = stats.originalCount - stats.afterOpacity
    console.log(`[PLY Cleanup] After opacity filter (>= ${config.minOpacity}): ${splats.length} splats (removed ${stats.removedOpacity})`)
  }

  if (config.maxScalePercentile !== undefined && config.maxScalePercentile < 100) {
    const beforeScale = splats.length
    splats = filterByScale(splats, config.maxScalePercentile)
    stats.afterScale = splats.length
    stats.removedScale = beforeScale - stats.afterScale
    console.log(`[PLY Cleanup] After scale filter (<= ${config.maxScalePercentile}th percentile): ${splats.length} splats (removed ${stats.removedScale})`)
  }

  if (config.sorStdDevs !== undefined && config.sorStdDevs > 0) {
    const beforeSOR = splats.length
    splats = filterBySOR(splats, config.sorStdDevs)
    stats.afterSOR = splats.length
    stats.removedSOR = beforeSOR - stats.afterSOR
    console.log(`[PLY Cleanup] After SOR filter (<= ${config.sorStdDevs} std devs): ${splats.length} splats (removed ${stats.removedSOR})`)
  }

  stats.finalCount = splats.length
  console.log(`[PLY Cleanup] Final: ${stats.finalCount} splats (removed ${originalCount - stats.finalCount} total, ${((1 - stats.finalCount / originalCount) * 100).toFixed(1)}%)`)

  // Write output based on format
  if (header.format === 'ascii') {
    await writeAsciiPly(buffer.toString('utf-8'), header, splats, outputPath)
  } else {
    await writeBinaryPly(buffer, header, splats, outputPath)
  }
  
  console.log(`[PLY Cleanup] Written cleaned PLY to ${outputPath}`)

  return stats
}

/**
 * Parse ASCII PLY from string content
 */
function parseAsciiPlyFromString(content: string, header: PlyHeader): GaussianSplat[] {
  const splats: GaussianSplat[] = []
  const dataContent = content.substring(header.headerEndByte)
  const lines = dataContent.split('\n').filter(l => l.trim())

  // Find property indices by name
  const propIndex = (name: string) => header.properties.findIndex(p => p.name === name)
  
  const xIdx = propIndex('x')
  const yIdx = propIndex('y')
  const zIdx = propIndex('z')
  const scale0Idx = propIndex('scale_0')
  const scale1Idx = propIndex('scale_1')
  const scale2Idx = propIndex('scale_2')
  const opacityIdx = propIndex('opacity')

  for (let i = 0; i < Math.min(lines.length, header.vertexCount); i++) {
    const line = lines[i]
    const values = line.trim().split(/\s+/).map(parseFloat)

    splats.push({
      x: xIdx >= 0 ? values[xIdx] : 0,
      y: yIdx >= 0 ? values[yIdx] : 0,
      z: zIdx >= 0 ? values[zIdx] : 0,
      scale0: scale0Idx >= 0 ? values[scale0Idx] : 0,
      scale1: scale1Idx >= 0 ? values[scale1Idx] : 0,
      scale2: scale2Idx >= 0 ? values[scale2Idx] : 0,
      opacity: opacityIdx >= 0 ? sigmoid(values[opacityIdx]) : 1,
      index: i
    })
  }

  return splats
}

/**
 * Write ASCII PLY file
 */
async function writeAsciiPly(
  originalContent: string,
  header: PlyHeader,
  filteredSplats: GaussianSplat[],
  outputPath: string
): Promise<void> {
  // Reconstruct header with new vertex count
  const newHeader = header.headerText.replace(
    /element vertex \d+/,
    `element vertex ${filteredSplats.length}`
  )

  // Get original data lines
  const dataContent = originalContent.substring(header.headerEndByte)
  const lines = dataContent.split('\n').filter(l => l.trim())

  // Select only the filtered lines
  const filteredLines = filteredSplats.map(s => lines[s.index])
  const output = newHeader + filteredLines.join('\n') + '\n'

  await fs.writeFile(outputPath, output, 'utf-8')
}

/**
 * Check if a PLY file needs cleanup (quick header check)
 */
export async function checkPlyFormat(filePath: string): Promise<{
  format: string
  vertexCount: number
  canCleanup: boolean
}> {
  const buffer = await fs.readFile(filePath)
  const header = parsePlyHeaderFromBuffer(buffer)
  
  return {
    format: header.format,
    vertexCount: header.vertexCount,
    canCleanup: true  // Now supports both ASCII and binary
  }
}
