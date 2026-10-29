import { useCallback, useState } from 'react';

export type Theme = 'dark' | 'light';

function current(): Theme {
  return document.documentElement.classList.contains('light') ? 'light' : 'dark';
}

export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(current);
  const toggle = useCallback(() => {
    const next: Theme = current() === 'dark' ? 'light' : 'dark';
    document.documentElement.classList.remove('dark', 'light');
    document.documentElement.classList.add(next);
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', next === 'dark' ? '#0a0a0f' : '#f5f5fa');
    try {
      localStorage.setItem('vc.theme', next);
    } catch {
      /* ignore */
    }
    setTheme(next);
  }, []);
  return [theme, toggle];
}
