/**
 * Blocking Q&A implementation for ECS agent questions.
 * Maps Discord thread IDs to deferred promises that resolve when an answer arrives.
 */

import type { EcsDiscordChannels } from "./discord-channels.js";
import type { EcsQuestion, EcsQuestionAnswer } from "./types.js";

export type PendingQuestion = {
  question: EcsQuestion;
  projectId?: string;
  resolve: (answer: EcsQuestionAnswer | null) => void;
  timeout: ReturnType<typeof setTimeout>;
  threadId: string;
};

export type QuestionResult = {
  answer: string | null;
  answeredBy?: string;
  timedOut: boolean;
  escalatedToIssues: boolean;
};

export class EcsQuestionRelay {
  /** Keyed by Discord thread ID. */
  private pending = new Map<string, PendingQuestion>();
  /** Keyed by question ID for reverse lookup. */
  private byQuestionId = new Map<string, string>();

  private discord: EcsDiscordChannels;
  private defaultTimeoutMs: number;
  private escalateOnTimeout: boolean;

  constructor(opts: {
    discord: EcsDiscordChannels;
    defaultTimeoutMs: number;
    escalateOnTimeout: boolean;
  }) {
    this.discord = opts.discord;
    this.defaultTimeoutMs = opts.defaultTimeoutMs;
    this.escalateOnTimeout = opts.escalateOnTimeout;
  }

  /**
   * Register a pending question and return a Promise that blocks until answered or timed out.
   * The caller should post the question to Discord first and pass the threadId.
   */
  registerPendingQuestion(
    question: EcsQuestion,
    threadId: string,
    projectId?: string,
  ): Promise<QuestionResult> {
    return new Promise<QuestionResult>((resolve) => {
      const timeoutMs = question.timeoutMs ?? this.defaultTimeoutMs;

      const timeout = setTimeout(async () => {
        this.pending.delete(threadId);
        this.byQuestionId.delete(question.questionId);

        let escalated = false;
        if (this.escalateOnTimeout) {
          await this.discord.postQuestionTimeout(question, projectId);
          escalated = true;
        }

        resolve({
          answer: null,
          timedOut: true,
          escalatedToIssues: escalated,
        });
      }, timeoutMs);

      const entry: PendingQuestion = {
        question,
        projectId,
        resolve: (qAnswer) => {
          clearTimeout(timeout);
          this.pending.delete(threadId);
          this.byQuestionId.delete(question.questionId);

          if (qAnswer) {
            resolve({
              answer: qAnswer.answer,
              answeredBy: qAnswer.answeredBy,
              timedOut: false,
              escalatedToIssues: false,
            });
          } else {
            resolve({
              answer: null,
              timedOut: false,
              escalatedToIssues: false,
            });
          }
        },
        timeout,
        threadId,
      };

      this.pending.set(threadId, entry);
      this.byQuestionId.set(question.questionId, threadId);
    });
  }

  /**
   * Resolve a pending question when a reply is detected in a Discord thread.
   * Called by the message_received hook when a reply arrives in an ECS info thread.
   */
  resolveQuestion(threadId: string, answer: string, answeredBy: string): boolean {
    const entry = this.pending.get(threadId);
    if (!entry) {
      return false;
    }

    entry.resolve({
      questionId: entry.question.questionId,
      answeredBy,
      answer,
      timestamp: Date.now(),
    });
    return true;
  }

  /** Reverse-lookup: get the Discord thread ID for a given question ID. */
  getThreadIdByQuestionId(questionId: string): string | undefined {
    return this.byQuestionId.get(questionId);
  }

  /** Check if a thread ID has a pending question. */
  hasPending(threadId: string): boolean {
    return this.pending.has(threadId);
  }

  /** Get the pending question for a thread. */
  getPending(threadId: string): PendingQuestion | undefined {
    return this.pending.get(threadId);
  }

  /** Cancel all pending questions (e.g., on shutdown). */
  cancelAll(): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timeout);
      entry.resolve(null);
    }
    this.pending.clear();
    this.byQuestionId.clear();
  }

  pendingCount(): number {
    return this.pending.size;
  }
}
