/**
 * Learned Feature Matching Service
 * 
 * Uses DISK for feature detection and LightGlue for matching,
 * providing better results than COLMAP's default SIFT features for
 * challenging scenes (low texture, repetitive patterns, etc.)
 */

import { spawn } from 'child_process'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const SCRIPT_PATH = path.join(__dirname, '../../scripts/superpoint_lightglue.py')

export interface LearnedFeaturesConfig {
  maxKeypoints?: number      // Max keypoints per image (default: 2048)
  maxImageSize?: number      // Resize images larger than this (default: 1600)
  sequentialMatching?: boolean // Use sequential instead of exhaustive matching
  onProgress?: (message: string, phase: 'features' | 'matching', current: number, total: number) => void
}

export interface LearnedFeaturesResult {
  images: number
  pairs_matched: number
  total_matches: number
  avg_keypoints_per_image: number
  avg_matches_per_pair: number
  database: string
  // Geometric verification stats (new)
  verified_pairs?: number
  total_inliers?: number
  avg_inliers_per_pair?: number
}

/**
 * Check if learned features dependencies are available
 */
export async function checkLearnedFeaturesAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('python', ['-c', 'import kornia; import cv2; print("ok")'], {
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
 * Extract features and compute matches using SuperPoint + LightGlue
 * 
 * @param imageDir Directory containing input images
 * @param outputDb Path for the output COLMAP database
 * @param config Optional configuration
 * @returns Promise with extraction results
 */
export async function extractLearnedFeatures(
  imageDir: string,
  outputDb: string,
  config: LearnedFeaturesConfig = {}
): Promise<LearnedFeaturesResult> {
  const {
    maxKeypoints = 2048,
    maxImageSize = 1600,
    sequentialMatching = false,
    onProgress
  } = config

  // Ensure output directory exists
  const outputDir = path.dirname(outputDb)
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true })
  }

  return new Promise((resolve, reject) => {
    const args = [
      SCRIPT_PATH,
      '--input_dir', imageDir,
      '--output_db', outputDb,
      '--max_keypoints', maxKeypoints.toString(),
      '--max_image_size', maxImageSize.toString(),
      '--json'
    ]
    
    if (sequentialMatching) {
      args.push('--sequential')
    }

    console.log(`[LearnedFeatures] Running: python ${args.join(' ')}`)

    const proc = spawn('python', args, {
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
      
      // Parse tqdm progress: "Features:  50%|#####     | 12/25"
      // or "Matching:  50%|#####     | 150/300"
      const progressMatch = text.match(/(Features|Matching):\s*(\d+)%\|[^|]+\|\s*(\d+)\/(\d+)/)
      if (progressMatch) {
        const phase = progressMatch[1].toLowerCase() as 'features' | 'matching'
        const current = parseInt(progressMatch[3])
        const total = parseInt(progressMatch[4])
        const message = `${progressMatch[1]}: ${current}/${total}`
        
        if (onProgress) {
          onProgress(message, phase, current, total)
        }
        console.log(`[LearnedFeatures] ${message}`)
      } else if (text.trim() && !text.includes('|')) {
        // Log non-progress messages (loading, warnings, etc.)
        console.log(`[LearnedFeatures] ${text.trim()}`)
      }
    })

    proc.on('close', (code) => {
      if (code === 0) {
        try {
          // Find JSON in output (kornia may print other text to stdout)
          const jsonMatch = stdout.match(/\{[\s\S]*\}/)
          if (!jsonMatch) {
            reject(new Error(`No JSON found in output: ${stdout}`))
            return
          }
          const result = JSON.parse(jsonMatch[0])
          console.log(`[LearnedFeatures] Completed: ${result.images} images, ${result.total_matches} matches`)
          resolve(result)
        } catch (e) {
          reject(new Error(`Failed to parse output: ${stdout}`))
        }
      } else {
        console.error(`[LearnedFeatures] Process exited with code ${code}`)
        console.error(`[LearnedFeatures] stderr: ${stderr}`)
        reject(new Error(`Learned features extraction failed: ${stderr}`))
      }
    })

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn python process: ${err.message}`))
    })
  })
}

/**
 * Check if kornia dependencies need to be installed
 */
export async function checkLearnedFeaturesDependencies(): Promise<{
  available: boolean
  missing: string[]
}> {
  const checks = [
    { name: 'kornia', check: 'import kornia' },
    { name: 'opencv-python', check: 'import cv2' }
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
