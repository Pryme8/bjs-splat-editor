/**
 * OpenSplat Service - Production-grade 3D Gaussian Splatting
 * 
 * OpenSplat is a C++ implementation that takes COLMAP output and generates
 * Gaussian splats. It supports CPU and GPU (CUDA, ROCm, Metal) backends.
 */

import { spawn, ChildProcess } from 'child_process'
import path from 'path'
import fs from 'fs/promises'
import type { ColmapResult, JobConfig, TrainingResult, JobProgress } from '../types/index.js'
import { registerProcess } from './processTracker.js'

// Read env var dynamically to ensure dotenv has loaded
function getOpenSplatPath(): string {
  return process.env.OPENSPLAT_PATH || 'opensplat'
}

/**
 * Find the latest intermediate PLY file in a directory
 * OpenSplat saves intermediate files as result_<iteration>.ply
 */
export async function findLatestIntermediate(outputDir: string): Promise<string | null> {
  try {
    const files = await fs.readdir(outputDir)
    const intermediateFiles = files
      .filter(f => f.match(/^result_\d+\.ply$/))
      .map(f => {
        const match = f.match(/^result_(\d+)\.ply$/)
        return { name: f, iteration: match ? parseInt(match[1]) : 0 }
      })
      .sort((a, b) => b.iteration - a.iteration)  // Sort by iteration descending
    
    if (intermediateFiles.length > 0) {
      return path.join(outputDir, intermediateFiles[0].name)
    }
  } catch (e) {
    // Directory might not exist yet
  }
  return null
}

interface OpenSplatOptions {
  jobId: string
  imagesDir: string
  outputDir: string
  colmapData: ColmapResult | null
  config: JobConfig
  onProgress: (progress: Partial<JobProgress>) => void
}

/**
 * Check if OpenSplat is available
 */
export async function checkOpenSplatAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const opensplatPath = getOpenSplatPath()
    const proc = spawn(opensplatPath, ['--help'], {
      shell: true,
      timeout: 5000
    })

    proc.on('close', (code) => {
      // OpenSplat returns 0 for --help
      resolve(code === 0)
    })

    proc.on('error', () => {
      resolve(false)
    })
  })
}

/**
 * Get OpenSplat version
 */
export async function getOpenSplatVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    const opensplatPath = getOpenSplatPath()
    const proc = spawn(opensplatPath, ['--help'], {
      shell: true,
      timeout: 5000
    })

    let output = ''
    proc.stdout.on('data', (data) => {
      output += data.toString()
    })

    proc.on('close', () => {
      // Try to extract version from help output
      const match = output.match(/OpenSplat\s+v?(\d+\.\d+\.\d+)/i)
      resolve(match ? match[1] : 'unknown')
    })

    proc.on('error', () => {
      resolve(null)
    })
  })
}

/**
 * Train using OpenSplat
 * 
 * OpenSplat expects a COLMAP project directory structure:
 * - images/ (the input images)
 * - sparse/0/ (COLMAP sparse reconstruction)
 *   - cameras.bin or cameras.txt
 *   - images.bin or images.txt
 *   - points3D.bin or points3D.txt
 */
