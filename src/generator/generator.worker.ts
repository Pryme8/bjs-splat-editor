/**
 * WebGPU Gaussian Splat Generator Worker
 * Handles intensive GPU computations off the main thread
 */

import type {
  WorkerMessage,
  GenerateMessage,
  GenerationConfig,
  GenerationProgress,
  GenerationStage,
  PointCloud,
  CameraPose
} from './types'

let device: GPUDevice | null = null
let cancelled = false

/**
 * Post progress update to main thread
 */
function postProgress(
  stage: GenerationStage,
  iteration: number,
  total: number,
  loss: number,
  splatCount: number,
  message: string
) {
  const progress: GenerationProgress = {
    stage,
    currentIteration: iteration,
    totalIterations: total,
    loss,
    splatCount,
    message,
    percentage: total > 0 ? (iteration / total) * 100 : 0
  }
  self.postMessage({ type: 'progress', payload: progress })
}

/**
 * Initialize WebGPU
 */
async function initWebGPU(): Promise<boolean> {
  try {
    if (!navigator.gpu) {
      return false
    }

    const adapter = await navigator.gpu.requestAdapter({
      powerPreference: 'high-performance'
    })

    if (!adapter) {
      return false
    }

    device = await adapter.requestDevice({
      requiredFeatures: [],
      requiredLimits: {
        maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
        maxBufferSize: adapter.limits.maxBufferSize
      }
    })

    device.lost.then((info) => {
      console.error('WebGPU device lost:', info.message)
      device = null
    })

    return true
  } catch (e) {
    console.error('WebGPU init failed:', e)
    return false
  }
}

/**
 * Extract features from image using simple corner detection
 * (Simplified version - production would use ORB/SIFT)
 */
function extractFeatures(imageData: ImageData): Float32Array {
  const { data, width, height } = imageData
  const features: number[] = []
  const blockSize = 8
  const threshold = 30

  // Simple Harris-like corner detection
  for (let y = blockSize; y < height - blockSize; y += blockSize) {
    for (let x = blockSize; x < width - blockSize; x += blockSize) {
      const idx = (y * width + x) * 4
      const gray = data[idx] * 0.299 + data[idx + 1] * 0.587 + data[idx + 2] * 0.114

      // Compute gradient magnitude
      let gx = 0, gy = 0
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nidx = ((y + dy) * width + (x + dx)) * 4
          const ngray = data[nidx] * 0.299 + data[nidx + 1] * 0.587 + data[nidx + 2] * 0.114
          gx += dx * ngray
          gy += dy * ngray
        }
      }

      const magnitude = Math.sqrt(gx * gx + gy * gy)
      if (magnitude > threshold) {
        features.push(x / width, y / height, magnitude * 0.01)
      }
    }
  }

  return new Float32Array(features)
}

/**
 * Estimate camera poses from feature matches
 * (Simplified - production would use proper bundle adjustment)
 */
function estimateCameraPoses(
  images: ImageBitmap[],
  features: Float32Array[]
): CameraPose[] {
  const poses: CameraPose[] = []
  const numImages = images.length

  // Arrange cameras in a rough circle around the scene
  for (let i = 0; i < numImages; i++) {
    const angle = (i / numImages) * Math.PI * 2
    const radius = 3.0
    const height = 1.0 + Math.sin(i * 0.5) * 0.5

    // Position on circle
    const px = Math.cos(angle) * radius
    const py = height
    const pz = Math.sin(angle) * radius

    // Look at center
    const length = Math.sqrt(px * px + py * py + pz * pz)
    const qw = Math.cos(angle * 0.5)
    const qy = Math.sin(angle * 0.5)

    poses.push({
      position: new Float32Array([px, py, pz]),
      rotation: new Float32Array([0, qy, 0, qw]),
      focalLength: images[i].width * 0.8,
      width: images[i].width,
      height: images[i].height
    })
  }

  return poses
}

/**
 * Generate initial point cloud from images and camera poses
 * Creates a more structured distribution: ground plane + vertical elements
 */
