// Android-App: Höhen von Status- und Navigationsleiste als CSS-Variablen
(function () {
  var root = document.documentElement;
  window.strabApplyInsets = function (i) {
    if (!i) return;
    root.style.setProperty('--sat', i.t + 'px');
    root.style.setProperty('--sab', i.b + 'px');
    root.style.setProperty('--sal', i.l + 'px');
    root.style.setProperty('--sar', i.r + 'px');
    root.style.setProperty('--kb', (i.k || 0) + 'px');
    if (document.body) document.body.classList.toggle('kb-open', (i.k || 0) > 80);
  };
  if (!window.StrabInsets) return;
  try { window.strabApplyInsets(JSON.parse(window.StrabInsets.get())); } catch (e) {}
  var syncIcons = function () { try { window.StrabInsets.setLight(root.dataset.theme !== 'dark'); } catch (e) {} };
  new MutationObserver(syncIcons).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
  syncIcons();
})();
