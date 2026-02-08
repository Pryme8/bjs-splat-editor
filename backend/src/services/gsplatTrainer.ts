/**
 * gsplat Trainer Service - Python-based 3D Gaussian Splatting
 * 
 * Uses the `gaussian-splatting` PyPI package which leverages PyTorch directly.
 * This means it uses whatever CUDA version PyTorch is built with, providing
 * native GPU support without needing a separately compiled binary.
 * 
 * Requires: pip install gaussian-splatting
 * CUDA Toolkit must match PyTorch CUDA version for source builds on newer GPUs.
 */

import { spawn } from 'child_process'
import path from 'path'
import fs from 'fs/promises'
import type { ColmapResult, JobConfig, TrainingResult, JobProgress } from '../types/index.js'
import { registerProcess } from './processTracker.js'

interface GsplatOptions {
  jobId: string
  imagesDir: string
  outputDir: string
  colmapData: ColmapResult | null
  config: JobConfig
  onProgress: (progress: Partial<JobProgress>) => void
}

/**
 * Check if gaussian-splatting Python package is available
 */
export async function checkGsplatAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('python', ['-c', 'import gaussian_splatting; print("ok")'], {
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
 * Get gsplat version info
 */
export async function getGsplatVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn('python', ['-c', 'import gaussian_splatting; print(getattr(gaussian_splatting, "__version__", "unknown"))'], {
      stdio: ['pipe', 'pipe', 'pipe']
    })

    let output = ''
    proc.stdout.on('data', (data) => { output += data.toString() })

    proc.on('close', (code) => {
      resolve(code === 0 ? output.trim() : null)
    })

    proc.on('error', () => resolve(null))
  })
}

/**
 * Find the latest intermediate PLY checkpoint from gsplat output
 * gsplat saves to: point_cloud/iteration_<N>/point_cloud.ply
 */
export async function findLatestGsplatIntermediate(outputDir: string): Promise<string | null> {
  try {
    const pcDir = path.join(outputDir, 'point_cloud')
    const dirs = await fs.readdir(pcDir)
    const iterDirs = dirs
      .filter(d => d.match(/^iteration_\d+$/))
      .map(d => {
        const match = d.match(/^iteration_(\d+)$/)
        return { name: d, iteration: match ? parseInt(match[1]) : 0 }
      })
      .sort((a, b) => b.iteration - a.iteration)

    if (iterDirs.length > 0) {
      const plyPath = path.join(pcDir, iterDirs[0].name, 'point_cloud.ply')
      try {
        await fs.access(plyPath)
        return plyPath
      } catch {
        // File doesn't exist yet
      }
    }
  } catch {
    // Directory might not exist yet
  }
  return null
}

/**
 * Train using gaussian-splatting Python package
 * 
 * gaussian-splatting expects a COLMAP project directory structure:
 * - images/ (input images)
 * - sparse/0/ (COLMAP sparse reconstruction with cameras.bin, images.bin, points3D.bin)
 * 
 * Command: python -m gaussian_splatting.train -s <source> -d <output> -i <iterations> --mode densify
 */
