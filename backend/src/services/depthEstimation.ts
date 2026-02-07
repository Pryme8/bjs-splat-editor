/**
 * Depth Estimation Service
 * 
 * Uses Depth Anything V2 to generate depth maps for images.
 * These depth maps can be used for:
 * - Floater detection and removal
 * - Ground plane detection
 * - Depth-supervised training
 */

import { spawn } from 'child_process'
import path from 'path'
import fs from 'fs/promises'
import { fileURLToPath } from 'url'
import { registerProcess } from './processTracker.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Path to Python script
const DEPTH_SCRIPT = path.resolve(__dirname, '../../scripts/depth_anything.py')

export type DepthModelSize = 'small' | 'base' | 'large'

export interface DepthEstimationConfig {
  modelSize?: DepthModelSize
  saveVisualization?: boolean
}

export interface DepthResult {
  source: string
  output_file?: string
  width?: number
  height?: number
  depth_min?: number
  depth_max?: number
  error?: string
}

export interface DepthSummary {
  model: string
  total_images: number
  successful: number
  images: DepthResult[]
  device_type?: 'gpu' | 'cpu'
  device_name?: string
}

/**
 * Check if Python and required packages are available
 */
export async function checkDepthEstimationAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('python', ['--version'])
    
    proc.on('close', async (code) => {
      if (code !== 0) {
        console.log('[DepthEstimation] Python not found')
        resolve(false)
        return
      }
      
      // Check if script exists
      try {
        await fs.access(DEPTH_SCRIPT)
        console.log('[DepthEstimation] Available')
        resolve(true)
      } catch {
        console.log('[DepthEstimation] Script not found:', DEPTH_SCRIPT)
        resolve(false)
      }
    })
    
    proc.on('error', () => {
      resolve(false)
    })
  })
}

/**
 * Check if required Python packages are installed
 */
export async function checkDepthDependencies(): Promise<{ installed: boolean; missing: string[] }> {
  const requiredPackages = ['torch', 'transformers', 'PIL', 'numpy']
  const missing: string[] = []
  
  for (const pkg of requiredPackages) {
    const installed = await checkPythonPackage(pkg)
    if (!installed) {
      missing.push(pkg)
    }
  }
  
  return {
    installed: missing.length === 0,
    missing
  }
}

async function checkPythonPackage(packageName: string): Promise<boolean> {
  return new Promise((resolve) => {
    const importName = packageName === 'PIL' ? 'PIL' : packageName
    const proc = spawn('python', ['-c', `import ${importName}`])
    
    proc.on('close', (code) => {
      resolve(code === 0)
    })
    
    proc.on('error', () => {
      resolve(false)
    })
  })
}

/**
 * Run depth estimation on a directory of images
 */
