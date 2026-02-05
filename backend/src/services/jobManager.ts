/**
 * Job Manager - Handles job lifecycle and state
 */

import path from 'path'
import fs from 'fs/promises'
import { fileURLToPath } from 'url'
import type { Job, JobConfig, JobStatus, UploadedImage } from '../types/index.js'
import { addJobToQueue, removeJobFromQueue } from './jobQueue.js'
import { killJobProcesses } from './processTracker.js'
import { removeJobOwnership } from '../websocket/index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, '../../data')
const JOBS_FILE = path.join(DATA_DIR, 'jobs.json')

// In-memory job store (not persisted - cleared on restart)
let jobs: Map<string, Job> = new Map()

// No-op save function (jobs are in-memory only, cleared on restart)
async function saveJobs(): Promise<void> {
  // Jobs are not persisted to disk
}

// Clean up old data on startup
async function cleanupOnStartup(): Promise<void> {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true })
    
    // Delete old jobs file
    try {
      await fs.unlink(JOBS_FILE)
      console.log('[JobManager] Cleared old jobs file')
    } catch {
      // File doesn't exist, that's fine
    }
    
    // Clean up old upload and result directories
    const uploadsDir = path.join(DATA_DIR, 'uploads')
    const resultsDir = path.join(DATA_DIR, 'results')
    
    try {
      await fs.rm(uploadsDir, { recursive: true, force: true })
      await fs.rm(resultsDir, { recursive: true, force: true })
      console.log('[JobManager] Cleared old uploads and results')
    } catch {
      // Directories don't exist, that's fine
    }
    
    // Recreate directories
    await fs.mkdir(uploadsDir, { recursive: true })
    await fs.mkdir(resultsDir, { recursive: true })
    
    jobs = new Map()
    console.log('[JobManager] Ready - starting fresh')
  } catch (error) {
    console.error('[JobManager] Cleanup error:', error)
    jobs = new Map()
  }
}

// Initialize on module load
cleanupOnStartup()

export async function createJob(
  jobId: string,
  files: Express.Multer.File[],
  config: JobConfig
): Promise<Job> {
  const now = new Date()
  
  const job: Job = {
    id: jobId,
    status: 'pending',
    progress: 0,
    message: 'Job created, waiting to start...',
    config,
    imageCount: files.length,
    createdAt: now,
    updatedAt: now
  }

  jobs.set(jobId, job)
  await saveJobs()

  // Create output directory
  const outputDir = path.join(DATA_DIR, 'results', jobId)
  await fs.mkdir(outputDir, { recursive: true })

  // Add to processing queue
  const imagesDir = path.join(DATA_DIR, 'uploads', jobId, 'images')
  await addJobToQueue({
    jobId,
    imagesDir,
    outputDir,
    config
  })

  return job
}

export async function getJob(jobId: string): Promise<Job | null> {
  return jobs.get(jobId) || null
}

export async function getAllJobs(): Promise<Job[]> {
  return Array.from(jobs.values()).sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
  )
}

export async function updateJob(
  jobId: string,
  updates: Partial<Job>
): Promise<Job | null> {
  const job = jobs.get(jobId)
  if (!job) return null

  const updatedJob: Job = {
    ...job,
    ...updates,
    updatedAt: new Date()
  }

  jobs.set(jobId, updatedJob)
  await saveJobs()

  return updatedJob
}

export async function updateJobStatus(
  jobId: string,
  status: JobStatus,
  progress: number,
  message: string
): Promise<void> {
  await updateJob(jobId, { status, progress, message })
}

export async function completeJob(
  jobId: string,
  resultUrl: string
): Promise<void> {
  await updateJob(jobId, {
    status: 'complete',
    progress: 100,
    message: 'Training complete!',
    completedAt: new Date(),
    resultUrl
  })
  
  // Remove from ownership tracking (prevents cancel on disconnect)
  removeJobOwnership(jobId)
}

export async function failJob(
  jobId: string,
  error: string
): Promise<void> {
  await updateJob(jobId, {
    status: 'failed',
    message: error,
    error,
    completedAt: new Date()
  })
  
  // Remove from ownership tracking
  removeJobOwnership(jobId)
}

export async function cancelJob(jobId: string): Promise<boolean> {
  const job = jobs.get(jobId)
  if (!job) return false

  if (job.status === 'complete' || job.status === 'failed' || job.status === 'cancelled') {
    return false
  }

  console.log(`[JobManager] Cancelling job ${jobId}`)

  // Kill any running processes
  const killedCount = killJobProcesses(jobId)
  console.log(`[JobManager] Killed ${killedCount} processes for job ${jobId}`)

  // Remove from queue if pending
  await removeJobFromQueue(jobId)

  await updateJob(jobId, {
    status: 'cancelled',
    message: 'Job cancelled',
    completedAt: new Date()
  })
  
  // Remove from ownership tracking
  removeJobOwnership(jobId)
  
  // Clean up job files (uploads and results)
  await cleanupJobFiles(jobId)

  return true
}

/**
 * Clean up all files associated with a job
 */
async function cleanupJobFiles(jobId: string): Promise<void> {
  try {
    const uploadsPath = path.join(DATA_DIR, 'uploads', jobId)
    const resultsPath = path.join(DATA_DIR, 'results', jobId)
    
    await fs.rm(uploadsPath, { recursive: true, force: true })
    await fs.rm(resultsPath, { recursive: true, force: true })
    
    console.log(`[JobManager] Cleaned up files for job ${jobId}`)
  } catch (error) {
    console.warn(`[JobManager] Failed to clean up files for job ${jobId}:`, error)
  }
}

export async function deleteJob(jobId: string): Promise<boolean> {
  const job = jobs.get(jobId)
  if (!job) return false

  // Clean up files
  try {
    await fs.rm(path.join(DATA_DIR, 'uploads', jobId), { recursive: true, force: true })
    await fs.rm(path.join(DATA_DIR, 'results', jobId), { recursive: true, force: true })
  } catch (error) {
    console.error(`[JobManager] Failed to clean up files for job ${jobId}:`, error)
  }

  jobs.delete(jobId)
  await saveJobs()

  return true
}
