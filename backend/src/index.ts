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
import { semanticSelectRouter } from './routes/semanticSelect.js'
import { setupWebSocket, closeAllConnections } from './websocket/index.js'
import { initializeJobQueue } from './services/jobQueue.js'
import { setupConsoleLogging } from './services/consoleLogger.js'
import { killAllProcesses } from './services/processTracker.js'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

// Load environment variables
dotenv.config()

// Initialize console logging early to capture all output
setupConsoleLogging()

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = process.env.PORT || 4270

/**
 * Check if port is in use and kill the process using it
 */
async function ensurePortFree(port: number): Promise<void> {
  try {
    if (process.platform === 'win32') {
      // Windows: Use netstat to find process using the port
      const { stdout } = await execAsync(`netstat -ano | findstr :${port}`)
      const lines = stdout.trim().split('\n')
      const pids = new Set<number>()
      
      for (const line of lines) {
        const match = line.match(/LISTENING\s+(\d+)/)
        if (match) {
          pids.add(parseInt(match[1]))
        }
      }
      
      if (pids.size > 0) {
        console.log(`[Backend] Port ${port} is in use by ${pids.size} process(es), cleaning up...`)
        for (const pid of pids) {
          try {
            await execAsync(`taskkill /PID ${pid} /F`)
            console.log(`[Backend] Killed process ${pid}`)
          } catch (e) {
            // Process might have already exited
          }
        }
        // Wait a bit for port to be released
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
    } else {
      // Unix/Linux/Mac: Use lsof
      try {
        const { stdout } = await execAsync(`lsof -ti:${port}`)
        const pids = stdout.trim().split('\n').filter(p => p)
        if (pids.length > 0) {
          console.log(`[Backend] Port ${port} is in use, cleaning up...`)
          for (const pid of pids) {
            await execAsync(`kill -9 ${pid}`)
            console.log(`[Backend] Killed process ${pid}`)
          }
          await new Promise(resolve => setTimeout(resolve, 1000))
        }
      } catch (e) {
        // lsof returns non-zero if no process found, which is fine
      }
    }
  } catch (error) {
    // If checks fail, just try to start anyway
    console.warn('[Backend] Port check failed, attempting to start anyway:', error)
  }
}

// Create Express app
const app = express()
const server = createServer(app)

// Middleware
app.use(cors({
  origin: ['http://localhost:4269', 'http://localhost:5173', 'http://127.0.0.1:4269'],
  credentials: true
}))
app.use(express.json({ limit: '100mb' }))

// Static files for results
app.use('/results', express.static(path.join(__dirname, '../data/results')))

// Routes
app.use('/api/health', healthRouter)
app.use('/api/jobs', jobsRouter)
app.use('/api/semantic-select', semanticSelectRouter)

// WebSocket server for real-time progress
const wss = new WebSocketServer({ server, path: '/ws' })
setupWebSocket(wss)

// Initialize job queue
initializeJobQueue().then(() => {
  console.log('[Backend] Job queue initialized')
}).catch(err => {
  console.error('[Backend] Failed to initialize job queue:', err)
})

// Ensure port is free before starting
ensurePortFree(PORT as number).then(() => {
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
}).catch(err => {
  console.error('[Backend] Failed to ensure port is free:', err)
  process.exit(1)
})

// Graceful shutdown handler
let isShuttingDown = false

async function gracefulShutdown(signal: string) {
  if (isShuttingDown) {
    console.log('[Backend] Already shutting down, please wait...')
    return
  }
  
  isShuttingDown = true
  console.log(`\n[Backend] ${signal} received, shutting down gracefully...`)
  
  try {
    // 1. Stop accepting new connections
    console.log('[Backend] Closing HTTP server...')
    server.close(() => {
      console.log('[Backend] HTTP server closed')
    })
    
    // 2. Close all WebSocket connections
    console.log('[Backend] Closing WebSocket connections...')
    closeAllConnections()
    
    // 3. Kill all running child processes
    console.log('[Backend] Killing all child processes...')
    const killed = killAllProcesses()
    console.log(`[Backend] Killed ${killed} process trees`)
    
    // 4. Wait a bit for processes to clean up
    await new Promise(resolve => setTimeout(resolve, 1000))
    
    console.log('[Backend] Shutdown complete')
    process.exit(0)
  } catch (error) {
    console.error('[Backend] Error during shutdown:', error)
    process.exit(1)
  }
}

// Handle various shutdown signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))  // Ctrl+C

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error('[Backend] Uncaught Exception:', error)
  gracefulShutdown('UNCAUGHT_EXCEPTION')
})

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Backend] Unhandled Rejection at:', promise, 'reason:', reason)
})
