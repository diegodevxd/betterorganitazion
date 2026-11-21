// Preferencias visuales que deben aplicarse ANTES de pintar la página
// (por eso se carga en <head> y no espera a app.js).
// Tamaño de letra: todo el panel usa rem, así que cambiar el font-size de <html>
// agranda textos, botones, íconos y espacios de forma proporcional.
(function () {
  var KEY = 'bm-text-size';
  var SIZES = ['normal', 'grande', 'muy-grande'];
  var DEFAULT_SIZE = 'grande';

  function read() {
    try {
      var v = localStorage.getItem(KEY);
      return SIZES.indexOf(v) >= 0 ? v : DEFAULT_SIZE;
    } catch (e) {
      return DEFAULT_SIZE;
    }
  }

  function apply(size) {
    if (SIZES.indexOf(size) < 0) size = DEFAULT_SIZE;
    document.documentElement.setAttribute('data-text-size', size);
    try {
      localStorage.setItem(KEY, size);
    } catch (e) {
      /* modo privado: solo dura esta sesión */
    }
    window.dispatchEvent(new CustomEvent('bm:text-size', { detail: { size: size } }));
    return size;
  }

  document.documentElement.setAttribute('data-text-size', read());

  window.BM_TEXT_SIZE = {
    sizes: SIZES,
    get: read,
    set: apply,
    next: function () {
      var i = SIZES.indexOf(read());
      return apply(SIZES[(i + 1) % SIZES.length]);
    },
    // Factor respecto a 16px, útil para Chart.js (canvas no entiende rem).
    scale: function () {
      return parseFloat(getComputedStyle(document.documentElement).fontSize) / 16 || 1;
    },
  };
})();
