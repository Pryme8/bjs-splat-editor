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
import { registerProcess } from './processTracker.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const SCRIPT_PATH = path.join(__dirname, '../../scripts/superpoint_lightglue.py')

export type MatchStrategy = 'exhaustive' | 'window' | 'retrieval'

export interface LearnedFeaturesConfig {
  maxKeypoints?: number        // Max keypoints per image (default: 2048)
  maxImageSize?: number        // Resize images larger than this (default: 1600)
  sequentialMatching?: boolean // (Legacy) Use sequential matching - maps to window strategy
  matchStrategy?: MatchStrategy // Pair selection strategy (default: 'window')
  matchWindow?: number         // Window size for 'window' strategy (default: 10)
  matchTopk?: number           // Top-k for 'retrieval' strategy (default: 15)
  skipVerification?: boolean   // Skip per-pair RANSAC (default: false, COLMAP mapper needs two_view_geometries)
  jobId?: string              // Job ID for process tracking
  onProgress?: (
    message: string, 
    phase: 'features' | 'matching', 
    current: number, 
    total: number,
    deviceInfo?: { deviceType?: 'gpu' | 'cpu', deviceName?: string }
  ) => void
}

export interface LearnedFeaturesResult {
  images: number
  match_strategy?: string
  total_pairs?: number
  pairs_matched: number
  total_matches: number
  avg_keypoints_per_image: number
  avg_matches_per_pair: number
  database: string
  // Geometric verification stats
  verified_pairs?: number
  total_inliers?: number
  avg_inliers_per_pair?: number
  // Device info
  device_type?: 'gpu' | 'cpu'
  device_name?: string
  // EXIF camera info
  exif_count?: number
  camera_make?: string
  camera_model?: string
  focal_mm?: number
  focal_pixels?: number
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
 * Extract features and compute matches using DISK + LightGlue
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
    maxKeypoints = 4096,
    maxImageSize = 1600,
    sequentialMatching = false,
    matchStrategy,
    matchWindow = 10,
    matchTopk = 15,
    skipVerification = false,
    jobId,
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
    
    // Match strategy: new args take priority over legacy --sequential
    if (matchStrategy) {
      args.push('--match_strategy', matchStrategy)
      if (matchStrategy === 'window') {
        args.push('--match_window', matchWindow.toString())
      } else if (matchStrategy === 'retrieval') {
        args.push('--match_topk', matchTopk.toString())
      }
    } else if (sequentialMatching) {
      args.push('--sequential')
    }
    
    // Verification control
    if (skipVerification) {
      args.push('--skip_verification')
    } else {
      args.push('--verify')
    }

    console.log(`[LearnedFeatures] Running: python -u ${args.join(' ')}`)

    // Use -u flag for unbuffered output so tqdm progress shows in real-time
    const proc = spawn('python', ['-u', ...args], {
      stdio: ['pipe', 'pipe', 'pipe']
    })
    
    // Register process for cleanup on job cancellation
    if (jobId) {
      registerProcess(jobId, proc)
    }

    let stdout = ''
    let stderr = ''
    let deviceInfo: { deviceType?: 'gpu' | 'cpu', deviceName?: string } = {}

    proc.stdout.on('data', (data) => {
      stdout += data.toString()
    })

    proc.stderr.on('data', (data) => {
      const text = data.toString()
      stderr += text
      
      // Log ALL stderr output to console (will be broadcast to clients)
      // Split by lines and log each non-empty line
      for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (trimmed) {
          // Always log to console for streaming to frontend
          console.log(`[LearnedFeatures] ${trimmed}`)
          
          // Capture device info from stderr
          if (trimmed.includes('Using CUDA GPU:')) {
            deviceInfo.deviceType = 'gpu'
            const match = trimmed.match(/Using CUDA GPU:\s*(.+)/)
            if (match) deviceInfo.deviceName = match[1].trim()
          } else if (trimmed.includes('Using Apple Metal GPU')) {
            deviceInfo.deviceType = 'gpu'
            deviceInfo.deviceName = 'Apple Metal'
          } else if (trimmed.includes('Using CPU')) {
            deviceInfo.deviceType = 'cpu'
            deviceInfo.deviceName = 'CPU'
          }
        }
      }
      
      // Parse tqdm progress: "Features:  50%|#####     | 12/25"
      // or "Matching:  50%|#####     | 150/300"
      // tqdm uses \r to overwrite the line, so a single chunk may contain
      // multiple progress updates - we need the LAST one (most recent)
      const progressRegex = /(Features|Matching):\s*(\d+)%\|[^|]+\|\s*(\d+)\/(\d+)/g
      let progressMatch: RegExpExecArray | null = null
      let lastMatch: RegExpExecArray | null = null
      while ((progressMatch = progressRegex.exec(text)) !== null) {
        lastMatch = progressMatch
      }
      if (lastMatch && onProgress) {
        const phase = lastMatch[1].toLowerCase() as 'features' | 'matching'
        const current = parseInt(lastMatch[3])
        const total = parseInt(lastMatch[4])
        const message = `${lastMatch[1]}: ${current}/${total}`
        onProgress(message, phase, current, total, deviceInfo)
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
