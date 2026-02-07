/**
 * PLY Parser - Extracts essential splat data from PLY files
 * Strips higher-order spherical harmonics for smaller file sizes
 */

import type { SplatData } from './PlyExporter'

interface PlyProperty {
  name: string
  type: string
  size: number
  offset: number
}

interface PlyHeader {
  format: 'ascii' | 'binary_little_endian' | 'binary_big_endian'
  vertexCount: number
  headerEndByte: number
  properties: PlyProperty[]
  vertexByteSize: number
}

function getTypeSize(type: string): number {
  switch (type) {
    case 'float':
    case 'float32':
      return 4
    case 'double':
    case 'float64':
      return 8
    case 'int':
    case 'int32':
    case 'uint':
    case 'uint32':
      return 4
    case 'short':
    case 'int16':
    case 'ushort':
    case 'uint16':
      return 2
    case 'char':
    case 'int8':
    case 'uchar':
    case 'uint8':
      return 1
    default:
      return 4
  }
}

function parsePlyHeader(data: Uint8Array): PlyHeader {
  const headerEndMarker = 'end_header\n'
  const decoder = new TextDecoder()
  
  let headerEndPos = -1
  for (let i = 0; i < Math.min(data.length, 100000); i++) {
    const substr = decoder.decode(data.slice(i, i + headerEndMarker.length))
    if (substr === headerEndMarker) {
      headerEndPos = i + headerEndMarker.length
      break
    }
  }
  
  if (headerEndPos < 0) {
    throw new Error('Invalid PLY file - no end_header found')
  }
  
  const headerText = decoder.decode(data.slice(0, headerEndPos))
  const lines = headerText.split('\n').map(l => l.trim())
  
  let format: 'ascii' | 'binary_little_endian' | 'binary_big_endian' = 'binary_little_endian'
  let vertexCount = 0
  let inVertexElement = false
  const properties: PlyProperty[] = []
  let offset = 0
  
  for (const line of lines) {
    if (line.startsWith('format ')) {
      const formatStr = line.split(' ')[1]
      if (formatStr === 'ascii') format = 'ascii'
      else if (formatStr === 'binary_little_endian') format = 'binary_little_endian'
      else if (formatStr === 'binary_big_endian') format = 'binary_big_endian'
    } else if (line.startsWith('element vertex ')) {
      vertexCount = parseInt(line.split(' ')[2])
      inVertexElement = true
    } else if (line.startsWith('element ') && inVertexElement) {
      inVertexElement = false
    } else if (line.startsWith('property ') && inVertexElement) {
      const parts = line.split(' ')
      const type = parts[1]
      const name = parts[parts.length - 1]
      const size = getTypeSize(type)
      
      properties.push({ name, type, size, offset })
      offset += size
    }
  }
  
  return {
    format,
    vertexCount,
    headerEndByte: headerEndPos,
    properties,
    vertexByteSize: offset
  }
}

function findProperty(properties: PlyProperty[], name: string): PlyProperty | undefined {
  return properties.find(p => p.name === name)
}

const SH_C0 = 0.28209479177387814

/**
 * Parse PLY blob and extract essential splat data (strips higher-order SH)
 */
