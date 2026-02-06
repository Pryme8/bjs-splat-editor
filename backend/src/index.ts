/**
 * Splat Editor Backend - Main Entry Point
 * Real photogrammetry server for Gaussian Splat generation
 */

import express from 'express'
import cors from 'cors'
import { createServer } from 'http'
import { WebSocketServer } from 'ws'
import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'

import { jobsRouter } from './routes/jobs.js'
import { healthRouter } from './routes/health.js'
import { setupWebSocket } from './websocket/index.js'
import { initializeJobQueue } from './services/jobQueue.js'
import { setupConsoleLogging } from './services/consoleLogger.js'

// Load environment variables
dotenv.config()

// Initialize console logging early to capture all output
setupConsoleLogging()

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = process.env.PORT || 4270

// Create Express app
const app = express()
const server = createServer(app)

// Middleware
app.use(cors({
  origin: ['http://localhost:4269', 'http://localhost:5173', 'http://127.0.0.1:4269'],
  credentials: true
}))
app.use(express.json())

// Static files for results
app.use('/results', express.static(path.join(__dirname, '../data/results')))

// Routes
app.use('/api/health', healthRouter)
app.use('/api/jobs', jobsRouter)

// WebSocket server for real-time progress
const wss = new WebSocketServer({ server, path: '/ws' })
setupWebSocket(wss)

// Initialize job queue
initializeJobQueue().then(() => {
  console.log('[Backend] Job queue initialized')
}).catch(err => {
  console.error('[Backend] Failed to initialize job queue:', err)
})

// Start server
server.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║           Splat Editor Backend Server                      ║
╠═══════════════════════════════════════════════════════════╣
║  REST API:    http://localhost:${PORT}/api                   ║
║  WebSocket:   ws://localhost:${PORT}/ws                      ║
║  Health:      http://localhost:${PORT}/api/health            ║
╠═══════════════════════════════════════════════════════════╣
║  Training Modes Available:                                 ║
║  • Replicate API (fast, cloud GPU)                        ║
║  • CPU Training (slow, local)                             ║
╚═══════════════════════════════════════════════════════════╝
  `)
})

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[Backend] SIGTERM received, shutting down...')
  server.close(() => {
    console.log('[Backend] Server closed')
    process.exit(0)
  })
})
