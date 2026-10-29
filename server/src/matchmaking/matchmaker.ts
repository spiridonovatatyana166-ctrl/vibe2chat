import type { LanguageCode } from '../../../shared/protocol.js';

export interface QueueEntry {
  guestId: string;
  language: LanguageCode;
  joinedAt: number;
}

export interface MatchPolicy {
  /** true, если пару нельзя соединять (блокировка в любую сторону). */
  isBlocked(a: string, b: string): boolean;
  /** Последний собеседник гостя — чтобы «Следующий» не возвращал того же человека. */
  lastPartner(guestId: string): string | undefined;
}

/** Сколько ждать, прежде чем разрешить повторную встречу с последним собеседником. */
export const REMATCH_COOLDOWN_MS = 10_000;

export function languagesCompatible(a: LanguageCode, b: LanguageCode): boolean {
  return a === 'any' || b === 'any' || a === b;
}

/**
 * Очередь поиска. Хранит только тех, кто ищет; при совпадении сразу
 * извлекает пару. Повторное добавление того же гостя не создаёт дубликат.
 */
export class Matchmaker {
  private readonly queue = new Map<string, QueueEntry>();

  constructor(
    private readonly policy: MatchPolicy,
    private readonly now: () => number = Date.now,
  ) {}

  get size(): number {
    return this.queue.size;
  }

  has(guestId: string): boolean {
    return this.queue.has(guestId);
  }

  remove(guestId: string): boolean {
    return this.queue.delete(guestId);
  }

  canPair(a: QueueEntry, b: QueueEntry): boolean {
    if (a.guestId === b.guestId) return false;
    if (!languagesCompatible(a.language, b.language)) return false;
    if (this.policy.isBlocked(a.guestId, b.guestId)) return false;
    const t = this.now();
    const recent =
      this.policy.lastPartner(a.guestId) === b.guestId || this.policy.lastPartner(b.guestId) === a.guestId;
    if (recent && t - a.joinedAt < REMATCH_COOLDOWN_MS && t - b.joinedAt < REMATCH_COOLDOWN_MS) return false;
    return true;
  }

  /**
   * Добавляет гостя и пытается найти пару. Предпочитает точное совпадение языка,
   * затем самого давно ждущего. Возвращает пару или null (гость остаётся в очереди).
   */
  enqueue(guestId: string, language: LanguageCode): [QueueEntry, QueueEntry] | null {
    const existing = this.queue.get(guestId);
    const entry: QueueEntry = existing
      ? { ...existing, language }
      : { guestId, language, joinedAt: this.now() };
    this.queue.delete(guestId);

    let best: QueueEntry | null = null;
    for (const candidate of this.queue.values()) {
      if (!this.canPair(entry, candidate)) continue;
      const exact = candidate.language === entry.language && entry.language !== 'any';
      if (!best) {
        best = candidate;
        if (exact) break;
        continue;
      }
      const bestExact = best.language === entry.language && entry.language !== 'any';
      if (exact && !bestExact) {
        best = candidate;
        break;
      }
    }

    if (best) {
      this.queue.delete(best.guestId);
      return [best, entry];
    }
    this.queue.set(guestId, entry);
    return null;
  }

  /**
   * Повторная попытка подобрать пары среди уже ждущих (например, когда истёк
   * кулдаун повторной встречи). Возвращает все найденные пары.
   */
  sweep(): [QueueEntry, QueueEntry][] {
    const pairs: [QueueEntry, QueueEntry][] = [];
    const entries = [...this.queue.values()];
    const taken = new Set<string>();
    for (let i = 0; i < entries.length; i++) {
      const a = entries[i]!;
      if (taken.has(a.guestId)) continue;
      for (let j = i + 1; j < entries.length; j++) {
        const b = entries[j]!;
        if (taken.has(b.guestId)) continue;
        if (this.canPair(a, b)) {
          taken.add(a.guestId);
          taken.add(b.guestId);
          this.queue.delete(a.guestId);
          this.queue.delete(b.guestId);
          pairs.push([a, b]);
          break;
        }
      }
    }
    return pairs;
  }
}