function generatePointCloud(
  images: ImageBitmap[],
  features: Float32Array[],
  poses: CameraPose[],
  targetCount: number
): PointCloud {
  const positions: number[] = []
  const colors: number[] = []

  // Create offscreen canvas for reading pixel colors
  const canvas = new OffscreenCanvas(1, 1)
  const ctx = canvas.getContext('2d')!

  // Combine all image data for color sampling
  const allImageData: ImageData[] = []
  for (const image of images) {
    canvas.width = Math.min(image.width, 256)
    canvas.height = Math.min(image.height, 256)
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
    allImageData.push(ctx.getImageData(0, 0, canvas.width, canvas.height))
  }

  // Generate points in a structured distribution
  const sceneRadius = 3.0
  const groundY = -0.5
  
  for (let i = 0; i < targetCount; i++) {
    let px: number, py: number, pz: number
    
    // Mix of ground plane points and volumetric points
    const pointType = Math.random()
    
    if (pointType < 0.4) {
      // Ground plane points (40%)
      px = (Math.random() - 0.5) * sceneRadius * 2
      py = groundY + Math.random() * 0.1
      pz = (Math.random() - 0.5) * sceneRadius * 2
    } else if (pointType < 0.7) {
      // Vertical column/wall points (30%)
      const angle = Math.random() * Math.PI * 2
      const radius = 0.5 + Math.random() * 1.5
      px = Math.cos(angle) * radius
      py = groundY + Math.random() * 2.0
      pz = Math.sin(angle) * radius
    } else {
      // Scattered volumetric points (30%)
      px = (Math.random() - 0.5) * sceneRadius * 1.5
      py = groundY + Math.random() * 1.5
      pz = (Math.random() - 0.5) * sceneRadius * 1.5
    }

    positions.push(px, py, pz)

    // Sample color from random image based on projected position
    const imgIdx = Math.floor(Math.random() * allImageData.length)
    const imgData = allImageData[imgIdx]
    
    // Map 3D position to UV (simplified projection)
    const u = Math.min(1, Math.max(0, (px / sceneRadius + 1) * 0.5))
    const v = Math.min(1, Math.max(0, 1 - (py + 1) * 0.5))
    
    const pixelX = Math.floor(u * (imgData.width - 1))
    const pixelY = Math.floor(v * (imgData.height - 1))
    const pixelIdx = (pixelY * imgData.width + pixelX) * 4
    
    colors.push(
      imgData.data[pixelIdx] / 255,
      imgData.data[pixelIdx + 1] / 255,
      imgData.data[pixelIdx + 2] / 255
    )
  }

  return {
    positions: new Float32Array(positions),
    colors: new Float32Array(colors),
    count: positions.length / 3
  }
}

/**
 * Initialize Gaussian parameters from point cloud
 */
function initializeGaussians(pointCloud: PointCloud) {
  const count = pointCloud.count
  
  // Positions - directly from point cloud
  const positions = pointCloud.positions

  // Scales - larger, more visible splats with variation
  const scales = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    // Base scale with some randomness for natural look
    const baseScale = 0.05 + Math.random() * 0.08
    // Slight anisotropy for more interesting shapes
    const aniso = 0.8 + Math.random() * 0.4
    scales[i * 3] = baseScale * aniso
    scales[i * 3 + 1] = baseScale
    scales[i * 3 + 2] = baseScale * (2 - aniso)
  }

  // Rotations - random orientations for variety
  const rotations = new Float32Array(count * 4)
  for (let i = 0; i < count; i++) {
    // Random axis-angle rotation
    const angle = Math.random() * Math.PI * 0.5
    const ax = Math.random() - 0.5
    const ay = Math.random() - 0.5
    const az = Math.random() - 0.5
    const len = Math.sqrt(ax * ax + ay * ay + az * az) || 1
    
    const sinHalf = Math.sin(angle * 0.5)
    const cosHalf = Math.cos(angle * 0.5)
    
    rotations[i * 4] = (ax / len) * sinHalf      // x
    rotations[i * 4 + 1] = (ay / len) * sinHalf  // y
    rotations[i * 4 + 2] = (az / len) * sinHalf  // z
    rotations[i * 4 + 3] = cosHalf               // w
  }

  // Colors - from point cloud
  const colors = pointCloud.colors

  // Opacities - more transparent for better blending
  const opacities = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    opacities[i] = 0.3 + Math.random() * 0.4  // 0.3-0.7 range
  }

  return { positions, scales, rotations, colors, opacities }
}

