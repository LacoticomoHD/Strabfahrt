// Info-Seite: gleiche Darstellung wie in der App (hell/dunkel) und Zurücktaste führt zur Karte
(function () {
  var t = null;
  try { t = JSON.parse(localStorage.getItem('strab.theme')); } catch (e) {}
  document.documentElement.dataset.theme = t || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  window.strabBack = function () { location.href = './'; return true; };
})();
