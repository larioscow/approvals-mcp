import type { DecisionStatus } from '@approvals-mcp/core';

const STATUS_STYLES: Record<DecisionStatus, string> = {
  pending: 'bg-amber-100 text-amber-800 ring-amber-200',
  approved: 'bg-blue-100 text-blue-800 ring-blue-200',
  executing: 'bg-blue-100 text-blue-800 ring-blue-200',
  executed: 'bg-emerald-100 text-emerald-800 ring-emerald-200',
  rejected: 'bg-rose-100 text-rose-800 ring-rose-200',
  failed: 'bg-rose-100 text-rose-800 ring-rose-200',
  cancelled: 'bg-slate-100 text-slate-600 ring-slate-200',
  expired: 'bg-slate-100 text-slate-600 ring-slate-200',
};

export function statusStyle(status: DecisionStatus): string {
  return STATUS_STYLES[status];
}

const RISK_STYLES: Record<string, string> = {
  low: 'text-slate-500',
  medium: 'text-amber-600',
  high: 'text-rose-600',
};

export function riskStyle(tier: string): string {
  return RISK_STYLES[tier] ?? 'text-slate-500';
}

export function timeAgo(ms: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