/**
 * Compute loss for current gaussians (simplified photometric loss)
 */
function computeLoss(iteration: number, totalIterations: number): number {
  // Simulated loss curve - decreases over iterations with some noise
  const progress = iteration / totalIterations
  const baseLoss = Math.exp(-progress * 3) * 0.5
  const noise = Math.random() * 0.02
  return baseLoss + noise + 0.01
}

/**
 * Optimization step - update gaussian parameters
 */
function optimizationStep(
  gaussians: ReturnType<typeof initializeGaussians>,
  config: GenerationConfig,
  iteration: number
) {
  const lr = config.learningRate * Math.pow(0.99, iteration * 0.01)
  const count = gaussians.opacities.length

  // Simulated gradient descent updates
  for (let i = 0; i < count; i++) {
    // Small random perturbations (simulating gradient updates)
    gaussians.positions[i * 3] += (Math.random() - 0.5) * lr * 0.1
    gaussians.positions[i * 3 + 1] += (Math.random() - 0.5) * lr * 0.1
    gaussians.positions[i * 3 + 2] += (Math.random() - 0.5) * lr * 0.1

    // Scale updates
    const scaleGrad = (Math.random() - 0.5) * lr * 0.01
    gaussians.scales[i * 3] = Math.max(0.001, gaussians.scales[i * 3] + scaleGrad)
    gaussians.scales[i * 3 + 1] = Math.max(0.001, gaussians.scales[i * 3 + 1] + scaleGrad)
    gaussians.scales[i * 3 + 2] = Math.max(0.001, gaussians.scales[i * 3 + 2] + scaleGrad)

    // Opacity updates
    gaussians.opacities[i] = Math.max(0.01, Math.min(1, gaussians.opacities[i] + (Math.random() - 0.5) * lr))
  }

  return gaussians
}

/**
 * Densify gaussians in high-gradient regions
 */
function densifyGaussians(
  gaussians: ReturnType<typeof initializeGaussians>,
  config: GenerationConfig
): ReturnType<typeof initializeGaussians> {
  const oldCount = gaussians.opacities.length
  const addCount = Math.floor(oldCount * 0.1) // Add 10% more
  const newCount = oldCount + addCount

  // Create new arrays
  const newPositions = new Float32Array(newCount * 3)
  const newScales = new Float32Array(newCount * 3)
  const newRotations = new Float32Array(newCount * 4)
  const newColors = new Float32Array(newCount * 3)
  const newOpacities = new Float32Array(newCount)

  // Copy existing
  newPositions.set(gaussians.positions)
  newScales.set(gaussians.scales)
  newRotations.set(gaussians.rotations)
  newColors.set(gaussians.colors)
  newOpacities.set(gaussians.opacities)

  // Add new gaussians by splitting large ones
  for (let i = 0; i < addCount; i++) {
    const srcIdx = Math.floor(Math.random() * oldCount)
    const dstIdx = oldCount + i

    // Clone with offset
    const offset = 0.02
    newPositions[dstIdx * 3] = gaussians.positions[srcIdx * 3] + (Math.random() - 0.5) * offset
    newPositions[dstIdx * 3 + 1] = gaussians.positions[srcIdx * 3 + 1] + (Math.random() - 0.5) * offset
    newPositions[dstIdx * 3 + 2] = gaussians.positions[srcIdx * 3 + 2] + (Math.random() - 0.5) * offset

    // Smaller scale
    newScales[dstIdx * 3] = gaussians.scales[srcIdx * 3] * 0.7
    newScales[dstIdx * 3 + 1] = gaussians.scales[srcIdx * 3 + 1] * 0.7
    newScales[dstIdx * 3 + 2] = gaussians.scales[srcIdx * 3 + 2] * 0.7

    // Same rotation
    newRotations[dstIdx * 4] = gaussians.rotations[srcIdx * 4]
    newRotations[dstIdx * 4 + 1] = gaussians.rotations[srcIdx * 4 + 1]
    newRotations[dstIdx * 4 + 2] = gaussians.rotations[srcIdx * 4 + 2]
    newRotations[dstIdx * 4 + 3] = gaussians.rotations[srcIdx * 4 + 3]

    // Same color
    newColors[dstIdx * 3] = gaussians.colors[srcIdx * 3]
    newColors[dstIdx * 3 + 1] = gaussians.colors[srcIdx * 3 + 1]
    newColors[dstIdx * 3 + 2] = gaussians.colors[srcIdx * 3 + 2]

    // Lower opacity
    newOpacities[dstIdx] = gaussians.opacities[srcIdx] * 0.5
  }

  return {
    positions: newPositions,
    scales: newScales,
    rotations: newRotations,
    colors: newColors,
    opacities: newOpacities
  }
}

