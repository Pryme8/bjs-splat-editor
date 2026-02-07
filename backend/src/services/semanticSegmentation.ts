/**
 * Semantic Segmentation Service
 * 
 * Uses Grounding DINO + SAM for text-based object segmentation.
 * Spawns Python process to run inference and returns binary masks.
 */

import { spawn } from 'child_process'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const SCRIPT_PATH = path.join(__dirname, '../../scripts/semantic_segment.py')

export interface SemanticSegmentationConfig {
  boxThreshold?: number     // Detection confidence threshold (default: 0.25)
  textThreshold?: number    // Text matching threshold (default: 0.25)
  onProgress?: (message: string, current: number, total: number) => void
}

export interface MaskInfo {
  filename: string
  width: number
  height: number
  has_detection: boolean
  selected_pixels?: number
  total_pixels?: number
  coverage?: number
  mask_base64?: string
}

export interface SemanticSegmentationResult {
  prompt: string
  images_processed: number
  images_with_detections: number
  masks: MaskInfo[]
}

/**
 * Check if semantic segmentation dependencies are available
 * Uses a fast version check instead of importing heavy model classes
 */
export async function checkSemanticSegmentationAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    // Fast check: just verify transformers is installed with sufficient version
    // Importing the actual model classes takes 15-20 seconds
    const proc = spawn('python', ['-c', `
import sys
try:
    import transformers
    # Check version >= 4.40.0 (has Grounding DINO + SAM support)
    version = tuple(map(int, transformers.__version__.split('.')[:2]))
    if version >= (4, 40):
        print("ok")
    else:
        print("version_too_old")
except ImportError:
    print("not_installed")
`], {
      stdio: ['pipe', 'pipe', 'pipe']
    })
    
    let output = ''
    proc.stdout.on('data', (data) => { output += data.toString() })
    
    proc.on('close', (code) => {
      resolve(code === 0 && output.includes('ok'))
    })
    
    proc.on('error', () => resolve(false))
  })
}

/**
 * Run semantic segmentation on images
 * 
 * @param imageDir Directory containing input images
 * @param prompt Text prompt describing what to segment
 * @param config Optional configuration
 * @returns Promise with segmentation results including base64 masks
 */
export async function runSemanticSegmentation(
  imageDir: string,
  prompt: string,
  config: SemanticSegmentationConfig = {}
): Promise<SemanticSegmentationResult> {
  const {
    boxThreshold = 0.25,
    textThreshold = 0.25,
    onProgress
  } = config

  return new Promise((resolve, reject) => {
    const args = [
      SCRIPT_PATH,
      '--input_dir', imageDir,
      '--prompt', prompt,
      '--box_threshold', boxThreshold.toString(),
      '--text_threshold', textThreshold.toString(),
      '--json'
    ]

    console.log(`[SemanticSegmentation] Running: python -u ${args.join(' ')}`)

    const proc = spawn('python', ['-u', ...args], {
      stdio: ['pipe', 'pipe', 'pipe']
    })

    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (data) => {
      stdout += data.toString()
    })

    proc.stderr.on('data', (data) => {
      const text = data.toString()
      stderr += text
      
      // Log stderr for debugging
      for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (trimmed) {
          console.log(`[SemanticSegmentation] ${trimmed}`)
        }
      }
      
      // Parse tqdm progress: "Segmenting:  50%|#####     | 4/8"
      const progressMatch = text.match(/Segmenting:\s*(\d+)%\|[^|]+\|\s*(\d+)\/(\d+)/)
      if (progressMatch && onProgress) {
        const current = parseInt(progressMatch[2])
        const total = parseInt(progressMatch[3])
        const message = `Segmenting: ${current}/${total}`
        onProgress(message, current, total)
      }
    })

    proc.on('close', (code) => {
      if (code === 0) {
        try {
          // Find JSON in output
          const jsonMatch = stdout.match(/\{[\s\S]*\}/)
          if (!jsonMatch) {
            reject(new Error(`No JSON found in output: ${stdout}`))
            return
          }
          const result = JSON.parse(jsonMatch[0]) as SemanticSegmentationResult
          console.log(`[SemanticSegmentation] Completed: ${result.images_processed} images, ${result.images_with_detections} with detections`)
          resolve(result)
        } catch (e) {
          reject(new Error(`Failed to parse output: ${stdout}`))
        }
      } else {
        console.error(`[SemanticSegmentation] Process exited with code ${code}`)
        console.error(`[SemanticSegmentation] stderr: ${stderr}`)
        reject(new Error(`Semantic segmentation failed: ${stderr}`))
      }
    })

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn python process: ${err.message}`))
    })
  })
}

/**
 * Check if semantic segmentation dependencies need to be installed
 */
export async function checkSemanticSegmentationDependencies(): Promise<{
  available: boolean
  missing: string[]
}> {
  const checks = [
    { name: 'transformers (>=4.40)', check: 'import transformers; print(transformers.__version__)' },
    { name: 'torch', check: 'import torch' },
    { name: 'PIL', check: 'from PIL import Image' }
  ]
  
  const missing: string[] = []
  
  for (const { name, check } of checks) {
    const available = await new Promise<boolean>((resolve) => {
      const proc = spawn('python', ['-c', check], { stdio: ['pipe', 'pipe', 'pipe'] })
      proc.on('close', (code) => resolve(code === 0))
      proc.on('error', () => resolve(false))
    })
    
    if (!available) {
      missing.push(name)
    }
  }
  
  return {
    available: missing.length === 0,
    missing
  }
}
