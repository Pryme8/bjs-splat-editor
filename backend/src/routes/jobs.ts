/**
 * Job management routes
 */

import { Router } from 'express'
import multer from 'multer'
import path from 'path'
import fs from 'fs/promises'
import { v4 as uuidv4 } from 'uuid'
import { fileURLToPath } from 'url'

import { createJob, getJob, getAllJobs, cancelJob } from '../services/jobManager.js'
import { findLatestIntermediate } from '../services/opensplat.js'
import type { JobConfig, TrainingMode, TrainerEngine } from '../types/index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const UPLOAD_DIR = path.join(__dirname, '../../data/uploads')
const RESULTS_DIR = path.join(__dirname, '../../data/results')

// Ensure directories exist
await fs.mkdir(UPLOAD_DIR, { recursive: true })
await fs.mkdir(RESULTS_DIR, { recursive: true })

// Multer configuration for image uploads
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    // Use existing jobId from body (set by first file) or generate new one
    // Store in a custom property to persist across files
    if (!(req as any)._jobId) {
      (req as any)._jobId = uuidv4()
    }
    const jobId = (req as any)._jobId
    const jobDir = path.join(UPLOAD_DIR, jobId, 'images')
    await fs.mkdir(jobDir, { recursive: true })
    req.body.jobId = jobId
    cb(null, jobDir)
  },
  filename: (req, file, cb) => {
    // Keep original filename with sanitization
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')
    cb(null, safeName)
  }
})

const upload = multer({
  storage,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB per file
    files: 300 // Max 300 images
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp']
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true)
    } else {
      cb(new Error('Only JPEG, PNG, and WebP images are allowed'))
    }
  }
})

const router = Router()

/**
 * GET /api/jobs - List all jobs
 */
router.get('/', async (req, res) => {
  try {
    const jobs = await getAllJobs()
    res.json({ jobs })
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch jobs' })
  }
})

/**
 * POST /api/jobs - Create a new job and upload images
 */
router.post('/', upload.array('images', 300), async (req, res) => {
  try {
    const files = req.files as Express.Multer.File[]
    
    if (!files || files.length < 3) {
      return res.status(400).json({ 
        error: 'At least 3 images are required for reconstruction' 
      })
    }

    const jobId = req.body.jobId || uuidv4()
    
    // Parse config from request
    const config: JobConfig = {
      trainingMode: (req.body.trainingMode as TrainingMode) || 'auto',
      iterations: parseInt(req.body.iterations) || 7000,
      resolution: parseInt(req.body.resolution) || 512,
      shDegree: parseInt(req.body.shDegree) || 0,
      // Cleanup config (defaults are in plyCleanup.ts)
      cleanupEnabled: req.body.cleanupEnabled !== 'false',  // Default true
      cleanupMinOpacity: req.body.cleanupMinOpacity ? parseFloat(req.body.cleanupMinOpacity) : undefined,
      cleanupMaxScalePercentile: req.body.cleanupMaxScalePercentile ? parseFloat(req.body.cleanupMaxScalePercentile) : undefined,
      cleanupSorStdDevs: req.body.cleanupSorStdDevs ? parseFloat(req.body.cleanupSorStdDevs) : undefined,
      // AI Enhancement: Depth Anything
      depthEstimationEnabled: req.body.depthEstimationEnabled === 'true',
      depthModelSize: (req.body.depthModelSize as 'small' | 'base' | 'large') || 'small',
      depthFloaterFilterEnabled: req.body.depthFloaterFilterEnabled !== 'false',  // Default true when depth enabled
      depthFloaterThreshold: req.body.depthFloaterThreshold ? parseFloat(req.body.depthFloaterThreshold) : undefined,
      // AI Enhancement: Learned Features (DISK + LightGlue)
      learnedFeaturesEnabled: req.body.learnedFeaturesEnabled === 'true',
      learnedFeaturesMaxKeypoints: req.body.learnedFeaturesMaxKeypoints ? parseInt(req.body.learnedFeaturesMaxKeypoints) : undefined,
      // Trainer engine selection
      trainerEngine: (req.body.trainerEngine as TrainerEngine) || 'auto'
    }

    // Create job
    const job = await createJob(jobId, files, config)

    res.status(201).json({
      jobId: job.id,
      status: job.status,
      imageCount: job.imageCount,
      message: 'Job created successfully. Processing will begin shortly.'
    })
  } catch (error) {
    console.error('[Jobs] Failed to create job:', error)
    res.status(500).json({ 
      error: 'Failed to create job',
      details: error instanceof Error ? error.message : 'Unknown error'
    })
  }
})

/**
 * GET /api/jobs/:id - Get job status
 */
router.get('/:id', async (req, res) => {
  try {
    const job = await getJob(req.params.id)
    
    if (!job) {
      return res.status(404).json({ error: 'Job not found' })
    }

    res.json({ job })
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch job' })
  }
})

/**
 * GET /api/jobs/:id/result - Download job result
 */
