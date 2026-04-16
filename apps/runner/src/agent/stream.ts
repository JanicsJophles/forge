import { EventEmitter } from 'node:events'
import type { TaskEvent } from '@forge/shared'

// In-memory map of active task emitters.
// When a task completes/fails the emitter is removed.
const emitters = new Map<string, EventEmitter>()

export function createEmitter(taskId: string): EventEmitter {
  const emitter = new EventEmitter()
  emitter.setMaxListeners(50) // many SSE clients can subscribe to one task
  emitters.set(taskId, emitter)
  return emitter
}

export function getEmitter(taskId: string): EventEmitter | undefined {
  return emitters.get(taskId)
}

export function removeEmitter(taskId: string): void {
  emitters.delete(taskId)
}

export function countActiveEmitters(): number {
  return emitters.size
}

export function makeEvent(type: TaskEvent['type'], data: string): TaskEvent {
  return { type, data, timestamp: new Date().toISOString() }
}