export async function trainWithOpenSplat(
  options: OpenSplatOptions
): Promise<TrainingResult> {
  const { jobId, imagesDir, outputDir, colmapData, config, onProgress } = options

  if (!colmapData) {
    throw new Error('OpenSplat requires COLMAP data. Run COLMAP first to get camera poses.')
  }

  // Verify OpenSplat is available
  const available = await checkOpenSplatAvailable()
  if (!available) {
    throw new Error(
      'OpenSplat not found. Please install OpenSplat and set OPENSPLAT_PATH environment variable.\n' +
      'Download from: https://github.com/pierotofy/OpenSplat'
    )
  }

  onProgress({
    progress: 80,
    message: 'Starting OpenSplat training...'
  })

  // OpenSplat expects the COLMAP project root (parent of sparse/)
  // The sparse reconstruction is at colmapData.sparse which is like outputDir/sparse/0
  const colmapProjectDir = outputDir

  // Output files
  const outputPly = path.join(outputDir, 'result.ply')
  const outputSplat = path.join(outputDir, 'result.splat')

  // Build OpenSplat command arguments
  const iterations = config.iterations || 30000  // OpenSplat default
  // Save intermediate results every 10% of iterations for live preview (~10 checkpoints)
  const saveEvery = Math.max(100, Math.floor(iterations * 0.1))
  const args = [
    colmapProjectDir,
    '-n', iterations.toString(),
    '-o', outputPly,
    '--save-every', saveEvery.toString(), // Save intermediate results for live preview
    '--sh-degree', '3',   // Higher SH degree for better quality
  ]
  
  console.log(`[OpenSplat] Will save intermediate results every ${saveEvery} iterations (${Math.round(saveEvery / iterations * 100)}%)`)

  // Add image path if different from default
  if (imagesDir !== path.join(colmapProjectDir, 'images')) {
    args.push('--image-path', imagesDir)
  }

  const opensplatPath = getOpenSplatPath()
  console.log(`[OpenSplat] Running: ${opensplatPath} ${args.join(' ')}`)

  return new Promise((resolve, reject) => {
    const proc = spawn(opensplatPath, args, {
      shell: true,
      cwd: outputDir
    })
    
    // Register process for cancellation tracking
    registerProcess(jobId, proc)

    let lastProgress = 80
    let splatCount = 0
    let currentIteration = 0
    const totalIterations = iterations
    let lastProgressUpdate = Date.now()
    const PROGRESS_THROTTLE_MS = 500  // Only send progress updates every 500ms max

    // Parse OpenSplat output for progress
    const parseOutput = (data: string) => {
      const lines = data.toString().split('\n')
      
      for (const line of lines) {
        if (!line.trim()) continue

        // Parse iteration progress: "Iteration X/Y" or "Step X:"
        const iterMatch = line.match(/Iteration\s+(\d+)\s*\/\s*(\d+)/i)
        const stepMatch = line.match(/Step\s+(\d+):/i)
        
        if (iterMatch) {
          currentIteration = parseInt(iterMatch[1])
          const total = parseInt(iterMatch[2])
          const progressPct = 80 + Math.floor((currentIteration / total) * 15)
          lastProgress = progressPct
          
          // Throttle progress updates
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
          
          // Throttle progress updates
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

        // Parse splat count from densification output
        const newCountMatch = line.match(/new count\s+(\d+)/i)
        const remainingMatch = line.match(/remaining\s+(\d+)/i)
        const totalMatch = newCountMatch || remainingMatch
        
        if (totalMatch) {
          splatCount = parseInt(totalMatch[1])
          // Always send splat count updates immediately (they're infrequent)
          onProgress({
            progress: lastProgress,
            splatCount,
            message: `Training... ${splatCount.toLocaleString()} splats`,
            iteration: currentIteration,
            totalIterations
          })
          lastProgressUpdate = Date.now()
        }

        // Detect intermediate saves for live preview
        if (line.includes('Saving') || line.includes('Writing') || line.includes('Saved') || line.includes('Wrote')) {
          const wroteMatch = line.match(/result_(\d+)\.ply/i)
          const savedIteration = wroteMatch ? parseInt(wroteMatch[1]) : currentIteration
          
          const intermediatePly = path.join(outputDir, `result_${savedIteration}.ply`)
          fs.access(intermediatePly).then(() => {
            console.log(`[OpenSplat] Intermediate checkpoint ready: ${intermediatePly}`)
            onProgress({
              progress: lastProgress,
              message: `Saved checkpoint at iteration ${savedIteration}`,
              iteration: savedIteration,
              totalIterations,
              splatCount,
              intermediateReady: true
            } as any)
          }).catch(() => {
            findLatestIntermediate(outputDir).then(latestFile => {
              if (latestFile) {
                console.log(`[OpenSplat] Found intermediate: ${latestFile}`)
                onProgress({
                  progress: lastProgress,
                  message: `Saved checkpoint at iteration ${savedIteration}`,
                  iteration: savedIteration,
                  totalIterations,
                  splatCount,
                  intermediateReady: true
                } as any)
              }
            })
          })
        }
      }
    }

    // Only keep last N lines of output for error reporting (memory optimization)
    const MAX_OUTPUT_LINES = 100
    const recentOutput: string[] = []
    
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
      console.log(`[OpenSplat] Process exited with code ${code}`)
      
      if (code !== 0) {
        console.error(`[OpenSplat] Recent output:\n${recentOutput.join('\n')}`)
        reject(new Error(`OpenSplat exited with code ${code}. Check logs for details.`))
        return
      }

      // Verify output file exists
      try {
        await fs.access(outputPly)
      } catch {
        reject(new Error('OpenSplat did not produce output file'))
        return
      }

      // Get file stats to estimate splat count if not parsed
      if (splatCount === 0) {
        try {
          const stats = await fs.stat(outputPly)
          // Rough estimate: ~250 bytes per splat in PLY format
          splatCount = Math.floor(stats.size / 250)
        } catch {
          splatCount = 0
        }
      }

      // Generate .splat file from .ply if OpenSplat didn't create one
      let splatPath: string | undefined
      try {
        await fs.access(outputSplat)
        splatPath = outputSplat
      } catch {
        try {
          await convertPlyToSplat(outputPly, outputSplat)
          splatPath = outputSplat
        } catch (e) {
          console.warn('[OpenSplat] Could not convert to .splat format:', e)
        }
      }

      onProgress({
        progress: 100,
        message: `Training complete! ${splatCount.toLocaleString()} splats generated`,
        splatCount
      })

      resolve({
        plyPath: outputPly,
        splatPath,
        splatCount,
        trainingTime: 0,
        finalLoss: undefined
      })
    })

    proc.on('error', (err) => {
      console.error(`[OpenSplat] Process error:`, err)
      reject(new Error(`Failed to run OpenSplat: ${err.message}`))
    })
    
    proc.on('disconnect', () => {
      console.error(`[OpenSplat] Process disconnected unexpectedly`)
    })
  })
}