export async function trainWithGsplat(
  options: GsplatOptions
): Promise<TrainingResult> {
  const { jobId, imagesDir, outputDir, colmapData, config, onProgress } = options

  if (!colmapData) {
    throw new Error('gsplat requires COLMAP data. Run COLMAP first to get camera poses.')
  }

  // Verify gsplat is available
  const available = await checkGsplatAvailable()
  if (!available) {
    throw new Error(
      'gaussian-splatting Python package not found or failed to import.\n' +
      'Install with: pip install gaussian-splatting\n' +
      'Note: RTX 50xx GPUs require CUDA Toolkit 12.8+ installed for source build.'
    )
  }

  onProgress({
    progress: 80,
    message: 'Starting gsplat training (Python/PyTorch)...'
  })

  // gsplat expects the COLMAP project root (parent of sparse/)
  const colmapProjectDir = outputDir
  const gsplatOutputDir = path.join(outputDir, 'gsplat_output')

  await fs.mkdir(gsplatOutputDir, { recursive: true })

  // Build command arguments
  const iterations = config.iterations || 15000
  const saveEvery = 500

  const args = [
    '-u',  // Unbuffered output for real-time progress
    '-m', 'gaussian_splatting.train',
    '-s', colmapProjectDir,
    '-d', gsplatOutputDir,
    '-i', iterations.toString(),
    '--mode', 'densify'
  ]

  // Add SH degree if specified
  if (config.shDegree !== undefined) {
    args.push('--sh-degree', config.shDegree.toString())
  }

  // Add image path if different from default
  if (imagesDir !== path.join(colmapProjectDir, 'images')) {
    args.push('--images', imagesDir)
  }

  console.log(`[gsplat] Running: python ${args.join(' ')}`)

  // Output files - gsplat puts them in point_cloud/iteration_<N>/point_cloud.ply
  const outputPly = path.join(outputDir, 'result.ply')

  return new Promise((resolve, reject) => {
    const proc = spawn('python', args, {
      cwd: outputDir
    })

    // Register process for cancellation tracking
    registerProcess(jobId, proc)

    let lastProgress = 80
    let splatCount = 0
    let currentIteration = 0
    const totalIterations = iterations
    let lastProgressUpdate = Date.now()
    const PROGRESS_THROTTLE_MS = 500

    // Only keep last N lines for error reporting
    const MAX_OUTPUT_LINES = 100
    const recentOutput: string[] = []

    const parseOutput = (data: string) => {
      const lines = data.toString().split('\n')

      for (const line of lines) {
        if (!line.trim()) continue

        // Always log to console for streaming
        console.log(`[gsplat] ${line.trim()}`)

        // Parse training progress patterns:
        // "Training iteration X/Y" or "Iteration X" or percentage patterns
        const iterMatch = line.match(/(?:Training\s+)?[Ii]teration\s+(\d+)\s*(?:\/\s*(\d+))?/i)
        const stepMatch = line.match(/Step\s+(\d+)/i)
        // gsplat also outputs: "ITER 7000 | Total Loss: 0.1234"
        const gsplatIterMatch = line.match(/ITER\s+(\d+)/i)

        const match = iterMatch || gsplatIterMatch
        if (match) {
          currentIteration = parseInt(match[1])
          const total = match[2] ? parseInt(match[2]) : totalIterations
          const progressPct = 80 + Math.floor((currentIteration / total) * 15)
          lastProgress = progressPct

          const now = Date.now()
          if (now - lastProgressUpdate >= PROGRESS_THROTTLE_MS) {
            lastProgressUpdate = now
            onProgress({
              progress: progressPct,
              message: `Training iteration ${currentIteration}/${total}`,
              iteration: currentIteration,
              totalIterations: total,
              splatCount
            })
          }
        } else if (stepMatch) {
          currentIteration = parseInt(stepMatch[1])
          const progressPct = 80 + Math.floor((currentIteration / totalIterations) * 15)
          lastProgress = progressPct

          const now = Date.now()
          if (now - lastProgressUpdate >= PROGRESS_THROTTLE_MS) {
            lastProgressUpdate = now
            onProgress({
              progress: progressPct,
              message: `Training step ${currentIteration}/${totalIterations}`,
              iteration: currentIteration,
              totalIterations,
              splatCount
            })
          }
        }

        // Parse splat/gaussian count
        const countMatch = line.match(/(?:Number of|total|count|gaussians?)[\s:]+(\d{3,})/i)
        if (countMatch) {
          splatCount = parseInt(countMatch[1])
          onProgress({
            progress: lastProgress,
            splatCount,
            message: `Training... ${splatCount.toLocaleString()} splats`,
            iteration: currentIteration,
            totalIterations
          })
          lastProgressUpdate = Date.now()
        }

        // Detect checkpoint saves
        if (line.includes('Saving') || line.includes('point_cloud.ply') || line.includes('Writing')) {
          const savedMatch = line.match(/iteration_(\d+)/i)
          const savedIteration = savedMatch ? parseInt(savedMatch[1]) : currentIteration

          onProgress({
            progress: lastProgress,
            message: `Saved checkpoint at iteration ${savedIteration}`,
            iteration: savedIteration,
            totalIterations,
            splatCount,
            intermediateReady: true
          } as any)
        }
      }
    }

    proc.stdout.on('data', (data) => {
      const lines = data.toString().split('\n')
      for (const line of lines) {
        if (line.trim()) {
          recentOutput.push(line)
          if (recentOutput.length > MAX_OUTPUT_LINES) {
            recentOutput.shift()
          }
        }
      }
      parseOutput(data.toString())
    })

    proc.stderr.on('data', (data) => {
      const lines = data.toString().split('\n')
      for (const line of lines) {
        if (line.trim()) {
          recentOutput.push(line)
          if (recentOutput.length > MAX_OUTPUT_LINES) {
            recentOutput.shift()
          }
        }
      }
      parseOutput(data.toString())
    })

    proc.on('close', async (code) => {
      console.log(`[gsplat] Process exited with code ${code}`)

      if (code !== 0) {
        console.error(`[gsplat] Recent output:\n${recentOutput.join('\n')}`)
        reject(new Error(`gsplat training exited with code ${code}. Check logs for details.`))
        return
      }

      // Find the final PLY output
      // gsplat saves to: <output>/point_cloud/iteration_<N>/point_cloud.ply
      const finalPlyPath = await findLatestGsplatIntermediate(gsplatOutputDir)

      if (!finalPlyPath) {
        reject(new Error('gsplat did not produce a point cloud output file'))
        return
      }

      // Copy final PLY to expected location
      try {
        await fs.copyFile(finalPlyPath, outputPly)
        console.log(`[gsplat] Copied final PLY from ${finalPlyPath} to ${outputPly}`)
      } catch (e) {
        reject(new Error(`Failed to copy gsplat output: ${e}`))
        return
      }

      // Get file stats for splat count estimate
      if (splatCount === 0) {
        try {
          const stats = await fs.stat(outputPly)
          splatCount = Math.floor(stats.size / 250)
        } catch {
          splatCount = 0
        }
      }

      onProgress({
        progress: 100,
        message: `Training complete! ${splatCount.toLocaleString()} splats generated`,
        splatCount
      })

      resolve({
        plyPath: outputPly,
        splatPath: undefined,
        splatCount,
        trainingTime: 0,
        finalLoss: undefined
      })
    })

    proc.on('error', (err) => {
      console.error(`[gsplat] Process error:`, err)
      reject(new Error(`Failed to run gsplat: ${err.message}`))
    })
  })
}
