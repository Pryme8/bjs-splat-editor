/**
 * Semantic Selection Routes
 * 
 * Handles text-based object selection using Grounding DINO + SAM
 */

import { Router } from 'express'
import multer from 'multer'
import path from 'path'
import fs from 'fs/promises'
import { v4 as uuidv4 } from 'uuid'
import { fileURLToPath } from 'url'

import { 
  runSemanticSegmentation, 
  checkSemanticSegmentationAvailable,
  checkSemanticSegmentationDependencies 
} from '../services/semanticSegmentation.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TEMP_DIR = path.join(__dirname, '../../data/temp')

// Ensure temp directory exists
await fs.mkdir(TEMP_DIR, { recursive: true })

// Multer configuration for semantic select uploads
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    if (!(req as any)._sessionId) {
      (req as any)._sessionId = uuidv4()
    }
    const sessionDir = path.join(TEMP_DIR, (req as any)._sessionId)
    await fs.mkdir(sessionDir, { recursive: true })
    cb(null, sessionDir)
  },
  filename: (req, file, cb) => {
    cb(null, file.originalname)
  }
})

const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB per file
    files: 16 // Max 16 images for semantic selection
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true)
    } else {
      cb(new Error('Only image files are allowed'))
    }
  }
})

const router = Router()

/**
 * GET /api/semantic-select/status - Check if semantic segmentation is available
 */
router.get('/status', async (req, res) => {
  try {
    const available = await checkSemanticSegmentationAvailable()
    const deps = await checkSemanticSegmentationDependencies()
    
    res.json({
      available,
      dependencies: deps
    })
  } catch (error) {
    res.status(500).json({ 
      error: 'Failed to check semantic segmentation status',
      details: error instanceof Error ? error.message : 'Unknown error'
    })
  }
})

/**
 * POST /api/semantic-select - Run semantic segmentation on provided images
 * 
 * Form data:
 *   - prompt: string           // Text prompt describing what to select
 *   - images: File[]           // Image files
 *   - boxThreshold?: number    // Detection threshold (0-1)
 *   - textThreshold?: number   // Text matching threshold (0-1)
 */
router.post('/', upload.array('images', 16), async (req, res) => {
  const sessionId = (req as any)._sessionId || uuidv4()
  const sessionDir = path.join(TEMP_DIR, sessionId)
  
  try {
    const files = req.files as Express.Multer.File[]
    const { prompt, boxThreshold, textThreshold } = req.body
    
    // Validate request
    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'Prompt is required' })
    }
    
    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'At least one image is required' })
    }
    
    console.log(`[SemanticSelect] Starting session ${sessionId} with prompt: "${prompt}"`)
    console.log(`[SemanticSelect] Processing ${files.length} images`)
    
    // Run semantic segmentation
    const result = await runSemanticSegmentation(
      sessionDir,
      prompt,
      {
        boxThreshold: boxThreshold ? parseFloat(boxThreshold) : undefined,
        textThreshold: textThreshold ? parseFloat(textThreshold) : undefined,
        onProgress: (message, current, total) => {
          console.log(`[SemanticSelect] Progress: ${message}`)
        }
      }
    )
    
    console.log(`[SemanticSelect] Completed: ${result.images_with_detections}/${result.images_processed} images had detections`)
    
    res.json({
      success: true,
      sessionId,
      ...result
    })
    
  } catch (error) {
    console.error(`[SemanticSelect] Error:`, error)
    res.status(500).json({
      error: 'Semantic segmentation failed',
      details: error instanceof Error ? error.message : 'Unknown error'
    })
  } finally {
    // Clean up temp files after a delay
    setTimeout(async () => {
      try {
        await fs.rm(sessionDir, { recursive: true, force: true })
        console.log(`[SemanticSelect] Cleaned up session ${sessionId}`)
      } catch (e) {
        // Ignore cleanup errors
      }
    }, 60000) // Clean up after 1 minute
  }
})

export { router as semanticSelectRouter }
