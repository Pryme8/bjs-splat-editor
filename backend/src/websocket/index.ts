/**
 * WebSocket handler for real-time job progress
 */

import { WebSocketServer, WebSocket } from 'ws'
import type { JobProgress } from '../types/index.js'
import { cancelJob } from '../services/jobManager.js'

// Map of jobId -> Set of WebSocket clients
const jobSubscribers = new Map<string, Set<WebSocket>>()
// Map of WebSocket client -> Set of jobIds they own (created the job)
const clientOwnedJobs = new Map<WebSocket, Set<string>>()
// All connected clients
const allClients = new Set<WebSocket>()

export function setupWebSocket(wss: WebSocketServer): void {
  wss.on('connection', (ws, req) => {
    console.log('[WebSocket] Client connected')
    allClients.add(ws)

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString())
        handleMessage(ws, message)
      } catch (error) {
        console.error('[WebSocket] Failed to parse message:', error)
      }
    })

    ws.on('close', async () => {
      console.log('[WebSocket] Client disconnected')
      allClients.delete(ws)
      
      // Cancel any jobs owned by this client
      const ownedJobs = clientOwnedJobs.get(ws)
      if (ownedJobs && ownedJobs.size > 0) {
        console.log(`[WebSocket] Cancelling ${ownedJobs.size} jobs owned by disconnected client`)
        for (const jobId of ownedJobs) {
          try {
            await cancelJob(jobId)
            console.log(`[WebSocket] Cancelled job ${jobId} due to client disconnect`)
          } catch (e) {
            console.error(`[WebSocket] Failed to cancel job ${jobId}:`, e)
          }
        }
      }
      clientOwnedJobs.delete(ws)
      
      // Remove from all job subscriptions
      for (const subscribers of jobSubscribers.values()) {
        subscribers.delete(ws)
      }
    })

    ws.on('error', (error) => {
      console.error('[WebSocket] Error:', error)
    })

    // Send welcome message
    ws.send(JSON.stringify({
      type: 'connected',
      message: 'Connected to Splat Editor Backend'
    }))
  })
}

function handleMessage(ws: WebSocket, message: any): void {
  switch (message.type) {
    case 'subscribe':
      // Subscribe to job updates
      if (message.jobId) {
        if (!jobSubscribers.has(message.jobId)) {
          jobSubscribers.set(message.jobId, new Set())
        }
        jobSubscribers.get(message.jobId)!.add(ws)
        
        // Also register this client as the job owner (for cancel on disconnect)
        if (!clientOwnedJobs.has(ws)) {
          clientOwnedJobs.set(ws, new Set())
        }
        clientOwnedJobs.get(ws)!.add(message.jobId)
        
        console.log(`[WebSocket] Client subscribed to job ${message.jobId} (owner)`)
        
        ws.send(JSON.stringify({
          type: 'subscribed',
          jobId: message.jobId
        }))
      }
      break

    case 'unsubscribe':
      // Unsubscribe from job updates
      if (message.jobId && jobSubscribers.has(message.jobId)) {
        jobSubscribers.get(message.jobId)!.delete(ws)
        console.log(`[WebSocket] Client unsubscribed from job ${message.jobId}`)
      }
      break

    case 'ping':
      ws.send(JSON.stringify({ type: 'pong' }))
      break

    default:
      console.warn('[WebSocket] Unknown message type:', message.type)
  }
}

export function broadcastProgress(progress: JobProgress): void {
  const message = JSON.stringify({
    type: 'progress',
    ...progress
  })

  // Send to subscribers of this specific job
  const subscribers = jobSubscribers.get(progress.jobId)
  if (subscribers) {
    for (const client of subscribers) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message)
      }
    }
  }

  // Only log significant progress changes (every 5% or status changes)
  // to reduce console spam during training
  const isSignificant = progress.progress % 5 === 0 || 
                         progress.status === 'complete' || 
                         progress.status === 'failed' ||
                         progress.status === 'cancelled'
  if (isSignificant) {
    console.log(`[Progress] Job ${progress.jobId}: ${progress.status} - ${progress.progress}% - ${progress.message}`)
  }
}

export function broadcastToAll(data: any): void {
  const message = JSON.stringify(data)
  for (const client of allClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message)
    }
  }
}

/**
 * Remove job from ownership tracking only (prevents cancel on disconnect)
 * Does NOT remove subscribers - call removeJobSubscribers separately after final message
 */
export function removeJobOwnership(jobId: string): void {
  for (const ownedJobs of clientOwnedJobs.values()) {
    ownedJobs.delete(jobId)
  }
  // NOTE: Don't delete subscribers here - they need to receive the final message first!
}

/**
 * Remove job subscribers (call AFTER sending final complete/failed message)
 */
export function removeJobSubscribers(jobId: string): void {
  jobSubscribers.delete(jobId)
}
