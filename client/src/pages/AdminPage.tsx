import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  REPORT_REASONS,
  type AdminBan,
  type AdminReport,
  type AdminStats,
  type ReportStatus,
} from '../../../shared/protocol';
import { Header } from '../components/Layout';
import { Button, cx, Modal, Spinner } from '../components/ui';
import { api, ApiError } from '../lib/api';

const STATUS_LABEL: Record<ReportStatus, string> = {
  open: 'Новая',
  reviewing: 'На проверке',
  resolved: 'Решена',
  dismissed: 'Отклонена',
};
const STATUS_STYLE: Record<ReportStatus, string> = {
  open: 'bg-amber-500/15 text-amber-500',
  reviewing: 'bg-sky-500/15 text-sky-500',
  resolved: 'bg-success/15 text-success',
  dismissed: 'bg-surface-2 text-muted',
};
const reasonLabel = (code: string) => REPORT_REASONS.find((r) => r.code === code)?.label ?? code;
const dt = (ts: number) => new Date(ts).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });

function Login({ onLogin }: { onLogin: (name: string) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ username: string }>('/api/admin/login', { method: 'POST', body: { username, password } });
      onLogin(r.username);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Ошибка входа');
    } finally {
      setBusy(false);
    }
  };
  const input = 'w-full rounded-xl border border-line bg-surface-2 px-4 py-3 outline-none focus:border-accent';
  return (
    <form onSubmit={submit} className="mx-auto mt-16 w-full max-w-sm space-y-4 rounded-3xl border border-line bg-surface p-7">
      <h1 className="text-2xl font-bold">Вход для модераторов</h1>
      <input className={input} placeholder="Логин" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
      <input
        className={input}
        placeholder="Пароль"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      {error && <p className="rounded-xl bg-danger/15 px-3 py-2 text-sm text-danger">{error}</p>}
      <Button type="submit" variant="primary" className="w-full" disabled={busy || !username || !password}>
        {busy ? <Spinner /> : 'Войти'}
      </Button>
    </form>
  );
}

function StatCard({ label, value, accent }: { label: string; value: number | string; accent?: boolean }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-4">
      <div className="text-sm text-muted">{label}</div>
      <div className={cx('mt-1 text-2xl font-bold tabular-nums', accent && 'text-accent')}>{value}</div>
    </div>
  );
}

function BanDialog({ report, onClose, onDone }: { report: AdminReport | null; onClose: () => void; onDone: () => void }) {
  const [hours, setHours] = useState<string>('24');
  const [network, setNetwork] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (report) {
      setReason(reasonLabel(report.reason));
      setHours('24');
      setNetwork(false);
      setError(null);
    }
  }, [report]);
  const submit = async () => {
    if (!report) return;
    try {
      await api(`/api/admin/reports/${report.id}/ban`, {
        method: 'POST',
        body: { hours: hours === 'forever' ? null : Number(hours), network, reason },
      });
      onDone();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Ошибка');
    }
  };
  const field = 'w-full rounded-xl border border-line bg-surface-2 px-3.5 py-2.5 outline-none focus:border-accent';
  return (
    <Modal open={Boolean(report)} onClose={onClose} title={`Бан пользователя ${report?.reportedId ?? ''}`}>
      <div className="space-y-4">
        <label className="block">
          <span className="mb-1.5 block text-sm text-muted">Срок</span>
          <select className={field} value={hours} onChange={(e) => setHours(e.target.value)}>
            <option value="1">1 час</option>
            <option value="24">24 часа</option>
            <option value="168">7 дней</option>
            <option value="720">30 дней</option>
            <option value="forever">Навсегда</option>
          </select>
        </label>
        <label className="block">
          <span className="mb-1.5 block text-sm text-muted">Причина (увидит пользователь)</span>
          <input className={field} value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} />
        </label>
        <label className="flex items-start gap-3 text-sm">
          <input type="checkbox" className="mt-0.5 size-4" checked={network} onChange={(e) => setNetwork(e.target.checked)} />
          <span>
            Также заблокировать сеть (по хешу IP). Эффективно против обхода через очистку cookie, но может задеть других
            людей за тем же роутером или мобильным оператором.
          </span>
        </label>
        {error && <p className="text-sm text-danger">{error}</p>}
        <Button variant="danger" className="w-full" disabled={reason.trim().length < 3} onClick={submit}>
          Заблокировать
        </Button>
      </div>
    </Modal>
  );
}

