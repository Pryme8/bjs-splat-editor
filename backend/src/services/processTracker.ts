/**
 * Process Tracker - Tracks running child processes per job for cancellation
 */

import { ChildProcess, execSync } from 'child_process'

// Map of jobId -> Set of running processes
const runningProcesses = new Map<string, Set<ChildProcess>>()

const isWindows = process.platform === 'win32'

/**
 * Register a process for a job
 */
export function registerProcess(jobId: string, process: ChildProcess): void {
  if (!runningProcesses.has(jobId)) {
    runningProcesses.set(jobId, new Set())
  }
  runningProcesses.get(jobId)!.add(process)
  
  // Auto-remove when process exits
  process.on('exit', () => {
    const processes = runningProcesses.get(jobId)
    if (processes) {
      processes.delete(process)
      if (processes.size === 0) {
        runningProcesses.delete(jobId)
      }
    }
  })
  
  console.log(`[ProcessTracker] Registered process ${process.pid} for job ${jobId}`)
}

/**
 * Kill a process and all its children (Windows-compatible)
 */
function killProcessTree(pid: number): boolean {
  try {
    if (isWindows) {
      // Use taskkill with /T flag to kill entire process tree
      console.log(`[ProcessTracker] Using taskkill /F /T /PID ${pid}`)
      execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' })
    } else {
      // On Unix, use process group kill
      process.kill(-pid, 'SIGKILL')
    }
    return true
  } catch (e) {
    // Process might have already exited
    console.warn(`[ProcessTracker] taskkill failed (process may have exited):`, (e as Error).message)
    return false
  }
}

/**
 * Kill all processes for a job
 */
export function killJobProcesses(jobId: string): number {
  const processes = runningProcesses.get(jobId)
  if (!processes || processes.size === 0) {
    return 0
  }
  
  let killed = 0
  for (const proc of processes) {
    try {
      if (proc.pid && !proc.killed) {
        console.log(`[ProcessTracker] Killing process tree for PID ${proc.pid} (job ${jobId})`)
        if (killProcessTree(proc.pid)) {
          killed++
        }
      }
    } catch (e) {
      console.warn(`[ProcessTracker] Failed to kill process:`, e)
    }
  }
  
  runningProcesses.delete(jobId)
  console.log(`[ProcessTracker] Killed ${killed} process trees for job ${jobId}`)
  return killed
}

/**
 * Check if a job has running processes
 */
export function hasRunningProcesses(jobId: string): boolean {
  const processes = runningProcesses.get(jobId)
  return processes !== undefined && processes.size > 0
}

/**
 * Kill all tracked processes (for shutdown)
 */
export function killAllProcesses(): number {
  let totalKilled = 0
  for (const jobId of runningProcesses.keys()) {
    totalKilled += killJobProcesses(jobId)
  }
  return totalKilled
}

/**
 * Get count of running processes for a job
 */
export function getProcessCount(jobId: string): number {
  return runningProcesses.get(jobId)?.size || 0
}
