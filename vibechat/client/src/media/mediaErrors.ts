export type MediaErrorKind = 'denied' | 'not-found' | 'busy' | 'insecure' | 'unsupported' | 'unknown';

export function classifyMediaError(err: unknown): MediaErrorKind {
  const name = (err as { name?: string } | null)?.name ?? '';
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return 'denied';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return 'not-found';
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return 'busy';
    case 'TypeError':
    case 'NotSupportedError':
      return 'unsupported';
    default:
      return 'unknown';
  }
}

export const MEDIA_ERROR_TEXT: Record<MediaErrorKind, { title: string; hint: string }> = {
  denied: {
    title: 'Нет доступа к камере и микрофону',
    hint: 'Разрешите доступ в настройках браузера: значок замка или камеры слева от адреса сайта → «Разрешить». Затем нажмите «Попробовать снова».',
  },
  'not-found': {
    title: 'Камера и микрофон не найдены',
    hint: 'Подключите камеру или микрофон и нажмите «Попробовать снова». Для разговора достаточно одного микрофона.',
  },
  busy: {
    title: 'Устройство занято',
    hint: 'Камеру использует другое приложение или вкладка (Zoom, Teams, другой видеочат). Закройте его и попробуйте снова.',
  },
  insecure: {
    title: 'Нужно защищённое соединение',
    hint: 'Браузеры дают доступ к камере только на сайтах с HTTPS. Откройте сайт по адресу, начинающемуся с https://.',
  },
  unsupported: {
    title: 'Браузер не поддерживает видеосвязь',
    hint: 'Обновите браузер или откройте сайт в последней версии Chrome, Safari, Firefox или Edge.',
  },
  unknown: {
    title: 'Не удалось включить камеру',
    hint: 'Попробуйте перезагрузить страницу. Если не поможет — перезапустите браузер.',
  },
};
