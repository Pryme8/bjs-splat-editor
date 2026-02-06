/**
 * Console Logger Service
 * 
 * Intercepts console.log/warn/error and broadcasts them to connected WebSocket clients.
 * Maintains a circular buffer of the last 200 messages.
 */

export type LogLevel = 'info' | 'warn' | 'error'

export interface ConsoleMessage {
  timestamp: number
  level: LogLevel
  message: string
  source?: string  // Parsed from [TAG] prefix
}

// Circular buffer of messages
const MAX_MESSAGES = 200
const messageBuffer: ConsoleMessage[] = []

// Broadcast callback - set by websocket module to avoid circular deps
let broadcastFn: ((msg: ConsoleMessage) => void) | null = null

// Original console methods
const originalLog = console.log.bind(console)
const originalWarn = console.warn.bind(console)
const originalError = console.error.bind(console)

// Throttling for rapid messages
let pendingMessages: ConsoleMessage[] = []
let flushTimeout: NodeJS.Timeout | null = null
const FLUSH_INTERVAL_MS = 100  // Batch messages every 100ms

/**
 * Parse source tag from message (e.g., "[COLMAP] message" -> source: "COLMAP")
 */
function parseSource(message: string): { source?: string; cleanMessage: string } {
  const match = message.match(/^\[([A-Za-z0-9_-]+)\]\s*(.*)$/)
  if (match) {
    return { source: match[1], cleanMessage: match[2] }
  }
  return { cleanMessage: message }
}

/**
 * Format arguments to string (similar to how console.log works)
 */
function formatArgs(args: any[]): string {
  return args.map(arg => {
    if (typeof arg === 'string') return arg
    if (arg instanceof Error) return `${arg.name}: ${arg.message}`
    try {
      return JSON.stringify(arg)
    } catch {
      return String(arg)
    }
  }).join(' ')
}

/**
 * Add message to buffer and queue for broadcast
 */
function addMessage(level: LogLevel, args: any[]): void {
  const rawMessage = formatArgs(args)
  const { source, cleanMessage } = parseSource(rawMessage)
  
  const msg: ConsoleMessage = {
    timestamp: Date.now(),
    level,
    message: cleanMessage,
    source
  }
  
  // Add to circular buffer
  messageBuffer.push(msg)
  if (messageBuffer.length > MAX_MESSAGES) {
    messageBuffer.shift()
  }
  
  // Queue for broadcast (throttled)
  if (broadcastFn) {
    pendingMessages.push(msg)
    scheduleFlush()
  }
}

/**
 * Schedule flush of pending messages
 */
function scheduleFlush(): void {
  if (flushTimeout) return
  
  flushTimeout = setTimeout(() => {
    flushTimeout = null
    if (broadcastFn && pendingMessages.length > 0) {
      // Send all pending messages
      for (const msg of pendingMessages) {
        broadcastFn(msg)
      }
      pendingMessages = []
    }
  }, FLUSH_INTERVAL_MS)
}

/**
 * Set the broadcast function (called by websocket module)
 */
export function setBroadcastFunction(fn: (msg: ConsoleMessage) => void): void {
  broadcastFn = fn
}

/**
 * Get the message buffer (for sending history to new subscribers)
 */
export function getMessageBuffer(): ConsoleMessage[] {
  return [...messageBuffer]
}

/**
 * Initialize console interception
 */
export function setupConsoleLogging(): void {
  console.log = (...args: any[]) => {
    originalLog(...args)
    addMessage('info', args)
  }
  
  console.warn = (...args: any[]) => {
    originalWarn(...args)
    addMessage('warn', args)
  }
  
  console.error = (...args: any[]) => {
    originalError(...args)
    addMessage('error', args)
  }
  
  originalLog('[ConsoleLogger] Console logging initialized')
}

/**
 * Clear the message buffer
 */
export function clearMessageBuffer(): void {
  messageBuffer.length = 0
}