router.get('/:id/result', async (req, res) => {
  try {
    console.log(`[Jobs] Result request for job ${req.params.id}, format: ${req.query.format}`)
    
    const job = await getJob(req.params.id)
    
    if (!job) {
      console.log(`[Jobs] Job ${req.params.id} not found`)
      return res.status(404).json({ error: 'Job not found' })
    }

    console.log(`[Jobs] Job status: ${job.status}`)

    if (job.status !== 'complete') {
      return res.status(400).json({ 
        error: 'Job not complete',
        status: job.status
      })
    }

    const format = req.query.format || 'ply'
    const resultPath = path.join(RESULTS_DIR, job.id, `result.${format}`)
    
    console.log(`[Jobs] Looking for result file at: ${resultPath}`)

    try {
      await fs.access(resultPath)
      const stats = await fs.stat(resultPath)
      console.log(`[Jobs] Found file, size: ${stats.size} bytes`)
      res.download(resultPath, `splat_${job.id}.${format}`)
    } catch (err) {
      console.error(`[Jobs] File not found:`, err)
      res.status(404).json({ error: `Result file not found in ${format} format` })
    }
  } catch (error) {
    console.error(`[Jobs] Error fetching result:`, error)
    res.status(500).json({ error: 'Failed to fetch result' })
  }
})

/**
 * GET /api/jobs/:id/intermediate - Download latest intermediate result (during training)
 */
router.get('/:id/intermediate', async (req, res) => {
  try {
    console.log(`[Jobs] Intermediate result request for job ${req.params.id}`)
    
    const job = await getJob(req.params.id)
    
    if (!job) {
      console.log(`[Jobs] Job ${req.params.id} not found`)
      return res.status(404).json({ error: 'Job not found' })
    }

    // Allow intermediate results only during training
    if (job.status === 'complete') {
      // Redirect to final result
      const resultPath = path.join(RESULTS_DIR, job.id, 'result.ply')
      try {
        await fs.access(resultPath)
        return res.download(resultPath, `intermediate_${job.id}.ply`)
      } catch {
        return res.status(404).json({ error: 'No result file found' })
      }
    }

    // Look for intermediate file
    const jobDir = path.join(RESULTS_DIR, job.id)
    const intermediatePath = await findLatestIntermediate(jobDir)
    
    if (intermediatePath) {
      const stats = await fs.stat(intermediatePath)
      console.log(`[Jobs] Found intermediate file: ${intermediatePath}, size: ${stats.size} bytes`)
      res.download(intermediatePath, `intermediate_${job.id}.ply`)
    } else {
      console.log(`[Jobs] No intermediate file found for job ${req.params.id}`)
      res.status(404).json({ error: 'No intermediate result available yet' })
    }
  } catch (error) {
    console.error(`[Jobs] Error fetching intermediate result:`, error)
    res.status(500).json({ error: 'Failed to fetch intermediate result' })
  }
})

/**
 * GET /api/jobs/:id/colmap-preview - Get COLMAP preview data (cameras + point cloud)
 */
router.get('/:id/colmap-preview', async (req, res) => {
  try {
    console.log(`[Jobs] COLMAP preview request for job ${req.params.id}`)
    
    const job = await getJob(req.params.id)
    
    if (!job) {
      return res.status(404).json({ error: 'Job not found' })
    }

    if (!job.colmapData) {
      return res.status(400).json({ error: 'COLMAP data not available yet' })
    }

    // Build response with cameras and points
    const response = {
      cameras: job.colmapData.cameras.map(cam => ({
        id: cam.id,
        position: cam.position,
        rotation: cam.rotation,
        focalLength: cam.params[0] || 1000,  // First param is usually focal length
        width: cam.width,
        height: cam.height,
        imageName: cam.imageName
      })),
      points3D: job.colmapData.points3D,
      points3DCount: job.colmapData.points3DCount,
      imageBaseUrl: `/api/jobs/${job.id}/images`
    }

    console.log(`[Jobs] Returning COLMAP preview: ${response.cameras.length} cameras, ${response.points3D.length} points`)
    res.json(response)
  } catch (error) {
    console.error(`[Jobs] Error fetching COLMAP preview:`, error)
    res.status(500).json({ error: 'Failed to fetch COLMAP preview' })
  }
})

/**
 * GET /api/jobs/:id/images/:filename - Serve uploaded image for thumbnail display
 */
router.get('/:id/images/:filename', async (req, res) => {
  try {
    const { id, filename } = req.params
    
    // Sanitize filename to prevent directory traversal
    const safeName = path.basename(filename)
    const imagePath = path.join(UPLOAD_DIR, id, 'images', safeName)
    
    try {
      await fs.access(imagePath)
      res.sendFile(imagePath)
    } catch {
      res.status(404).json({ error: 'Image not found' })
    }
  } catch (error) {
    console.error(`[Jobs] Error serving image:`, error)
    res.status(500).json({ error: 'Failed to serve image' })
  }
})

/**
 * DELETE /api/jobs/:id - Cancel a job
 */
router.delete('/:id', async (req, res) => {
  try {
    const success = await cancelJob(req.params.id)
    
    if (!success) {
      return res.status(404).json({ error: 'Job not found or already completed' })
    }

    res.json({ message: 'Job cancelled successfully' })
  } catch (error) {
    res.status(500).json({ error: 'Failed to cancel job' })
  }
})

export { router as jobsRouter }
