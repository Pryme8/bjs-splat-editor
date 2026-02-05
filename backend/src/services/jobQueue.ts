/**
 * Job Queue Service using Bull + Redis
 * 
 * Set SKIP_REDIS=true to run in direct mode without Redis
 * (useful for local development)
 */

import Queue from 'bull'
import Redis from 'ioredis'
import type { Job, JobProgress } from '../types/index.js'
import { processTrainingJob } from './trainingWorker.js'
import { broadcastProgress } from '../websocket/index.js'

let trainingQueue: Queue.Queue | null = null
let redisClient: Redis | null = null
let directMode = false

export function getRedisClient(): Redis | null {
  return redisClient
}

export function isDirectMode(): boolean {
  return directMode
}

export async function initializeJobQueue(): Promise<void> {
  // Check if we should skip Redis entirely
  const skipRedis = process.env.SKIP_REDIS === 'true' || process.env.SKIP_REDIS === '1'
  
  if (skipRedis) {
    console.log('[JobQueue] SKIP_REDIS enabled - running in direct mode')
    console.log('[JobQueue] Jobs will be processed immediately without queuing')
    directMode = true
    return
  }

  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379'
  
  try {
    // Create Redis client
    redisClient = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => {
        if (times > 3) {
          console.warn('[JobQueue] Redis connection failed, running without queue')
          return null
        }
        return Math.min(times * 100, 3000)
      }
    })

    redisClient.on('error', (err) => {
      console.warn('[JobQueue] Redis error:', err.message)
    })

    redisClient.on('connect', () => {
      console.log('[JobQueue] Connected to Redis')
    })

    // Create Bull queue
    trainingQueue = new Queue('training', redisUrl, {
      defaultJobOptions: {
        attempts: 1,
        timeout: parseInt(process.env.JOB_TIMEOUT_MS || '7200000'), // 2 hours default
        removeOnComplete: false,
        removeOnFail: false
      }
    })

    // Process jobs
    trainingQueue.process(
      parseInt(process.env.MAX_CONCURRENT_JOBS || '1'),
      async (bullJob) => {
        return processTrainingJob(bullJob.data, (progress: JobProgress) => {
          // Update Bull job progress
          bullJob.progress(progress.progress)
          // Broadcast via WebSocket
          broadcastProgress(progress)
        })
      }
    )

    // Queue event handlers
    trainingQueue.on('completed', (job, result) => {
      console.log(`[JobQueue] Job ${job.id} completed`)
      broadcastProgress({
        jobId: job.data.jobId,
        status: 'complete',
        progress: 100,
        message: 'Training complete!',
        splatCount: result?.splatCount
      })
    })

    trainingQueue.on('failed', (job, err) => {
      console.error(`[JobQueue] Job ${job.id} failed:`, err.message)
      broadcastProgress({
        jobId: job.data.jobId,
        status: 'failed',
        progress: 0,
        message: err.message
      })
    })

    trainingQueue.on('stalled', (job) => {
      console.warn(`[JobQueue] Job ${job.id} stalled`)
    })

    console.log('[JobQueue] Initialized successfully')
  } catch (error) {
    console.warn('[JobQueue] Failed to initialize Redis/Bull, running in direct mode')
    console.warn('[JobQueue] Jobs will be processed directly without queuing')
    directMode = true
  }
}

export async function addJobToQueue(jobData: {
  jobId: string
  imagesDir: string
  outputDir: string
  config: Job['config']
}): Promise<void> {
  if (trainingQueue) {
    await trainingQueue.add(jobData, {
      jobId: jobData.jobId
    })
    console.log(`[JobQueue] Job ${jobData.jobId} added to queue`)
  } else {
    // Direct processing without queue (fallback)
    console.log(`[JobQueue] Processing job ${jobData.jobId} directly (no Redis)`)
    processTrainingJob(jobData, broadcastProgress).catch(err => {
      console.error(`[JobQueue] Direct job ${jobData.jobId} failed:`, err)
      broadcastProgress({
        jobId: jobData.jobId,
        status: 'failed',
        progress: 0,
        message: err.message
      })
    })
  }
}

export async function removeJobFromQueue(jobId: string): Promise<boolean> {
  if (!trainingQueue) return false
  
  try {
    const job = await trainingQueue.getJob(jobId)
    if (job) {
      await job.remove()
      return true
    }
  } catch (error) {
    console.error(`[JobQueue] Failed to remove job ${jobId}:`, error)
  }
  return false
}

export async function getQueueStats(): Promise<{
  waiting: number
  active: number
  completed: number
  failed: number
}> {
  if (!trainingQueue) {
    return { waiting: 0, active: 0, completed: 0, failed: 0 }
  }

  const [waiting, active, completed, failed] = await Promise.all([
    trainingQueue.getWaitingCount(),
    trainingQueue.getActiveCount(),
    trainingQueue.getCompletedCount(),
    trainingQueue.getFailedCount()
  ])

  return { waiting, active, completed, failed }
}
