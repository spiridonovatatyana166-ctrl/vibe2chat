import { z } from 'zod';
import {
  LANGUAGE_CODES,
  LIMITS,
  REPORT_REASON_CODES,
  type ClientMessage,
  type LanguageCode,
  type ReportReason,
} from '../../../shared/protocol.js';

const roomId = z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/);
const language = z.enum(LANGUAGE_CODES as [LanguageCode, ...LanguageCode[]]);

const signalData = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('offer'), sdp: z.string().min(1).max(LIMITS.sdpMaxLength) }),
  z.object({ kind: z.literal('answer'), sdp: z.string().min(1).max(LIMITS.sdpMaxLength) }),
  z.object({
    kind: z.literal('ice'),
    candidate: z.object({
      candidate: z.string().max(LIMITS.iceCandidateMaxLength),
      sdpMid: z.string().max(64).nullable(),
      sdpMLineIndex: z.number().int().min(0).max(64).nullable(),
      usernameFragment: z.string().max(256).nullable().optional(),
    }),
  }),
]);

export const clientMessageSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('queue:join'), language }),
  z.object({ t: z.literal('queue:leave') }),
  z.object({ t: z.literal('room:next'), roomId, language }),
  z.object({ t: z.literal('room:leave'), roomId }),
  z.object({ t: z.literal('room:failed'), roomId }),
  z.object({ t: z.literal('signal'), roomId, data: signalData }),
  z.object({
    t: z.literal('chat:send'),
    roomId,
    // Длину проверяем после нормализации, здесь — грубая защита от гигантских строк.
    text: z.string().min(1).max(LIMITS.chatMaxLength * 4),
    clientMsgId: z.string().min(1).max(64),
  }),
  z.object({ t: z.literal('peer:state'), roomId, camOn: z.boolean(), micOn: z.boolean() }),
  z.object({
    t: z.literal('report'),
    roomId,
    reason: z.enum(REPORT_REASON_CODES as [ReportReason, ...ReportReason[]]),
    details: z.string().max(LIMITS.reportDetailsMaxLength * 2).optional(),
  }),
  z.object({ t: z.literal('block'), roomId }),
  z.object({
    t: z.literal('diag:echo'),
    id: z.string().min(1).max(32),
    payload: z.string().max(LIMITS.diagEchoMaxLength),
  }),
]);

export function parseClientMessage(raw: string): ClientMessage | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const res = clientMessageSchema.safeParse(json);
  return res.success ? (res.data as ClientMessage) : null;
}

// Управляющие символы, «невидимые» символы и переопределения направления текста.
const STRIP = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

/**
 * Нормализует текст сообщения. Возвращает null, если после очистки ничего
 * не осталось или текст длиннее лимита.
 */
export function sanitizeText(input: string, maxLength: number): string | null {
  const cleaned = input
    .normalize('NFC')
    .replace(STRIP, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!cleaned) return null;
  if ([...cleaned].length > maxLength) return null;
  return cleaned;
}