export async function parsePlyToSplatData(blob: Blob): Promise<SplatData> {
  const arrayBuffer = await blob.arrayBuffer()
  const data = new Uint8Array(arrayBuffer)
  
  const header = parsePlyHeader(data)
  
  if (header.format === 'ascii') {
    throw new Error('ASCII PLY format not yet supported for parsing')
  }
  
  const vertexCount = header.vertexCount
  const dataView = new DataView(data.buffer, data.byteOffset + header.headerEndByte)
  
  // Find required properties
  const xProp = findProperty(header.properties, 'x')
  const yProp = findProperty(header.properties, 'y')
  const zProp = findProperty(header.properties, 'z')
  const scale0Prop = findProperty(header.properties, 'scale_0')
  const scale1Prop = findProperty(header.properties, 'scale_1')
  const scale2Prop = findProperty(header.properties, 'scale_2')
  const rot0Prop = findProperty(header.properties, 'rot_0')
  const rot1Prop = findProperty(header.properties, 'rot_1')
  const rot2Prop = findProperty(header.properties, 'rot_2')
  const rot3Prop = findProperty(header.properties, 'rot_3')
  const fdc0Prop = findProperty(header.properties, 'f_dc_0')
  const fdc1Prop = findProperty(header.properties, 'f_dc_1')
  const fdc2Prop = findProperty(header.properties, 'f_dc_2')
  const opacityProp = findProperty(header.properties, 'opacity')
  
  if (!xProp || !yProp || !zProp || !scale0Prop || !scale1Prop || !scale2Prop ||
      !rot0Prop || !rot1Prop || !rot2Prop || !rot3Prop ||
      !fdc0Prop || !fdc1Prop || !fdc2Prop || !opacityProp) {
    throw new Error('PLY file missing required properties for Gaussian Splats')
  }
  
  // Allocate output arrays
  const positions = new Float32Array(vertexCount * 3)
  const scales = new Float32Array(vertexCount * 3)
  const rotations = new Float32Array(vertexCount * 4)
  const colors = new Float32Array(vertexCount * 3)
  const opacities = new Float32Array(vertexCount)
  
  const littleEndian = header.format === 'binary_little_endian'
  
  // Parse each vertex
  for (let i = 0; i < vertexCount; i++) {
    const vertexOffset = i * header.vertexByteSize
    
    // Position
    positions[i * 3 + 0] = dataView.getFloat32(vertexOffset + xProp.offset, littleEndian)
    positions[i * 3 + 1] = dataView.getFloat32(vertexOffset + yProp.offset, littleEndian)
    positions[i * 3 + 2] = dataView.getFloat32(vertexOffset + zProp.offset, littleEndian)
    
    // Scale (stored as log scale in PLY, but we keep it as-is for now)
    scales[i * 3 + 0] = dataView.getFloat32(vertexOffset + scale0Prop.offset, littleEndian)
    scales[i * 3 + 1] = dataView.getFloat32(vertexOffset + scale1Prop.offset, littleEndian)
    scales[i * 3 + 2] = dataView.getFloat32(vertexOffset + scale2Prop.offset, littleEndian)
    
    // Rotation quaternion
    rotations[i * 4 + 0] = dataView.getFloat32(vertexOffset + rot0Prop.offset, littleEndian)
    rotations[i * 4 + 1] = dataView.getFloat32(vertexOffset + rot1Prop.offset, littleEndian)
    rotations[i * 4 + 2] = dataView.getFloat32(vertexOffset + rot2Prop.offset, littleEndian)
    rotations[i * 4 + 3] = dataView.getFloat32(vertexOffset + rot3Prop.offset, littleEndian)
    
    // Color from f_dc (SH degree 0 coefficients) - convert to [0,1] range
    const fdc0 = dataView.getFloat32(vertexOffset + fdc0Prop.offset, littleEndian)
    const fdc1 = dataView.getFloat32(vertexOffset + fdc1Prop.offset, littleEndian)
    const fdc2 = dataView.getFloat32(vertexOffset + fdc2Prop.offset, littleEndian)
    
    colors[i * 3 + 0] = Math.max(0, Math.min(1, fdc0 * SH_C0 + 0.5))
    colors[i * 3 + 1] = Math.max(0, Math.min(1, fdc1 * SH_C0 + 0.5))
    colors[i * 3 + 2] = Math.max(0, Math.min(1, fdc2 * SH_C0 + 0.5))
    
    // Opacity (stored as logit in PLY) - convert to [0,1] range
    const opacityLogit = dataView.getFloat32(vertexOffset + opacityProp.offset, littleEndian)
    opacities[i] = 1 / (1 + Math.exp(-opacityLogit))
  }
  
  console.log(`[PlyParser] Parsed ${vertexCount} splats from PLY (stripped higher-order SH)`)
  
  return {
    positions,
    scales,
    rotations,
    colors,
    opacities
  }
}