export async function estimateDepth(
  inputDir: string,
  outputDir: string,
  config: DepthEstimationConfig = {},
  onOutput?: (line: string, deviceInfo?: { deviceType?: 'gpu' | 'cpu', deviceName?: string }) => void,
  jobId?: string
): Promise<DepthSummary> {
  const {
    modelSize = 'small',
    saveVisualization = true
  } = config
  
  // Ensure output directory exists
  await fs.mkdir(outputDir, { recursive: true })
  
  return new Promise((resolve, reject) => {
    const args = [
      DEPTH_SCRIPT,
      '--input_dir', inputDir,
      '--output_dir', outputDir,
      '--model', modelSize,
      '--json'
    ]
    
    if (!saveVisualization) {
      args.push('--no-vis')
    }
    
    console.log(`[DepthEstimation] Running: python ${args.join(' ')}`)
    
    const proc = spawn('python', args, {
      cwd: path.dirname(DEPTH_SCRIPT)
    })
    
    // Register process for cleanup on job cancellation
    if (jobId) {
      registerProcess(jobId, proc)
    }
    
    let stdout = ''
    let stderr = ''
    let deviceInfo: { deviceType?: 'gpu' | 'cpu', deviceName?: string } = {}
    
    proc.stdout.on('data', (data) => {
      const text = data.toString()
      stdout += text
      
      // Parse progress lines for callback
      const lines = text.split('\n').filter((l: string) => l.trim())
      for (const line of lines) {
        if (onOutput) {
          onOutput(line)
        }
      }
    })
    
    proc.stderr.on('data', (data) => {
      const text = data.toString()
      stderr += text
      
      // Capture device info from stderr
      const lines = text.split('\n')
      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed.includes('Using CUDA GPU:')) {
          deviceInfo.deviceType = 'gpu'
          const match = trimmed.match(/Using CUDA GPU:\s*(.+)/)
          if (match) deviceInfo.deviceName = match[1].trim()
          console.log(`[DepthEstimation] Device detected: ${deviceInfo.deviceType} - ${deviceInfo.deviceName}`)
          // Send device info immediately via callback
          if (onOutput) onOutput('Device detected', deviceInfo)
        } else if (trimmed.includes('Using Apple Metal GPU')) {
          deviceInfo.deviceType = 'gpu'
          deviceInfo.deviceName = 'Apple Metal'
          console.log(`[DepthEstimation] Device detected: ${deviceInfo.deviceType} - ${deviceInfo.deviceName}`)
          // Send device info immediately via callback
          if (onOutput) onOutput('Device detected', deviceInfo)
        } else if (trimmed.includes('Using CPU')) {
          deviceInfo.deviceType = 'cpu'
          deviceInfo.deviceName = 'CPU'
          console.log(`[DepthEstimation] Device detected: ${deviceInfo.deviceType} - ${deviceInfo.deviceName}`)
          // Send device info immediately via callback
          if (onOutput) onOutput('Device detected', deviceInfo)
        }
      }
      
      // Forward progress messages (tqdm writes to stderr)
      if (onOutput && (text.includes('%') || text.includes('Estimating'))) {
        onOutput(text.trim(), deviceInfo)
      }
    })
    
    proc.on('close', (code) => {
      if (code !== 0) {
        console.error(`[DepthEstimation] Process exited with code ${code}`)
        console.error(`[DepthEstimation] stderr: ${stderr}`)
        reject(new Error(`Depth estimation failed: ${stderr || 'Unknown error'}`))
        return
      }
      
      try {
        // Parse JSON output from last line of stdout
        const lines = stdout.trim().split('\n')
        const jsonLine = lines[lines.length - 1]
        const summary = JSON.parse(jsonLine) as DepthSummary
        
        // Add device info if not already in summary
        if (!summary.device_type && deviceInfo.deviceType) {
          summary.device_type = deviceInfo.deviceType
          summary.device_name = deviceInfo.deviceName
        }
        
        console.log(`[DepthEstimation] Completed: ${summary.successful}/${summary.total_images} images`)
        console.log(`[DepthEstimation] Device: ${summary.device_type} - ${summary.device_name}`)
        resolve(summary)
      } catch (e) {
        // Try reading summary file
        const summaryPath = path.join(outputDir, 'depth_summary.json')
        fs.readFile(summaryPath, 'utf-8')
          .then((content) => {
            const summary = JSON.parse(content) as DepthSummary
            resolve(summary)
          })
          .catch(() => {
            reject(new Error(`Failed to parse depth estimation results: ${e}`))
          })
      }
    })
    
    proc.on('error', (err) => {
      reject(new Error(`Failed to start depth estimation: ${err.message}`))
    })
  })
}

/**
 * Load a depth map from a 16-bit PNG file
 * Returns normalized float values (0-1)
 */
export async function loadDepthMap(depthPath: string): Promise<Float32Array> {
  // We'll use sharp to read the 16-bit PNG
  const sharp = (await import('sharp')).default
  
  const { data, info } = await sharp(depthPath)
    .raw()
    .toBuffer({ resolveWithObject: true })
  
  const pixels = info.width * info.height
  const depth = new Float32Array(pixels)
  
  // 16-bit images have 2 bytes per pixel
  if (info.channels === 1 && data.length === pixels * 2) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    for (let i = 0; i < pixels; i++) {
      // Read as little-endian 16-bit unsigned
      depth[i] = view.getUint16(i * 2, true) / 65535.0
    }
  } else {
    // Fallback for 8-bit images
    for (let i = 0; i < Math.min(data.length, pixels); i++) {
      depth[i] = data[i] / 255.0
    }
  }
  
  return depth
}

/**
 * Get depth value at a specific pixel coordinate
 */
export function getDepthAt(
  depthMap: Float32Array,
  width: number,
  x: number,
  y: number
): number {
  const idx = Math.floor(y) * width + Math.floor(x)
  if (idx < 0 || idx >= depthMap.length) {
    return 0
  }
  return depthMap[idx]
}

export default {
  checkDepthEstimationAvailable,
  checkDepthDependencies,
  estimateDepth,
  loadDepthMap,
  getDepthAt
}
