/**
 * CUDA Detection Service
 * Detects NVIDIA GPU and PyTorch CUDA availability
 */

import { exec, spawn } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

export interface CudaInfo {
  available: boolean
  gpuName: string | null
  vramMB: number | null
  cudaVersion: string | null
  driverVersion: string | null
  pytorchCuda: boolean
  error?: string
}

let cachedCudaInfo: CudaInfo | null = null

/**
 * Detect CUDA availability and GPU info
 * Results are cached after first call
 */
export async function detectCuda(): Promise<CudaInfo> {
  if (cachedCudaInfo) {
    return cachedCudaInfo
  }

  const info: CudaInfo = {
    available: false,
    gpuName: null,
    vramMB: null,
    cudaVersion: null,
    driverVersion: null,
    pytorchCuda: false
  }

  // Step 1: Check nvidia-smi
  try {
    const { stdout } = await execAsync(
      'nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader,nounits',
      { timeout: 10000 }
    )
    
    const lines = stdout.trim().split('\n')
    if (lines.length > 0 && lines[0]) {
      const parts = lines[0].split(',').map(s => s.trim())
      if (parts.length >= 3) {
        info.gpuName = parts[0]
        info.vramMB = parseInt(parts[1]) || null
        info.driverVersion = parts[2]
        info.available = true
      }
    }
  } catch (error) {
    // nvidia-smi not found or failed
    info.error = 'nvidia-smi not found - no NVIDIA GPU detected'
    cachedCudaInfo = info
    return info
  }

  // Step 2: Get CUDA version from nvidia-smi header
  try {
    const { stdout } = await execAsync('nvidia-smi', { timeout: 5000 })
    // Parse CUDA version from header: "CUDA Version: 13.0"
    const cudaMatch = stdout.match(/CUDA Version:\s*(\d+\.?\d*)/i)
    if (cudaMatch) {
      info.cudaVersion = cudaMatch[1]
    }
  } catch {
    // Try nvcc as fallback
    try {
      const { stdout } = await execAsync('nvcc --version', { timeout: 5000 })
      const match = stdout.match(/release (\d+\.\d+)/)
      if (match) {
        info.cudaVersion = match[1]
      }
    } catch {
      // nvcc also not found
    }
  }

  // Step 3: Check if PyTorch with CUDA is available AND compatible
  try {
    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3'
    
    // First check if CUDA is available
    const { stdout } = await execAsync(
      `${pythonCmd} -c "import torch; print('cuda' if torch.cuda.is_available() else 'cpu')"`,
      { timeout: 30000 }
    )
    info.pytorchCuda = stdout.trim().toLowerCase() === 'cuda'
    
    if (info.pytorchCuda) {
      // Test if we can actually use CUDA (catches sm_XXX compatibility issues)
      try {
        const { stderr } = await execAsync(
          `${pythonCmd} -c "import torch; t = torch.zeros(1).cuda(); print('ok')"`,
          { timeout: 30000 }
        )
        // Check for compatibility warnings in stderr
        if (stderr && stderr.includes('not compatible')) {
          info.pytorchCuda = false
          const match = stderr.match(/sm_(\d+)/)
          const gpuArch = match ? `sm_${match[1]}` : 'unknown'
          info.error = `GPU architecture ${gpuArch} not supported by current PyTorch. Your GPU is too new! Try PyTorch nightly or use CPU mode.`
        }
      } catch (testError) {
        // CUDA test failed
        info.pytorchCuda = false
        info.error = 'CUDA test failed - GPU may not be compatible with PyTorch. Use CPU mode.'
      }
    } else {
      // Check if PyTorch is installed but without CUDA
      try {
        const { stdout: torchInfo } = await execAsync(
          `${pythonCmd} -c "import torch; print(torch.__version__)"`,
          { timeout: 10000 }
        )
        info.error = `PyTorch ${torchInfo.trim()} installed but without CUDA support. Install with: pip install torch --index-url https://download.pytorch.org/whl/cu121`
      } catch {
        info.error = 'PyTorch not installed. Run: pip install -r requirements-cuda.txt'
      }
    }
  } catch (error) {
    // PyTorch not installed or error
    info.pytorchCuda = false
    info.error = 'PyTorch not installed. Run: pip install -r requirements-cuda.txt'
  }

  // Final availability check - need both GPU and PyTorch CUDA
  info.available = info.available && info.pytorchCuda

  cachedCudaInfo = info
  console.log('[CUDA] Detection result:', info)
  return info
}

/**
 * Quick check if CUDA is available (uses cached result)
 */
export async function isCudaAvailable(): Promise<boolean> {
  const info = await detectCuda()
  return info.available
}

/**
 * Clear cached CUDA info (useful for re-detection)
 */
export function clearCudaCache(): void {
  cachedCudaInfo = null
}

/**
 * Get cached CUDA info without re-detecting
 */
export function getCachedCudaInfo(): CudaInfo | null {
  return cachedCudaInfo
}

/**
 * Check if Python is available
 */
export async function isPythonAvailable(): Promise<boolean> {
  try {
    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3'
    await execAsync(`${pythonCmd} --version`, { timeout: 5000 })
    return true
  } catch {
    return false
  }
}

/**
 * Check if required Python packages are installed
 */
export async function checkPythonDependencies(): Promise<{
  torch: boolean
  numpy: boolean
  pillow: boolean
}> {
  const pythonCmd = process.platform === 'win32' ? 'python' : 'python3'
  
  const checkPackage = async (pkg: string): Promise<boolean> => {
    try {
      await execAsync(`${pythonCmd} -c "import ${pkg}"`, { timeout: 10000 })
      return true
    } catch {
      return false
    }
  }

  const [torch, numpy, pillow] = await Promise.all([
    checkPackage('torch'),
    checkPackage('numpy'),
    checkPackage('PIL')
  ])

  return { torch, numpy, pillow }
}