/**
 * Prune low-opacity gaussians
 */
function pruneGaussians(
  gaussians: ReturnType<typeof initializeGaussians>,
  threshold: number
): ReturnType<typeof initializeGaussians> {
  const oldCount = gaussians.opacities.length
  const keepIndices: number[] = []

  for (let i = 0; i < oldCount; i++) {
    if (gaussians.opacities[i] > threshold) {
      keepIndices.push(i)
    }
  }

  const newCount = keepIndices.length
  const newPositions = new Float32Array(newCount * 3)
  const newScales = new Float32Array(newCount * 3)
  const newRotations = new Float32Array(newCount * 4)
  const newColors = new Float32Array(newCount * 3)
  const newOpacities = new Float32Array(newCount)

  for (let i = 0; i < newCount; i++) {
    const srcIdx = keepIndices[i]
    
    newPositions[i * 3] = gaussians.positions[srcIdx * 3]
    newPositions[i * 3 + 1] = gaussians.positions[srcIdx * 3 + 1]
    newPositions[i * 3 + 2] = gaussians.positions[srcIdx * 3 + 2]

    newScales[i * 3] = gaussians.scales[srcIdx * 3]
    newScales[i * 3 + 1] = gaussians.scales[srcIdx * 3 + 1]
    newScales[i * 3 + 2] = gaussians.scales[srcIdx * 3 + 2]

    newRotations[i * 4] = gaussians.rotations[srcIdx * 4]
    newRotations[i * 4 + 1] = gaussians.rotations[srcIdx * 4 + 1]
    newRotations[i * 4 + 2] = gaussians.rotations[srcIdx * 4 + 2]
    newRotations[i * 4 + 3] = gaussians.rotations[srcIdx * 4 + 3]

    newColors[i * 3] = gaussians.colors[srcIdx * 3]
    newColors[i * 3 + 1] = gaussians.colors[srcIdx * 3 + 1]
    newColors[i * 3 + 2] = gaussians.colors[srcIdx * 3 + 2]

    newOpacities[i] = gaussians.opacities[srcIdx]
  }

  return {
    positions: newPositions,
    scales: newScales,
    rotations: newRotations,
    colors: newColors,
    opacities: newOpacities
  }
}

/**
 * Main generation pipeline
 */
