import type { DecisionStatus } from './types';

export class ApprovalError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'ApprovalError';
    this.code = code;
  }
}

export class DecisionNotFoundError extends ApprovalError {
  constructor(id: string) {
    super(`No decision with id ${id}`, 'decision_not_found');
    this.name = 'DecisionNotFoundError';
  }
}

export class UnknownActionKindError extends ApprovalError {
  constructor(kind: string) {
    super(`No executor registered for action kind '${kind}'`, 'unknown_action_kind');
    this.name = 'UnknownActionKindError';
  }
}

export class InvalidTransitionError extends ApprovalError {
  constructor(from: DecisionStatus, attempted: string) {
    super(`Cannot ${attempted} a decision that is '${from}'`, 'invalid_transition');
    this.name = 'InvalidTransitionError';
  }
}