function Dashboard({ username, onLogout }: { username: string; onLogout: () => void }) {
  const [tab, setTab] = useState<'reports' | 'bans'>('reports');
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [filter, setFilter] = useState<ReportStatus | ''>('open');
  const [page, setPage] = useState(0);
  const [reports, setReports] = useState<{ items: AdminReport[]; total: number; pageSize: number } | null>(null);
  const [bans, setBans] = useState<AdminBan[]>([]);
  const [banTarget, setBanTarget] = useState<AdminReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const guard = useCallback(
    async (fn: () => Promise<void>) => {
      try {
        setError(null);
        await fn();
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return onLogout();
        setError(err instanceof Error ? err.message : 'Ошибка');
      }
    },
    [onLogout],
  );

  const refresh = useCallback(
    () =>
      guard(async () => {
        const q = new URLSearchParams({ page: String(page) });
        if (filter) q.set('status', filter);
        const [s, r, b] = await Promise.all([
          api<AdminStats>('/api/admin/stats'),
          api<{ items: AdminReport[]; total: number; pageSize: number }>(`/api/admin/reports?${q}`),
          api<{ items: AdminBan[] }>('/api/admin/bans'),
        ]);
        setStats(s);
        setReports(r);
        setBans(b.items);
      }),
    [guard, page, filter],
  );

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(id);
  }, [refresh]);

  const setStatus = (id: number, status: ReportStatus) =>
    guard(async () => {
      await api(`/api/admin/reports/${id}`, { method: 'PATCH', body: { status } });
      await refresh();
    });

  const unban = (id: number) =>
    guard(async () => {
      await api(`/api/admin/bans/${id}`, { method: 'DELETE' });
      await refresh();
    });

  const logout = async () => {
    await api('/api/admin/logout', { method: 'POST' }).catch(() => undefined);
    onLogout();
  };

  const pages = reports ? Math.max(1, Math.ceil(reports.total / reports.pageSize)) : 1;

  return (
    <div className="mx-auto max-w-6xl px-4 pb-16">
      <div className="mt-2 mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Модерация</h1>
        <div className="flex items-center gap-3 text-sm text-muted">
          {username}
          <Button size="sm" onClick={logout}>
            Выйти
          </Button>
        </div>
      </div>

      {stats && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
          <StatCard label="Онлайн" value={stats.online} accent />
          <StatCard label="В поиске" value={stats.searching} />
          <StatCard label="Разговоров сейчас" value={stats.activeRooms} />
          <StatCard label="Разговоров сегодня" value={stats.roomsToday} />
          <StatCard label="За 7 дней" value={stats.rooms7d} />
          <StatCard label="Новых жалоб" value={stats.reportsOpen} accent={stats.reportsOpen > 0} />
          <StatCard label="Жалоб сегодня" value={stats.reportsToday} />
          <StatCard label="Активных банов" value={stats.activeBans} />
        </div>
      )}

      {error && <p className="mt-4 rounded-xl bg-danger/15 px-4 py-3 text-danger">{error}</p>}

      <div className="mt-8 flex gap-2 border-b border-line">
        {(['reports', 'bans'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cx('-mb-px border-b-2 px-4 py-2.5 font-medium', tab === t ? 'border-accent text-fg' : 'border-transparent text-muted')}
          >
            {t === 'reports' ? 'Жалобы' : `Баны (${bans.length})`}
          </button>
        ))}
      </div>

      {tab === 'reports' && (
        <section className="mt-4">
          <div className="mb-4 flex flex-wrap gap-2">
            {(['open', 'reviewing', 'resolved', 'dismissed', ''] as const).map((s) => (
              <button
                key={s || 'all'}
                type="button"
                onClick={() => {
                  setFilter(s);
                  setPage(0);
                }}
                className={cx('rounded-full px-3.5 py-1.5 text-sm', filter === s ? 'bg-accent text-white' : 'bg-surface-2 text-muted')}
              >
                {s ? STATUS_LABEL[s] : 'Все'}
              </button>
            ))}
          </div>
          {!reports ? (
            <Spinner />
          ) : reports.items.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-line p-10 text-center text-muted">Жалоб нет</p>
          ) : (
            <div className="space-y-3">
              {reports.items.map((r) => (
                <article key={r.id} className="rounded-2xl border border-line bg-surface p-4">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className={cx('rounded-full px-2.5 py-0.5 font-medium', STATUS_STYLE[r.status])}>{STATUS_LABEL[r.status]}</span>
                    <span className="font-semibold">{reasonLabel(r.reason)}</span>
                    <span className="text-muted">· #{r.id} · {dt(r.createdAt)}</span>
                    {r.reportedBanned && <span className="rounded-full bg-danger/15 px-2.5 py-0.5 text-danger">забанен</span>}
                  </div>
                  <div className="mt-2 text-sm text-muted">
                    На пользователя <code className="text-fg">{r.reportedId}</code> от <code>{r.reporterId}</code> · жалоб от разных людей за 30 дней:{' '}
                    <b className={r.reportedTotal > 1 ? 'text-danger' : 'text-fg'}>{r.reportedTotal}</b>
                  </div>
                  {r.details && <p className="mt-2 rounded-xl bg-surface-2 px-3 py-2 text-sm whitespace-pre-wrap">{r.details}</p>}
                  {r.handledBy && <p className="mt-2 text-xs text-muted">Обработал: {r.handledBy}</p>}
                  <div className="mt-3 flex flex-wrap gap-2">
                    {r.status !== 'reviewing' && r.status === 'open' && (
                      <Button size="sm" onClick={() => setStatus(r.id, 'reviewing')}>
                        Взять в работу
                      </Button>
                    )}
                    {r.status !== 'resolved' && (
                      <Button size="sm" onClick={() => setStatus(r.id, 'resolved')}>
                        Решена
                      </Button>
                    )}
                    {r.status !== 'dismissed' && (
                      <Button size="sm" variant="ghost" onClick={() => setStatus(r.id, 'dismissed')}>
                        Отклонить
                      </Button>
                    )}
                    {!r.reportedBanned && (
                      <Button size="sm" variant="danger" onClick={() => setBanTarget(r)}>
                        Забанить
                      </Button>
                    )}
                  </div>
                </article>
              ))}
            </div>
          )}
          {pages > 1 && (
            <div className="mt-4 flex items-center justify-center gap-3">
              <Button size="sm" disabled={page === 0} onClick={() => setPage(page - 1)}>
                ←
              </Button>
              <span className="text-sm text-muted">
                {page + 1} / {pages}
              </span>
              <Button size="sm" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>
                →
              </Button>
            </div>
          )}
        </section>
      )}

      {tab === 'bans' && (
        <section className="mt-4 space-y-3">
          {bans.length === 0 && <p className="rounded-2xl border border-dashed border-line p-10 text-center text-muted">Активных банов нет</p>}
          {bans.map((b) => (
            <div key={b.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-surface p-4">
              <div className="text-sm">
                <div className="font-semibold">
                  {b.guestId ? <code>{b.guestId}</code> : 'Сеть'} {b.byNetwork && <span className="text-muted">+ сеть</span>}
                </div>
                <div className="text-muted">
                  {b.reason} · {b.createdBy === 'auto' ? 'автоматически' : b.createdBy} · {dt(b.createdAt)} →{' '}
                  {b.expiresAt ? dt(b.expiresAt) : 'навсегда'}
                </div>
              </div>
              <Button size="sm" onClick={() => unban(b.id)}>
                Снять бан
              </Button>
            </div>
          ))}
        </section>
      )}

      <BanDialog report={banTarget} onClose={() => setBanTarget(null)} onDone={() => void refresh()} />
    </div>
  );
}

export function AdminPage({ appName }: { appName: string }) {
  const [user, setUser] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    api<{ username: string }>('/api/admin/me').then(
      (r) => setUser(r.username),
      () => setUser(null),
    );
  }, []);
  return (
    <div className="min-h-full">
      <Header appName={appName} online={null} />
      {user === undefined ? (
        <div className="grid place-items-center pt-24">
          <Spinner />
        </div>
      ) : user === null ? (
        <Login onLogin={setUser} />
      ) : (
        <Dashboard username={user} onLogout={() => setUser(null)} />
      )}
    </div>
  );
}
