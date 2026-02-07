/**
 * Health check routes
 */

import { Router } from 'express'
import { exec } from 'child_process'
import { promisify } from 'util'
import { detectCuda, getCachedCudaInfo, type CudaInfo } from '../services/cuda.js'
import { isDirectMode } from '../services/jobQueue.js'
import { checkGsplatAvailable, getGsplatVersion } from '../services/gsplatTrainer.js'
import { isDockerMode } from '../services/opensplat.js'

const execAsync = promisify(exec)
const router = Router()

router.get('/', async (req, res) => {
  const health = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    services: {
      api: true,
      colmap: false,
      redis: false,
      opensplat: false,
      gsplat: false,
      cuda: false
    },
    versions: {
      node: process.version,
      colmap: null as string | null,
      opensplat: null as string | null,
      gsplat: null as string | null
    },
    cuda: null as CudaInfo | null,
    mode: isDirectMode() ? 'direct' : 'queued',
    opensplatDocker: isDockerMode()
  }

  // Check COLMAP
  try {
    const colmapPath = process.env.COLMAP_PATH || 'colmap'
    // COLMAP uses 'help' instead of '--version'
    const { stdout } = await execAsync(`"${colmapPath}" help`)
    health.services.colmap = stdout.includes('COLMAP')
    // Extract version from output like "COLMAP 3.13.0 -- Structure-from-Motion"
    const versionMatch = stdout.match(/COLMAP\s+([\d.]+)/)
    health.versions.colmap = versionMatch ? versionMatch[1] : 'installed'
  } catch {
    health.services.colmap = false
  }

  // Check Redis (basic check)
  if (!isDirectMode()) {
    try {
      const { getRedisClient } = await import('../services/jobQueue.js')
      const client = getRedisClient()
      if (client) {
        await client.ping()
        health.services.redis = true
      }
    } catch {
      health.services.redis = false
    }
  }

  // Check OpenSplat
  try {
    const opensplatPath = process.env.OPENSPLAT_PATH || 'opensplat'
    const { stdout } = await execAsync(`"${opensplatPath}" --help`)
    health.services.opensplat = stdout.includes('opensplat') || stdout.includes('Usage')
    health.versions.opensplat = 'installed'
  } catch {
    health.services.opensplat = false
  }

  // Check gsplat (Python-based trainer)
  try {
    health.services.gsplat = await checkGsplatAvailable()
    if (health.services.gsplat) {
      health.versions.gsplat = await getGsplatVersion() || 'installed'
    }
  } catch {
    health.services.gsplat = false
  }

  // Check CUDA (use cached result if available, otherwise detect)
  const cudaInfo = getCachedCudaInfo() || await detectCuda()
  health.services.cuda = cudaInfo.available
  health.cuda = cudaInfo

  res.json(health)
})

router.get('/colmap', async (req, res) => {
  try {
    const colmapPath = process.env.COLMAP_PATH || 'colmap'
    const { stdout } = await execAsync(`"${colmapPath}" help`)
    const versionMatch = stdout.match(/COLMAP\s+([\d.]+)/)
    res.json({
      available: true,
      version: versionMatch ? versionMatch[1] : 'installed',
      path: colmapPath
    })
  } catch {
    res.status(503).json({
      available: false,
      error: 'COLMAP not found',
      hint: 'Make sure COLMAP is installed and COLMAP_PATH is set correctly'
    })
  }
})

router.get('/cuda', async (req, res) => {
  try {
    // If refresh=true, clear cached result
    if (req.query.refresh === 'true') {
      const { clearCudaCache } = await import('../services/cuda.js')
      clearCudaCache()
    }
    
    const cudaInfo = await detectCuda()
    
    res.json({
      available: cudaInfo.available,
      gpu: cudaInfo.gpuName,
      vramMB: cudaInfo.vramMB,
      cudaVersion: cudaInfo.cudaVersion,
      driverVersion: cudaInfo.driverVersion,
      pytorchCuda: cudaInfo.pytorchCuda,
      error: cudaInfo.error,
      hint: cudaInfo.available 
        ? undefined 
        : 'Install PyTorch with CUDA: pip install torch --index-url https://download.pytorch.org/whl/cu121'
    })
  } catch (error) {
    res.status(500).json({
      available: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    })
  }
})

export { router as healthRouter }