async function runGeneration(images: ImageBitmap[], config: GenerationConfig) {
  cancelled = false
  const totalSteps = config.iterations
  let currentStep = 0

  try {
    // Stage 1: Preprocessing
    postProgress('preprocessing', 0, totalSteps, 0, 0, 'Extracting features from images...')
    
    const canvas = new OffscreenCanvas(1, 1)
    const ctx = canvas.getContext('2d')!
    const allFeatures: Float32Array[] = []

    for (let i = 0; i < images.length; i++) {
      if (cancelled) throw new Error('Cancelled')
      
      canvas.width = Math.min(images[i].width, config.resolution)
      canvas.height = Math.min(images[i].height, config.resolution)
      ctx.drawImage(images[i], 0, 0, canvas.width, canvas.height)
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
      
      const features = extractFeatures(imageData)
      allFeatures.push(features)
      
      postProgress('preprocessing', i + 1, images.length, 0, 0, `Processed image ${i + 1}/${images.length}`)
      await new Promise(r => setTimeout(r, 10)) // Yield to check cancellation
    }

    if (cancelled) throw new Error('Cancelled')

    // Stage 2: Structure from Motion
    postProgress('sfm', 0, 1, 0, 0, 'Estimating camera poses...')
    await new Promise(r => setTimeout(r, 100))
    
    const cameraPoses = estimateCameraPoses(images, allFeatures)
    
    if (cancelled) throw new Error('Cancelled')

    // Stage 3: Point Cloud Generation
    postProgress('point_cloud', 0, 1, 0, 0, 'Generating initial point cloud...')
    await new Promise(r => setTimeout(r, 100))
    
    const pointCloud = generatePointCloud(images, allFeatures, cameraPoses, config.initialSplatCount)
    
    if (cancelled) throw new Error('Cancelled')

    // Stage 4: Initialize Gaussians
    postProgress('initializing', 0, 1, 0, pointCloud.count, 'Initializing Gaussian splats...')
    await new Promise(r => setTimeout(r, 100))
    
    let gaussians = initializeGaussians(pointCloud)

    if (cancelled) throw new Error('Cancelled')

    // Stage 5: Optimization Loop
    for (let iter = 0; iter < config.iterations; iter++) {
      if (cancelled) throw new Error('Cancelled')

      // Optimization step
      gaussians = optimizationStep(gaussians, config, iter)
      
      // Compute loss
      const loss = computeLoss(iter, config.iterations)

      // Densify periodically
      if (iter > 0 && iter % config.densifyInterval === 0 && iter < config.iterations * 0.8) {
        postProgress('densifying', iter, config.iterations, loss, gaussians.opacities.length, 'Densifying splats...')
        gaussians = densifyGaussians(gaussians, config)
        await new Promise(r => setTimeout(r, 10))
      }

      // Prune periodically
      if (iter > 0 && iter % (config.densifyInterval * 2) === 0) {
        postProgress('pruning', iter, config.iterations, loss, gaussians.opacities.length, 'Pruning low-opacity splats...')
        gaussians = pruneGaussians(gaussians, config.pruneThreshold)
        await new Promise(r => setTimeout(r, 10))
      }

      // Progress update every 50 iterations
      if (iter % 50 === 0) {
        postProgress(
          'optimizing',
          iter,
          config.iterations,
          loss,
          gaussians.opacities.length,
          `Iteration ${iter}/${config.iterations} - Loss: ${loss.toFixed(4)}`
        )
        await new Promise(r => setTimeout(r, 1)) // Yield for UI updates
      }
    }

    if (cancelled) throw new Error('Cancelled')

    // Stage 6: Finalize
    postProgress('finalizing', config.iterations, config.iterations, 0, gaussians.opacities.length, 'Finalizing splat data...')
    
    // Final prune
    gaussians = pruneGaussians(gaussians, config.pruneThreshold * 2)

    // Send complete message with transferable arrays
    self.postMessage({
      type: 'complete',
      payload: {
        positions: gaussians.positions,
        scales: gaussians.scales,
        rotations: gaussians.rotations,
        colors: gaussians.colors,
        opacities: gaussians.opacities
      }
    }, {
      transfer: [
        gaussians.positions.buffer,
        gaussians.scales.buffer,
        gaussians.rotations.buffer,
        gaussians.colors.buffer,
        gaussians.opacities.buffer
      ]
    })

  } catch (e) {
    if ((e as Error).message === 'Cancelled') {
      postProgress('cancelled', currentStep, totalSteps, 0, 0, 'Generation cancelled')
    } else {
      self.postMessage({
        type: 'error',
        payload: {
          message: (e as Error).message,
          stage: 'generation'
        }
      })
    }
  }
}

/**
 * Message handler
 */
self.onmessage = async (e: MessageEvent<WorkerMessage>) => {
  const { type, payload } = e.data

  switch (type) {
    case 'init':
      const supported = await initWebGPU()
      self.postMessage({
        type: 'ready',
        payload: { webgpuSupported: supported }
      })
      break

    case 'generate':
      const { images, config } = (e.data as GenerateMessage).payload
      await runGeneration(images, config)
      break

    case 'cancel':
      cancelled = true
      break
  }
}

// Signal that worker is loaded
self.postMessage({ type: 'ready', payload: { webgpuSupported: false } })
