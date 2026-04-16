/** Core ECS type definitions for task management and inter-agent communication. */

export type EcsTaskPriority = "low" | "medium" | "high" | "critical";

export type EcsTaskStatus = "accepted" | "running" | "blocked" | "complete" | "error";

export type EcsIssueSeverity = "warn" | "error" | "critical";

export type EcsTask = {
  taskId: string;
  epicId?: string;
  projectId?: string;
  title: string;
  description: string;
  assignedAgentId?: string;
  dependencies?: string[];
  priority: EcsTaskPriority;
  deadline?: string;
  metadata?: Record<string, unknown>;
  persona?: string;
  idempotencyKey?: string;
  /** Teams channel ID from the control plane (venture channel where the task was dispatched). */
  teamsChannelId?: string;
  /** Teams thread ID from the control plane's dispatch notification. */
  teamsThreadId?: string;
};

export type EcsTaskAck = {
  taskId: string;
  status: "accepted" | "rejected";
  agentSessionKey?: string;
  runId?: string;
  reason?: string;
};

export type EcsTaskCompletion = {
  taskId: string;
  agentId?: string;
  status: "complete" | "error" | "cancelled";
  summary: string;
  artifacts?: string[];
  durationMs: number;
  threadId?: string;
};

export type EcsStatusUpdate = {
  taskId: string;
  agentId?: string;
  status: EcsTaskStatus;
  progressPct?: number;
  summary: string;
  details?: string;
  timestamp: number;
};

export type EcsQuestion = {
  questionId: string;
  fromAgentId?: string;
  toAgentId?: string;
  taskId: string;
  question: string;
  context?: string;
  timeoutMs?: number;
};

export type EcsQuestionAnswer = {
  questionId: string;
  answeredBy: string;
  answer: string;
  timestamp: number;
};

export type EcsIssue = {
  issueId: string;
  taskId: string;
  agentId?: string;
  severity: EcsIssueSeverity;
  title: string;
  description: string;
  attempted: string[];
  needsHuman: boolean;
};

/** Runtime tracking state for an active ECS task. */
export type EcsActiveTask = {
  task: EcsTask;
  sessionKey: string;
  runId?: string;
  agentId?: string;
  status: EcsTaskStatus;
  discordThreadId?: string;
  teamsMessageId?: string;
  /** The Teams channel ID for this task (venture channel, if any). */
  teamsChannelId?: string;
  /** All Teams thread/message IDs indexed for this task (for cleanup). */
  teamsMessageIds?: string[];
  /**
   * Outbound replies to this Teams thread have returned 404. Inbound lookups
   * still resolve to this task so human replies keep routing, but outbound
   * helpers should fall back to root posts or skip thread acks.
   */
  teamsThreadIsDead?: boolean;
  startedAt: number;
  lastStatusUpdate?: number;
};
