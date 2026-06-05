'use server';

import { InvalidTransitionError } from '@approvals-mcp/core';
import { revalidatePath } from 'next/cache';
import { getService } from '@/lib/service';

function field(form: FormData, name: string): string {
  return String(form.get(name) ?? '').trim();
}

async function decide(form: FormData, verb: 'approve' | 'reject' | 'cancel'): Promise<void> {
  const id = field(form, 'id');
  if (!id) return;
  const reviewer = field(form, 'reviewer') || 'reviewer';
  const reason = field(form, 'reason');
  const service = await getService();
  try {
    if (verb === 'approve') await service.approve(id, { reviewer, ...(reason ? { reason } : {}) });
    else if (verb === 'reject')
      await service.reject(id, { reviewer, ...(reason ? { reason } : {}) });
    else await service.cancel(id, { actor: reviewer, ...(reason ? { reason } : {}) });
  } catch (err) {
    // A concurrent decision already moved it; refreshing shows the truth.
    if (!(err instanceof InvalidTransitionError)) throw err;
  }
  revalidatePath('/');
  revalidatePath(`/decision/${id}`);
}

export async function approve(form: FormData): Promise<void> {
  await decide(form, 'approve');
}

export async function reject(form: FormData): Promise<void> {
  await decide(form, 'reject');
}

export async function cancel(form: FormData): Promise<void> {
  await decide(form, 'cancel');
}
