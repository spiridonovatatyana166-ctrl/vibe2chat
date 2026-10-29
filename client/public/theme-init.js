// Применяем тему до отрисовки, чтобы не было вспышки светлого фона.
try {
  if (localStorage.getItem('vc.theme') === 'light') {
    document.documentElement.classList.remove('dark');
    document.documentElement.classList.add('light');
  }
} catch (e) {
  /* localStorage недоступен — остаётся тёмная тема */
}