/**
 * Convert PLY to compact .splat format
 * The .splat format is a simplified binary format used by web viewers
 */
async function convertPlyToSplat(plyPath: string, splatPath: string): Promise<void> {
  // Read PLY file
  const plyData = await fs.readFile(plyPath)
  const plyText = plyData.toString('utf-8', 0, Math.min(plyData.length, 10000))

  // Parse header to get vertex count and format
  const headerEnd = plyText.indexOf('end_header')
  if (headerEnd === -1) {
    throw new Error('Invalid PLY file: no end_header found')
  }

  const header = plyText.substring(0, headerEnd)
  const vertexMatch = header.match(/element vertex (\d+)/)
  if (!vertexMatch) {
    throw new Error('Invalid PLY file: no vertex count found')
  }

  const vertexCount = parseInt(vertexMatch[1])
  const isBinary = header.includes('format binary')

  if (!isBinary) {
    // For ASCII PLY, we need to parse and convert
    // This is a simplified conversion - full implementation would parse all properties
    console.log(`[OpenSplat] PLY is ASCII format with ${vertexCount} vertices, conversion not implemented`)
    throw new Error('ASCII PLY conversion not yet implemented')
  }

  // For binary PLY, the data structure depends on the property layout
  // Standard Gaussian Splat PLY has: x, y, z, nx, ny, nz, f_dc_0..2, f_rest_0..44, opacity, scale_0..2, rot_0..3
  // We need to extract and pack into .splat format: position (12), scale (12), color (4), quaternion (4) = 32 bytes

  const headerBytes = Buffer.from(header + '\nend_header\n').length
  const dataStart = plyData.indexOf(Buffer.from('end_header')) + 11 // 'end_header\n'.length

  // Simplified: copy binary data and let the viewer handle it
  // A proper implementation would repack the data
  console.log(`[OpenSplat] Binary PLY with ${vertexCount} vertices, direct copy to .splat`)
  
  // For now, just copy the PLY - the frontend can handle both formats
  await fs.copyFile(plyPath, splatPath)
}

/**
 * Check if GPU is available for OpenSplat
 * OpenSplat auto-detects GPU, but we can check CUDA availability
 */
export async function checkOpenSplatGPU(): Promise<boolean> {
  // OpenSplat handles GPU detection internally
  // We just check if nvidia-smi is available as a proxy
  return new Promise((resolve) => {
    const proc = spawn('nvidia-smi', [], {
      shell: true,
      timeout: 5000
    })

    proc.on('close', (code) => {
      resolve(code === 0)
    })

    proc.on('error', () => {
      resolve(false)
    })
  })
}
