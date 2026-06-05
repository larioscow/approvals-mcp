import type { Decision } from '@approvals-mcp/core';
import Link from 'next/link';
import { riskStyle, statusStyle, timeAgo } from '@/lib/format';
import { getService } from '@/lib/service';
import { approve, reject } from './actions';

export const dynamic = 'force-dynamic';

const DECIDED = [
  'approved',
  'executing',
  'executed',
  'rejected',
  'failed',
  'cancelled',
  'expired',
] as const;

export default async function InboxPage() {
  const service = await getService();
  const pending = await service.listPending({ limit: 50 });
  const recent = await service.list({ status: [...DECIDED], limit: 25 });
  const recentItems = [...recent.items].reverse();

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <header className="mb-8">
        <h1 className="text-xl font-semibold tracking-tight">Approvals</h1>
        <p className="mt-1 text-sm text-slate-500">
          Actions an agent proposed, awaiting a human decision.
        </p>
      </header>

      <section>
        <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-slate-400">
          Pending · {pending.total}
        </h2>
        {pending.items.length === 0 ? (
          <p className="rounded-lg border border-dashed border-slate-200 px-4 py-8 text-center text-sm text-slate-400">
            Nothing waiting. Approved actions execute on the agent side.
          </p>
        ) : (
          <ul className="space-y-3">
            {pending.items.map((d) => (
              <li key={d.id} className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <Link href={`/decision/${d.id}`} className="font-medium hover:underline">
                      {d.action.summary}
                    </Link>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                      <span className="font-mono">{d.action.kind}</span>
                      <span className={riskStyle(d.action.riskTier)}>{d.action.riskTier} risk</span>
                      <span>{timeAgo(d.createdAt)}</span>
                    </div>
                  </div>
                </div>
                <form className="mt-3 flex flex-wrap items-center gap-2">
                  <input type="hidden" name="id" value={d.id} />
                  <input
                    name="reason"
                    placeholder="reason (optional)"
                    className="min-w-0 flex-1 rounded-md border border-slate-200 px-2.5 py-1.5 text-sm outline-none focus:border-slate-400"
                  />
                  <button
                    type="submit"
                    formAction={approve}
                    className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700"
                  >
                    Approve
                  </button>
                  <button
                    type="submit"
                    formAction={reject}
                    className="rounded-md bg-white px-3 py-1.5 text-sm font-medium text-rose-700 ring-1 ring-rose-200 hover:bg-rose-50"
                  >
                    Reject
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </section>

      {recentItems.length > 0 && (
        <section className="mt-10">
          <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-slate-400">
            Recently decided
          </h2>
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
            {recentItems.map((d: Decision) => (
              <li key={d.id} className="flex items-center justify-between gap-4 px-4 py-3 text-sm">
                <Link href={`/decision/${d.id}`} className="min-w-0 truncate hover:underline">
                  {d.action.summary}
                </Link>
                <div className="flex shrink-0 items-center gap-3 text-xs text-slate-400">
                  {d.decidedBy && <span>{d.decidedBy}</span>}
                  <span
                    className={`rounded-full px-2 py-0.5 font-medium ring-1 ${statusStyle(d.status)}`}
                  >
                    {d.status}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
