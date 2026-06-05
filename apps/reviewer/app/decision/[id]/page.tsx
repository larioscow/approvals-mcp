import { DecisionNotFoundError } from '@approvals-mcp/core';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { cancel } from '@/app/actions';
import { riskStyle, statusStyle, timeAgo } from '@/lib/format';
import { getService } from '@/lib/service';

export const dynamic = 'force-dynamic';

export default async function DecisionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const service = await getService();

  const decision = await service.get(id).catch((err: unknown) => {
    if (err instanceof DecisionNotFoundError) notFound();
    throw err;
  });

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <Link href="/" className="text-sm text-slate-500 hover:underline">
        ← Back to queue
      </Link>

      <header className="mt-4 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">{decision.action.summary}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 text-xs text-slate-500">
            <span className="font-mono">{decision.action.kind}</span>
            <span className={riskStyle(decision.action.riskTier)}>
              {decision.action.riskTier} risk
            </span>
            <span className="font-mono text-slate-400">{decision.id}</span>
          </div>
        </div>
        <span
          className={`rounded-full px-2.5 py-1 text-xs font-medium ring-1 ${statusStyle(decision.status)}`}
        >
          {decision.status}
        </span>
      </header>

      {decision.status === 'pending' && (
        <form className="mt-4">
          <input type="hidden" name="id" value={decision.id} />
          <button
            type="submit"
            formAction={cancel}
            className="rounded-md bg-white px-3 py-1.5 text-sm font-medium text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50"
          >
            Cancel request
          </button>
        </form>
      )}

      <section className="mt-8">
        <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">Payload</h2>
        <pre className="overflow-x-auto rounded-lg border border-slate-200 bg-white p-4 text-xs text-slate-700">
          {JSON.stringify(decision.action.payload, null, 2)}
        </pre>
      </section>

      <section className="mt-8">
        <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">
          Audit trail
        </h2>
        <ol className="space-y-2">
          {decision.audit.map((event) => (
            <li
              key={`${event.type}-${event.at}-${event.actor}`}
              className="flex items-baseline justify-between gap-4 rounded-md border border-slate-100 bg-white px-3 py-2 text-sm"
            >
              <div>
                <span className="font-medium">{event.type.replace(/_/g, ' ')}</span>
                {event.detail && <span className="ml-2 text-slate-500">{event.detail}</span>}
              </div>
              <div className="shrink-0 text-xs text-slate-400">
                {event.actor} · {timeAgo(event.at)}
              </div>
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}
