import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { logger } from '../util/logger.js';

export interface SessionState {
  sessionId: string;
  projectId: string;
  startedAt: string;
  lastActiveAt: string;
  completedTasks: string[];
  failedTasks: string[];
  agentSessions: Record<string, string>; // agentId -> Claude session ID
  totalCostUsd: number;
  status: 'running' | 'paused' | 'completed' | 'failed';
}

/**
 * Manages orchestration session state for resume capability.
 * Persists session state to disk so interrupted runs can be resumed.
 */
export class SessionManager {
  private sessionDir: string;

  constructor(rootPath: string) {
    this.sessionDir = resolve(rootPath, '.orchestrator', 'sessions');
    mkdirSync(this.sessionDir, { recursive: true });
  }

  /**
   * Create a new session.
   */
  create(projectId: string): SessionState {
    const session: SessionState = {
      sessionId: `session_${Date.now()}`,
      projectId,
      startedAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      completedTasks: [],
      failedTasks: [],
      agentSessions: {},
      totalCostUsd: 0,
      status: 'running',
    };

    this.save(session);
    logger.info({ sessionId: session.sessionId }, 'Session created');
    return session;
  }

  /**
   * Save session state to disk.
   */
  save(session: SessionState): void {
    const filePath = this.getSessionPath(session.sessionId);
    session.lastActiveAt = new Date().toISOString();
    writeFileSync(filePath, JSON.stringify(session, null, 2), 'utf-8');
  }

  /**
   * Load a session by ID.
   */
  load(sessionId: string): SessionState | null {
    const filePath = this.getSessionPath(sessionId);
    if (!existsSync(filePath)) return null;

    try {
      const raw = readFileSync(filePath, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /**
   * Get the latest session for a project.
   */
  getLatest(projectId: string): SessionState | null {
    const { readdirSync } = require('node:fs');
    try {
      const files = readdirSync(this.sessionDir) as string[];
      const sessions = files
        .filter((f: string) => f.endsWith('.json'))
        .map((f: string) => {
          try {
            const raw = readFileSync(resolve(this.sessionDir, f), 'utf-8');
            return JSON.parse(raw) as SessionState;
          } catch {
            return null;
          }
        })
        .filter((s): s is SessionState => s !== null && s.projectId === projectId)
        .sort((a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime());

      return sessions[0] ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Mark a task as completed in the session.
   */
  markTaskCompleted(session: SessionState, taskId: string, costUsd: number): void {
    session.completedTasks.push(taskId);
    session.totalCostUsd += costUsd;
    this.save(session);
  }

  /**
   * Mark a task as failed in the session.
   */
  markTaskFailed(session: SessionState, taskId: string): void {
    session.failedTasks.push(taskId);
    this.save(session);
  }

  /**
   * Store an agent's Claude session ID for resume.
   */
  storeAgentSession(session: SessionState, agentId: string, claudeSessionId: string): void {
    session.agentSessions[agentId] = claudeSessionId;
    this.save(session);
  }

  /**
   * Complete the session.
   */
  complete(session: SessionState): void {
    session.status = 'completed';
    this.save(session);
    logger.info({ sessionId: session.sessionId }, 'Session completed');
  }

  /**
   * Pause the session (for resume later).
   */
  pause(session: SessionState): void {
    session.status = 'paused';
    this.save(session);
    logger.info({ sessionId: session.sessionId }, 'Session paused');
  }

  private getSessionPath(sessionId: string): string {
    return resolve(this.sessionDir, `${sessionId}.json`);
  }
}
