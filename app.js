// ============================================
// CONFIGURACIÓN SUPABASE — leer desde config.js (no versionado)
// Ver config.example.js para el formato.
// ============================================
const CONFIG = (typeof window !== 'undefined' && window.BM_CONFIG) || {};

const SUPABASE_URL = CONFIG.SUPABASE_URL || '';
const SUPABASE_KEY = CONFIG.SUPABASE_KEY || '';
const STORAGE_BUCKET = 'movimientos_fotos';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.warn('BetterMancera Admin: faltan variables de configuración. Revisa config.js.');
}

let supabaseClient = null;
let movimientosData = [];
let asociadosData = [];
let perfilesAdminData = {};
let modoFormulario = 'pedido';
let modalSaveHandler = null;
let filtroSaldo = 'todos';
let filtroAltasSaldo = 'todos';
let filtroSemanalSaldo = 'todos';
let filtroOrigen = 'todos';
let switchViewFn = null;
const previewUrls = new Map();

function getSupabase() {
  if (supabaseClient) return supabaseClient;

  if (!window.supabase?.createClient) {
    throw new Error('Supabase no se cargó. Revisa tu conexión o recarga la página.');
  }

  // Se usa storageKey: 'bm-admin-auth' con persistSession: true y autoRefreshToken: true.
  // El storageKey propio es indispensable para que el panel administrativo no herede
  // ni interfiera con la sesión de un cliente logueado en la tienda online (usuarios/tienda.js)
  // guardada bajo la clave default en el localStorage del mismo origen.
  supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      storageKey: 'bm-admin-auth',
    },
  });
  return supabaseClient;
}

// ============================================
// Autenticación de Administrador (Paso 5)
// ============================================
let isAdminAuthenticated = false;
let isAuthenticating = false;

function showLoginScreen(errorMessage = '', showRetry = false) {
  isAdminAuthenticated = false;
  isAuthenticating = false;
  const pantallaLogin = document.getElementById('pantalla-login');
  if (pantallaLogin) pantallaLogin.classList.remove('hidden');

  setLoginError(errorMessage, showRetry);

  const passInput = document.getElementById('login-password');
  if (passInput) passInput.value = '';
}

function hideLoginScreen() {
  const pantallaLogin = document.getElementById('pantalla-login');
  if (pantallaLogin) pantallaLogin.classList.add('hidden');

  setLoginError('', false);
}

function setLoginError(message, showRetry = false) {
  const errorEl = document.getElementById('login-error');
  const errorTextEl = document.getElementById('login-error-texto');
  const btnRetry = document.getElementById('btn-login-reintentar');
  if (!errorEl || !errorTextEl) return;

  if (message) {
    errorTextEl.textContent = message;
    errorEl.classList.remove('hidden');
    if (btnRetry) {
      if (showRetry) {
        btnRetry.classList.remove('hidden');
      } else {
        btnRetry.classList.add('hidden');
      }
    }
  } else {
    errorEl.classList.add('hidden');
    errorTextEl.textContent = '';
    if (btnRetry) btnRetry.classList.add('hidden');
  }
}

// Devuelve { ok: true, esAdmin: boolean } o { ok: false, error: Error }
// Permite distinguir fallos de red de una respuesta legítima es_admin = false.
async function verifyEsAdmin() {
  try {
    const { data, error } = await getSupabase().rpc('es_admin');
    if (error) {
      return { ok: false, error };
    }
    return { ok: true, esAdmin: Boolean(data) };
  } catch (err) {
    return { ok: false, error: err };
  }
}

async function handleLoginSubmit(event) {
  event.preventDefault();

  const emailInput = document.getElementById('login-email');
  const passwordInput = document.getElementById('login-password');
  const btnSubmit = document.getElementById('btn-login-submit');

  const email = emailInput?.value.trim() || '';
  const password = passwordInput?.value || '';

  if (!email || !password) {
    setLoginError('Ingresa tu correo y contraseña.');
    return;
  }

  setLoginError('');
  if (btnSubmit) setButtonLoading(btnSubmit, true, 'Verificando...');
  isAuthenticating = true;

  try {
    const { data, error } = await getSupabase().auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      isAuthenticating = false;
      const msg = error.message || '';
      if (/invalid login credentials|invalid credentials/i.test(msg)) {
        setLoginError('Correo o contraseña incorrectos.');
      } else if (/failed to fetch|networkerror|load failed/i.test(msg)) {
        setLoginError('Sin conexión. Revisa tu internet e intenta de nuevo.', true);
      } else {
        setLoginError(formatFriendlyError(error, 'Error al iniciar sesión.'));
      }
      return;
    }

    if (!data?.user) {
      isAuthenticating = false;
      setLoginError('No se pudo verificar el usuario.');
      return;
    }

    // Verificar si el usuario autenticado tiene rol admin registrado
    const resAdmin = await verifyEsAdmin();
    if (!resAdmin.ok) {
      // Error de red o timeout en el RPC: NO cerrar sesión, permitir reintento
      isAuthenticating = false;
      setLoginError('No se pudo verificar tu acceso. Revisa tu conexión e intenta de nuevo.', true);
      return;
    }

    if (!resAdmin.esAdmin) {
      // Usuario autenticado pero no autorizado como admin
      isAuthenticating = false;
      await getSupabase().auth.signOut();
      setLoginError('Esta cuenta no tiene acceso al panel.');
      return;
    }

    // Acceso verificado: entrar y cargar datos
    await onAdminAuthenticated();
  } catch (err) {
    isAuthenticating = false;
    console.error('handleLoginSubmit error:', err);
    setLoginError(formatFriendlyError(err, 'Error inesperado al entrar.'));
  } finally {
    if (btnSubmit) setButtonLoading(btnSubmit, false);
  }
}

async function handleLogout() {
  try {
    await getSupabase().auth.signOut();
  } catch (err) {
    console.warn('signOut error:', err);
  } finally {
    showLoginScreen();
  }
}

async function onAdminAuthenticated() {
  if (isAdminAuthenticated) return;
  isAdminAuthenticated = true;
  isAuthenticating = false;
  hideLoginScreen();

  try {
    await Promise.all([fetchMovimientos(), fetchAsociados()]);
  } catch (err) {
    console.error('Error al cargar datos de panel tras login:', err);
  }
}

async function checkInitialAdminSession() {
  try {
    const { data, error } = await getSupabase().auth.getSession();
    if (error || !data?.session?.user) {
      showLoginScreen();
      return;
    }

    // Verificar si la sesión existente pertenece a un administrador
    const resAdmin = await verifyEsAdmin();
    if (!resAdmin.ok) {
      // Falla de red: NO hacer signOut para no expulsar al usuario
      console.warn('Fallo de red al verificar sesión admin existente:', resAdmin.error);
      showLoginScreen('No se pudo verificar tu acceso. Revisa tu conexión.', true);
      return;
    }

    if (!resAdmin.esAdmin) {
      await getSupabase().auth.signOut();
      showLoginScreen('Esta cuenta no tiene acceso al panel.');
      return;
    }

    await onAdminAuthenticated();
  } catch (err) {
    console.error('checkInitialAdminSession error:', err);
    showLoginScreen('No se pudo verificar tu acceso. Revisa tu conexión.', true);
  }
}

function setupAuthListeners() {
  document.getElementById('form-login')?.addEventListener('submit', handleLoginSubmit);
  document.getElementById('btn-logout-drawer')?.addEventListener('click', handleLogout);
  document.getElementById('btn-logout-header')?.addEventListener('click', handleLogout);

  document.getElementById('btn-login-reintentar')?.addEventListener('click', async () => {
    const btnRetry = document.getElementById('btn-login-reintentar');
    if (btnRetry) setButtonLoading(btnRetry, true, 'Reintentando...');
    try {
      await checkInitialAdminSession();
    } finally {
      if (btnRetry) setButtonLoading(btnRetry, false);
    }
  });

  try {
    getSupabase().auth.onAuthStateChange(async (event, session) => {
      if (event === 'SIGNED_OUT' || !session) {
        if (isAdminAuthenticated) {
          showLoginScreen();
        }
      } else if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
        // Evitar procesar doble si handleLoginSubmit ya está en curso o si ya está autenticado
        if (!isAdminAuthenticated && !isAuthenticating && session?.user) {
          isAuthenticating = true;
          const resAdmin = await verifyEsAdmin();
          if (!resAdmin.ok) {
            isAuthenticating = false;
            showLoginScreen('No se pudo verificar tu acceso. Revisa tu conexión.', true);
          } else if (resAdmin.esAdmin) {
            await onAdminAuthenticated();
          } else {
            isAuthenticating = false;
            await getSupabase().auth.signOut();
            showLoginScreen('Esta cuenta no tiene acceso al panel.');
          }
        }
      }
    });
  } catch (err) {
    console.warn('onAuthStateChange listener error:', err);
  }
}

async function fetchPerfilesAdmin() {
  try {
    const { data, error } = await getSupabase().from('perfiles').select('*');
    if (error) throw error;
    perfilesAdminData = {};
    (data || []).forEach(function (p) {
      if (p.id) perfilesAdminData[p.id] = p;
    });
  } catch (err) {
    console.warn('Error al cargar perfiles para admin:', err);
    perfilesAdminData = {};
  }
}

// ============================================
// Utilidades
// ============================================
async function compressImage(file) {
  if (typeof imageCompression !== 'function') {
    throw new Error('La compresión de imágenes no se cargó. Recarga la página.');
  }
  return imageCompression(file, {
    maxSizeMB: 0.5,
    maxWidthOrHeight: 1280,
    useWebWorker: true,
  });
}

function generateFileName(originalName) {
  const ext = originalName.split('.').pop() || 'jpg';
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}.${ext}`;
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatFecha(fecha) {
  if (!fecha) return '—';
  const date = new Date(fecha.includes('T') ? fecha : `${fecha}T00:00:00`);
  return date.toLocaleDateString('es-MX', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

function formatHora(hora) {
  if (!hora) return '—';
  const [h, m] = hora.split(':');
  return `${h}:${m} hrs`;
}

function normalizeDate(value) {
  if (!value) return '';
  return String(value).split('T')[0];
}

function parseLocalDate(value) {
  if (!value) return null;
  const str = String(value).split('T')[0];
  const [y, m, d] = str.split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

function formatDateKey(date) {
  const y = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${y}-${mm}-${dd}`;
}

function getTodayLocalDateString() {
  return formatDateKey(new Date());
}

function isDateInRange(dateValue, inicio, fin) {
  const d = parseLocalDate(dateValue);
  if (!d) return false;
  const t = d.getTime();
  return t >= inicio.getTime() && t <= fin.getTime();
}

function matchesName(text, query) {
  if (!query) return true;
  return (text || '').toLowerCase().includes(query.toLowerCase());
}

function matchesDate(recordDate, filterDate) {
  if (!filterDate) return true;
  return normalizeDate(recordDate) === filterDate;
}

function getInitials(nombre) {
  if (!nombre) return '?';
  const raw = String(nombre)
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('');
  return escapeHtml(raw || '?');
}

function formatMoney(total) {
  return new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency: 'MXN',
  }).format(total);
}

function getMovimientoFecha(mov) {
  return mov.fecha || mov.created_at;
}

// Devuelve un timestamp numérico (ms) basado en la fecha efectiva (fecha + hora).
// Permite ordenar movimientos cronológicamente de forma real incluso si un pago
// o pedido fue cargado retroactivamente.
function getMovimientoDateTime(mov) {
  if (!mov) return 0;
  if (typeof mov._ts === 'number') return mov._ts;

  const fechaStr = normalizeDate(mov.fecha || mov.created_at);
  let horaStr = mov.hora || '';
  if (!horaStr && mov.created_at) {
    const d = new Date(mov.created_at);
    if (!Number.isNaN(d.getTime())) {
      horaStr = d.toTimeString().slice(0, 8);
    }
  }
  if (!horaStr) horaStr = '00:00:00';

  const combined = new Date(`${fechaStr}T${horaStr}`);
  const ts = combined.getTime();
  if (!Number.isNaN(ts)) {
    mov._ts = ts;
    return ts;
  }

  const fallback = new Date(mov.created_at || mov.fecha).getTime();
  const res = Number.isNaN(fallback) ? 0 : fallback;
  mov._ts = res;
  return res;
}

function setButtonLoading(button, isLoading, loadingText = 'Cargando...') {
  if (!button) return;
  if (isLoading) {
    button.dataset.originalHtml = button.innerHTML;
    button.disabled = true;
    button.innerHTML = loadingText;
  } else {
    button.disabled = false;
    if (button.dataset.originalHtml) {
      button.innerHTML = button.dataset.originalHtml;
    }
  }
}

function formatFriendlyError(err, fallback = 'Ocurrió un error inesperado.') {
  if (!err) return fallback;
  const msg = err.message || String(err);
  if (/failed to fetch|networkerror|load failed/i.test(msg)) {
    return 'Sin conexión o servidor no disponible. Revisa tu internet e intenta de nuevo.';
  }
  if (/supabase no se cargó|compresión de imágenes no se cargó/i.test(msg)) {
    return msg;
  }
  return msg || fallback;
}

function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

function showSuccessToast(message = 'Guardado', options = {}) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = 'success-toast';
  if (options.actionLabel) toast.classList.add('has-action');

  toast.innerHTML = `
    <div class="flex items-center gap-2">
      <span class="material-symbols-outlined toast-icon">check_circle</span>
      <span class="toast-text">${escapeHtml(message)}</span>
    </div>
  `;

  if (options.actionLabel && typeof options.onAction === 'function') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-action-btn';
    btn.textContent = options.actionLabel;
    btn.addEventListener('click', () => {
      options.onAction();
      toast.classList.add('hide');
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    });
    toast.appendChild(btn);
  }

  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));

  const duration = options.actionLabel ? 5500 : 2200;
  setTimeout(() => {
    if (!toast.isConnected) return;
    toast.classList.add('hide');
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

async function uploadToStorage(file, bucket = STORAGE_BUCKET) {
  const fileName = generateFileName(file.name);
  const { error } = await getSupabase().storage.from(bucket).upload(fileName, file, {
    cacheControl: '3600',
    upsert: false,
  });
  if (error) throw error;

  const { data } = getSupabase().storage.from(bucket).getPublicUrl(fileName);
  return data.publicUrl;
}

async function downloadImage(url, filename) {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error('No se pudo descargar');
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(objectUrl);
  } catch {
    window.open(url, '_blank');
  }
}

function photoActionsHtml(url, filename, compact = false) {
  const safeUrl = escapeHtml(url);
  const safeName = escapeHtml(filename);
  const btnClass = compact
    ? 'inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[12px] font-semibold text-on-surface-variant hover:bg-surface-container-high transition-colors'
    : 'inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-[12px] font-semibold hover:opacity-90 transition-opacity';
  const btnStyle = compact ? '' : 'background: #E0F7FB; color: #00667A;';

  return `
    <div class="flex flex-wrap gap-1 ${compact ? '' : 'mt-1'}">
      <a href="${safeUrl}" target="_blank" rel="noopener" class="${btnClass}" style="${btnStyle}">
        <span class="material-symbols-outlined text-[16px]">visibility</span>
        Ver
      </a>
      <button type="button" class="${btnClass} btn-download" data-url="${safeUrl}" data-filename="${safeName}" style="${btnStyle}">
        <span class="material-symbols-outlined text-[16px]">download</span>
        Descargar
      </button>
    </div>
  `;
}

function revokePreviewUrls(key) {
  const urls = previewUrls.get(key) || [];
  urls.forEach((url) => URL.revokeObjectURL(url));
  previewUrls.delete(key);
}

function renderFilePreview(previewId, files) {
  const container = document.getElementById(previewId);
  if (!container) return;

  revokePreviewUrls(previewId);

  if (!files || files.length === 0) {
    container.innerHTML = '';
    container.classList.add('hidden');
    return;
  }

  const urls = [];
  container.innerHTML = Array.from(files)
    .map((file, index) => {
      const url = URL.createObjectURL(file);
      urls.push(url);
      return `
        <div class="relative">
          <img src="${url}" alt="Vista previa ${index + 1}" class="preview-thumb">
          <span class="absolute bottom-1 left-1 right-1 text-[10px] text-white bg-black/60 rounded px-1 truncate">${escapeHtml(file.name)}</span>
        </div>
      `;
    })
    .join('');

  previewUrls.set(previewId, urls);
  container.classList.remove('hidden');
}

function clearFilePreview(previewId, dropzoneId, defaultLabel, multiple = false) {
  revokePreviewUrls(previewId);
  const container = document.getElementById(previewId);
  if (container) {
    container.innerHTML = '';
    container.classList.add('hidden');
  }

  const dropzoneLabel = document.querySelector(`#${dropzoneId} span:last-of-type`);
  if (dropzoneLabel) {
    dropzoneLabel.textContent = defaultLabel || (multiple ? 'Seleccionar Imágenes' : 'Subir Imagen');
  }
}

function autofillPagoFechaHora() {
  const fechaInput = document.getElementById('pago-fecha');
  const horaInput = document.getElementById('pago-hora');
  if (!fechaInput || !horaInput) return;

  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');

  fechaInput.value = `${yyyy}-${mm}-${dd}`;
  horaInput.value = `${hh}:${min}`;
}

function setupDropzone(dropzoneId, inputId, previewId, multiple = false) {
  const dropzone = document.getElementById(dropzoneId);
  const input = document.getElementById(inputId);
  if (!dropzone || !input) return;

  dropzone.addEventListener('click', () => input.click());

  input.addEventListener('change', () => {
    const count = input.files?.length || 0;
    const label = dropzone.querySelector('span:last-of-type');

    if (count === 0) {
      clearFilePreview(previewId, dropzoneId, dropzone.dataset.defaultLabel, multiple);
      return;
    }

    if (label) {
      label.textContent = multiple
        ? `${count} imagen${count > 1 ? 'es' : ''} seleccionada${count > 1 ? 's' : ''}`
        : input.files[0].name;
    }

    renderFilePreview(previewId, input.files);
  });
}

function setupDownloadDelegation(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;

  container.addEventListener('click', async (event) => {
    const button = event.target.closest('.btn-download');
    if (!button) return;
    event.preventDefault();
    await downloadImage(button.dataset.url, button.dataset.filename || 'foto.jpg');
  });
}

function setupFilterListeners({ nombreId, fechaId, limpiarId, onFilter, chipContainerId, setFiltroFn }) {
  document.getElementById(nombreId)?.addEventListener('input', onFilter);
  document.getElementById(fechaId)?.addEventListener('change', onFilter);
  document.getElementById(limpiarId)?.addEventListener('click', () => {
    const nombre = document.getElementById(nombreId);
    const fecha = document.getElementById(fechaId);
    if (nombre) nombre.value = '';
    if (fecha) fecha.value = '';

    if (chipContainerId && setFiltroFn) {
      setFiltroFn('todos');
      const container = document.getElementById(chipContainerId);
      if (container) {
        container.querySelectorAll('.chip-filtro').forEach((c) => c.classList.remove('active'));
        container.querySelector('[data-filtro="todos"]')?.classList.add('active');
      }
    }

    onFilter();
  });
}

function renderEmptyState(container, message) {
  if (!container) return;
  container.innerHTML = `
    <div class="flex flex-col items-center justify-center py-12 text-center">
      <span class="material-symbols-outlined text-[48px] mb-3" style="color: #66D0F0;">inbox</span>
      <p class="text-sm text-outline max-w-[200px]">${message}</p>
    </div>
  `;
}

// ============================================
// Gráficos (Chart.js 4 UMD)
// ============================================
let chartHistoricoInstance = null;
let chartBarrasInstance = null;
let chartDonaInstance = null;

function destroyCharts() {
  if (chartHistoricoInstance) {
    try { chartHistoricoInstance.destroy(); } catch {}
    chartHistoricoInstance = null;
  }
  if (chartBarrasInstance) {
    try { chartBarrasInstance.destroy(); } catch {}
    chartBarrasInstance = null;
  }
  if (chartDonaInstance) {
    try { chartDonaInstance.destroy(); } catch {}
    chartDonaInstance = null;
  }
}

function updateCharts() {
  if (typeof Chart === 'undefined') return;

  const canvasHistorico = document.getElementById('chart-historico');
  const canvasBarras = document.getElementById('chart-barras-semanal');
  const canvasDona = document.getElementById('chart-dona-cartera');

  if (!canvasHistorico || !canvasBarras || !canvasDona) return;

  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const animationDuration = prefersReducedMotion ? 0 : 400;

  // --- 1. Calcular datos de las últimas 8 semanas ---
  const { inicio: currInicio } = getWeekRange();
  const weekRanges = [];
  for (let i = 7; i >= 0; i--) {
    const wStart = new Date(currInicio);
    wStart.setDate(currInicio.getDate() - i * 7);
    const wEnd = new Date(wStart);
    wEnd.setDate(wStart.getDate() + 6);
    wEnd.setHours(23, 59, 59, 999);
    weekRanges.push({ inicio: wStart, fin: wEnd });
  }

  const labelsSemanas = weekRanges.map((w) => `${formatDateShort(w.inicio)}`);
  const datosVentasSemanales = [];
  const datosCobradoSemanales = [];
  const datosCobrablesSemanales = [];

  weekRanges.forEach((w) => {
    let ventasSemana = 0;
    let cobradoSemana = 0;
    let cobrableSemana = 0;

    movimientosData.forEach((m) => {
      const fechaStr = getMovimientoFecha(m);
      if (isSameWeek(fechaStr, w)) {
        const monto = Number(m.monto) || 0;
        if (m.tipo === 'pedido') {
          ventasSemana += monto;
          if (m.estado !== 'pagado') {
            cobrableSemana += monto;
          }
        } else if (m.tipo === 'pago') {
          cobradoSemana += monto;
        }
      }
    });

    datosVentasSemanales.push(ventasSemana);
    datosCobradoSemanales.push(cobradoSemana);
    datosCobrablesSemanales.push(cobrableSemana);
  });

  // --- Gráfico 1: Histórico de Cobranza (Líneas / Área) ---
  if (chartHistoricoInstance) {
    chartHistoricoInstance.data.labels = labelsSemanas;
    chartHistoricoInstance.data.datasets[0].data = datosCobradoSemanales;
    chartHistoricoInstance.data.datasets[1].data = datosCobrablesSemanales;
    chartHistoricoInstance.update('none');
  } else {
    chartHistoricoInstance = new Chart(canvasHistorico, {
      type: 'line',
      data: {
        labels: labelsSemanas,
        datasets: [
          {
            label: 'Pagos cobrados',
            data: datosCobradoSemanales,
            borderColor: '#00A859',
            backgroundColor: 'rgba(0, 168, 89, 0.12)',
            fill: true,
            tension: 0.35,
            borderWidth: 2.5,
            pointRadius: 3,
            pointHoverRadius: 5
          },
          {
            label: 'Pedidos por cobrar',
            data: datosCobrablesSemanales,
            borderColor: '#00B2E3',
            backgroundColor: 'transparent',
            borderDash: [4, 4],
            tension: 0.35,
            borderWidth: 2,
            pointRadius: 2.5
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        devicePixelRatio: Math.min(window.devicePixelRatio || 1, 2),
        animation: { duration: animationDuration },
        plugins: {
          legend: {
            position: 'top',
            labels: { boxWidth: 12, font: { size: 11 } }
          },
          tooltip: {
            callbacks: {
              label: (ctx) => ` ${ctx.dataset.label}: ${formatMoney(ctx.parsed.y)}`
            }
          }
        },
        scales: {
          x: { grid: { display: false }, ticks: { font: { size: 10 } } },
          y: {
            ticks: {
              font: { size: 10 },
              callback: (val) => `$${Number(val).toLocaleString('es-MX')}`
            },
            grid: { color: 'rgba(0,0,0,0.04)' }
          }
        }
      }
    });
  }

  // --- Gráfico 2: Barras Cobrado vs Cobrable ---
  if (chartBarrasInstance) {
    chartBarrasInstance.data.labels = labelsSemanas;
    chartBarrasInstance.data.datasets[0].data = datosCobradoSemanales;
    chartBarrasInstance.data.datasets[1].data = datosCobrablesSemanales;
    chartBarrasInstance.update('none');
  } else {
    chartBarrasInstance = new Chart(canvasBarras, {
      type: 'bar',
      data: {
        labels: labelsSemanas,
        datasets: [
          {
            label: 'Cobrado',
            data: datosCobradoSemanales,
            backgroundColor: '#00A859',
            borderRadius: 4
          },
          {
            label: 'Cobrable',
            data: datosCobrablesSemanales,
            backgroundColor: '#002855',
            borderRadius: 4
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        devicePixelRatio: Math.min(window.devicePixelRatio || 1, 2),
        animation: { duration: animationDuration },
        plugins: {
          legend: {
            position: 'top',
            labels: { boxWidth: 10, font: { size: 10 } }
          },
          tooltip: {
            callbacks: {
              label: (ctx) => ` ${ctx.dataset.label}: ${formatMoney(ctx.parsed.y)}`
            }
          }
        },
        scales: {
          x: { grid: { display: false }, ticks: { font: { size: 9 } } },
          y: {
            ticks: {
              font: { size: 9 },
              callback: (val) => `$${Number(val).toLocaleString('es-MX')}`
            },
            grid: { color: 'rgba(0,0,0,0.04)' }
          }
        }
      }
    });
  }

  // --- Gráfico 3: Dona de Cartera (Clientes en deuda vs al corriente vs con saldo a favor) ---
  const groups = groupByCliente(movimientosData);
  const deudoresGroups = groups.filter((g) => g.debe > 0.005);
  const alDiaGroups = groups.filter((g) => Math.abs(g.debe) <= 0.005);
  const favorGroups = groups.filter((g) => g.debe < -0.005);

  const deudoresCount = deudoresGroups.length;
  const alDiaCount = alDiaGroups.length;
  const favorCount = favorGroups.length;

  const deudoresMonto = deudoresGroups.reduce((s, g) => s + g.debe, 0);
  const alDiaMonto = alDiaGroups.reduce((s, g) => s + g.totalCobrable, 0);
  const favorMonto = favorGroups.reduce((s, g) => s + Math.abs(g.debe), 0);

  const donaLabels = ['En deuda', 'Al corriente', 'Saldo a favor'];
  const donaData = [deudoresCount, alDiaCount, favorCount];
  const donaMontos = [deudoresMonto, alDiaMonto, favorMonto];

  const maxDpr = Math.min(window.devicePixelRatio || 1, 2);

  if (chartDonaInstance) {
    chartDonaInstance._donaMontos = donaMontos;
    chartDonaInstance.data.datasets[0].data = donaData;
    chartDonaInstance.update('none');
  } else {
    chartDonaInstance = new Chart(canvasDona, {
      type: 'doughnut',
      data: {
        labels: donaLabels,
        datasets: [
          {
            data: donaData,
            backgroundColor: ['#DC2626', '#00B2E3', '#00A859'],
            borderWidth: 2,
            hoverOffset: 4
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        devicePixelRatio: maxDpr,
        animation: { duration: animationDuration },
        plugins: {
          legend: {
            position: 'bottom',
            labels: { boxWidth: 10, font: { size: 10 } }
          },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const count = ctx.parsed || 0;
                const idx = ctx.dataIndex;
                const montos = ctx.chart?._donaMontos || [];
                const monto = montos[idx] || 0;
                return ` ${ctx.label}: ${count} cliente${count !== 1 ? 's' : ''} (${formatMoney(monto)})`;
              }
            }
          }
        },
        cutout: '68%'
      }
    });
    chartDonaInstance._donaMontos = donaMontos;
  }
}

function renderDashboard() {
  const container = document.getElementById('dashboard-clientes');
  if (!container) return;

  const groups = groupByCliente(movimientosData);
  const numDeudores = groups.filter((g) => g.debe > 0.005).length;
  const totalDeudores = groups.filter((g) => g.debe > 0.005).reduce((sum, g) => sum + g.debe, 0);
  const numAlDia = groups.filter((g) => g.debe <= 0.005).length;
  const totalAlDia = groups.filter((g) => g.debe <= 0.005).reduce((s, g) => s + Math.abs(g.debe), 0);
  const balanceGeneral = groups.reduce((sum, g) => sum + g.debe, 0);

  container.innerHTML = `
    <div class="rounded-xl p-3 text-center" style="background: linear-gradient(135deg, #FEE2E2, #FECACA); border-left: 4px solid #DC2626;">
      <p class="text-[10px] font-bold uppercase tracking-wider" style="color: #991B1B;">Deudores</p>
      <p class="text-xl font-bold" style="color: #991B1B;">${numDeudores}</p>
      <p class="text-[11px] font-semibold" style="color: #DC2626;">${formatMoney(totalDeudores)}</p>
    </div>
    <div class="rounded-xl p-3 text-center" style="background: linear-gradient(135deg, #D1FAE5, #A7F3D0); border-left: 4px solid #00A859;">
      <p class="text-[10px] font-bold uppercase tracking-wider" style="color: #004d26;">Al día</p>
      <p class="text-xl font-bold" style="color: #004d26;">${numAlDia}</p>
      <p class="text-[11px] font-semibold" style="color: #00A859;">${formatMoney(totalAlDia)}</p>
    </div>
    <div class="rounded-xl p-3 text-center" style="background: linear-gradient(135deg, #E0F7FB, #B3E5FC); border-left: 4px solid #00B2E3;">
      <p class="text-[10px] font-bold uppercase tracking-wider" style="color: #00667A;">Balance</p>
      <p class="text-xl font-bold" style="color: #00667A;">${groups.length}</p>
      <p class="text-[11px] font-semibold" style="color: ${balanceGeneral >= 0 ? '#00A859' : '#DC2626'};">${formatMoney(Math.abs(balanceGeneral))}</p>
    </div>
  `;
}

// ============================================
// Gamificación y Métricas de Cobranza (Fase 4)
// ============================================
const STORAGE_KEY_META_SEMANAL = 'bm_meta_semanal_v1';
const STORAGE_KEY_DEUDA_REF = 'bm_deuda_ref_v1';

// Devuelve la mediana de cobranza (pagos) de las últimas 4 semanas cerradas
function getSuggestedMetaSemanal() {
  const { inicio: currInicio } = getWeekRange();
  const cobros4Semanas = [];

  for (let i = 1; i <= 4; i++) {
    const wStart = new Date(currInicio);
    wStart.setDate(currInicio.getDate() - i * 7);
    const wEnd = new Date(wStart);
    wEnd.setDate(wStart.getDate() + 6);
    wEnd.setHours(23, 59, 59, 999);
    const wRange = { inicio: wStart, fin: wEnd };

    let totalPagos = 0;
    movimientosData.forEach((m) => {
      if (m.tipo === 'pago' && isSameWeek(getMovimientoFecha(m), wRange)) {
        totalPagos += Number(m.monto) || 0;
      }
    });
    cobros4Semanas.push(totalPagos);
  }

  cobros4Semanas.sort((a, b) => a - b);
  const mid = Math.floor(cobros4Semanas.length / 2);
  const mediana = cobros4Semanas.length % 2 === 0
    ? (cobros4Semanas[mid - 1] + cobros4Semanas[mid]) / 2
    : cobros4Semanas[mid];

  return Math.max(1000, Math.round(mediana / 100) * 100);
}

function getStoredMetaSemanal() {
  const raw = localStorage.getItem(STORAGE_KEY_META_SEMANAL);
  const val = parseFloat(raw);
  if (!Number.isNaN(val) && val > 0) return val;
  return getSuggestedMetaSemanal();
}

function setStoredMetaSemanal(monto) {
  if (monto > 0) {
    localStorage.setItem(STORAGE_KEY_META_SEMANAL, String(monto));
  }
}

// Devuelve una sugerencia de umbral de deuda alta para el ranking de morosos
// Exige muestra mínima (n >= 10), usa interpolación lineal de percentil y evita degenerar al máximo
function getSuggestedDeudaAltaRef() {
  const allGroups = groupByCliente(movimientosData);
  const saldosDeudores = allGroups.filter((g) => g.debe > 0.005).map((g) => g.debe).sort((a, b) => a - b);
  const n = saldosDeudores.length;
  if (n === 0) return 5000;

  // Si hay pocos deudores (< 10), usar un default o factor de mediana seguro
  if (n < 10) {
    const mid = Math.floor(n / 2);
    const mediana = n % 2 === 0 ? (saldosDeudores[mid - 1] + saldosDeudores[mid]) / 2 : saldosDeudores[mid];
    const sugerida = Math.max(3000, Math.round((mediana * 2.5) / 100) * 100);
    return Math.max(1000, sugerida);
  }

  // Interpolación lineal de percentil 90 (método estándar NIST / R-7 / NumPy)
  const p = 0.9;
  const pos = (n - 1) * p;
  const base = Math.floor(pos);
  const rest = pos - base;
  const p90 = (saldosDeudores[base + 1] !== undefined)
    ? saldosDeudores[base] + rest * (saldosDeudores[base + 1] - saldosDeudores[base])
    : saldosDeudores[base];

  // Acotar para que no sea estrictamente igual al saldo máximo cuando n es moderado
  const maxSaldo = saldosDeudores[n - 1];
  const valorAcotado = Math.min(p90, maxSaldo * 0.95);

  return Math.max(1000, Math.round(valorAcotado / 100) * 100);
}

function getStoredDeudaAltaRef() {
  const raw = localStorage.getItem(STORAGE_KEY_DEUDA_REF);
  const val = parseFloat(raw);
  if (!Number.isNaN(val) && val > 0) return val;
  return getSuggestedDeudaAltaRef();
}

function setStoredDeudaAltaRef(monto) {
  if (monto > 0) {
    localStorage.setItem(STORAGE_KEY_DEUDA_REF, String(monto));
  }
}

// Función unificada para determinar si una semana cumplió la meta de cobranza (Defecto 3)
function semanaCumplioMeta(wRange, meta) {
  let cobrado = 0;
  movimientosData.forEach((m) => {
    if (m.tipo === 'pago' && isSameWeek(getMovimientoFecha(m), wRange)) {
      cobrado += Number(m.monto) || 0;
    }
  });
  return cobrado >= meta;
}

// Calcula el score de cobranza (0-100) en ventana móvil de 28 días
function calculateScoreCobranza() {
  const now = new Date();
  const ventanaInicio = new Date(now);
  ventanaInicio.setDate(now.getDate() - 28);
  ventanaInicio.setHours(0, 0, 0, 0);

  const allGroups = groupByCliente(movimientosData);

  // 1. Tasa de cobranza T (40 pts)
  // Pagos aplicados en los últimos 28 días vs Deuda exigible en los últimos 28 días
  let pagos28 = 0;
  let cobrables28 = 0;

  movimientosData.forEach((m) => {
    const d = parseLocalDate(getMovimientoFecha(m));
    if (d && d >= ventanaInicio && d <= now) {
      const monto = Number(m.monto) || 0;
      if (m.tipo === 'pago') {
        pagos28 += monto;
      } else if (m.tipo === 'pedido' && m.estado !== 'pagado') {
        cobrables28 += monto;
      }
    }
  });

  // Saldo abierto antes de la ventana calculado POR CLIENTE sin netear saldos entre clientes distintos (Defecto 4)
  const saldoPrevioPorCliente = new Map();
  movimientosData.forEach((m) => {
    const d = parseLocalDate(getMovimientoFecha(m));
    if (d && d < ventanaInicio) {
      const cKey = normalizeClienteKey(m.cliente);
      if (!cKey) return;
      const prev = saldoPrevioPorCliente.get(cKey) || 0;
      const monto = Number(m.monto) || 0;
      if (m.tipo === 'pedido' && m.estado !== 'pagado') {
        saldoPrevioPorCliente.set(cKey, prev + monto);
      } else if (m.tipo === 'pago') {
        saldoPrevioPorCliente.set(cKey, prev - monto);
      }
    }
  });

  let totalCarteraAbiertaPrevia = 0;
  saldoPrevioPorCliente.forEach((saldo) => {
    if (saldo > 0.005) {
      totalCarteraAbiertaPrevia += saldo;
    }
  });

  const deudaExigible28 = totalCarteraAbiertaPrevia + cobrables28;
  let T_ratio = 1;
  if (deudaExigible28 > 0) {
    T_ratio = Math.min(1, Math.max(0, pagos28 / deudaExigible28));
  } else {
    const hayDeudaGlobal = allGroups.some((g) => g.debe > 0.005);
    T_ratio = hayDeudaGlobal ? 0.5 : 1;
  }
  const ptsT = Math.round(40 * T_ratio);

  // 2. Velocidad de cierre de ciclos V (25 pts)
  let sumaVelocidadPonderada = 0;
  let totalMontoCiclosCerrados = 0;

  allGroups.forEach((group) => {
    const sortedMovs = group.movimientos.slice().reverse();
    let balance = 0;
    let cycleStartTs = null;
    let cycleMonto = 0;

    sortedMovs.forEach((m) => {
      const mDate = parseLocalDate(getMovimientoFecha(m));
      const mTs = mDate ? mDate.getTime() : 0;
      const monto = Number(m.monto) || 0;

      if (m.tipo === 'pedido' && m.estado !== 'pagado') {
        if (balance <= 0.005) {
          cycleStartTs = mTs;
          cycleMonto = 0;
        }
        balance += monto;
        cycleMonto += monto;
      } else if (m.tipo === 'pago') {
        balance -= monto;
        if (balance <= 0.005 && cycleStartTs && mDate && mDate >= ventanaInicio) {
          const diasParaCerrar = Math.max(0, (mTs - cycleStartTs) / (1000 * 60 * 60 * 24));
          const scoreCiclo = Math.max(0, 1 - diasParaCerrar / 28);
          sumaVelocidadPonderada += scoreCiclo * cycleMonto;
          totalMontoCiclosCerrados += cycleMonto;
          cycleStartTs = null;
          cycleMonto = 0;
        }
      }
    });
  });

  const V_ratio = totalMontoCiclosCerrados > 0
    ? (sumaVelocidadPonderada / totalMontoCiclosCerrados)
    : 0.5;
  const ptsV = Math.round(25 * V_ratio);

  // 3. Antigüedad sana de cartera abierta A (20 pts)
  let sumaDiasPonderada = 0;
  let totalDeudaAbierta = 0;
  let peorMorosoAntiguo = null;
  let maxDiasMora = 0;

  allGroups.forEach((group) => {
    if (group.debe > 0.005) {
      const cicloActual = getMovimientosCicloActual(group.cliente);
      const primerPedido = cicloActual.find((m) => m.tipo === 'pedido' && m.estado !== 'pagado');
      const fechaPrimer = primerPedido ? parseLocalDate(getMovimientoFecha(primerPedido)) : null;
      const dias = fechaPrimer ? Math.max(0, Math.floor((now - fechaPrimer) / (1000 * 60 * 60 * 24))) : 0;
      sumaDiasPonderada += dias * group.debe;
      totalDeudaAbierta += group.debe;

      if (dias > maxDiasMora) {
        maxDiasMora = dias;
        peorMorosoAntiguo = { cliente: group.cliente, dias, debe: group.debe };
      }
    }
  });

  let A_ratio = 1;
  if (totalDeudaAbierta > 0) {
    const promedioPonderadoDias = sumaDiasPonderada / totalDeudaAbierta;
    // Techo más amplio de 60 días (2 meses) para mantener diferenciación y no saturar inmediatamente en 0
    A_ratio = Math.max(0, 1 - Math.min(1, promedioPonderadoDias / 60));
  }
  const ptsA = Math.round(20 * A_ratio);

  // 4. Racha y cumplimiento de metas R (15 pts) - Evalúa las 4 semanas anteriores cerradas (Defecto 3)
  const meta = getStoredMetaSemanal();
  const { inicio: currInicio } = getWeekRange();

  let semanasCumplidas = 0;
  for (let i = 1; i <= 4; i++) {
    const wStart = new Date(currInicio);
    wStart.setDate(currInicio.getDate() - i * 7);
    const wEnd = new Date(wStart);
    wEnd.setDate(wStart.getDate() + 6);
    wEnd.setHours(23, 59, 59, 999);
    const wRange = { inicio: wStart, fin: wEnd };

    if (semanaCumplioMeta(wRange, meta)) {
      semanasCumplidas++;
    }
  }
  const R_ratio = Math.min(1, semanasCumplidas / 4);
  const ptsR = Math.round(15 * R_ratio);

  // Score final sumado y acotado 0-100
  const scoreTotal = Math.min(100, Math.max(0, ptsT + ptsV + ptsA + ptsR));

  // Determinar Nivel
  let nivelLabel = 'En arranque';
  let nivelColor = '#DC2626';
  let nivelBg = '#FEE2E2';

  if (scoreTotal >= 80) {
    nivelLabel = 'Imparable';
    nivelColor = '#00A859';
    nivelBg = '#D1FAE5';
  } else if (scoreTotal >= 60) {
    nivelLabel = 'Cobrador fuerte';
    nivelColor = '#00B2E3';
    nivelBg = '#E0F7FB';
  } else if (scoreTotal >= 40) {
    nivelLabel = 'Constante';
    nivelColor = '#D97706';
    nivelBg = '#FEF3C7';
  }

  // Siguiente línea de acción derivada del componente más débil en texto plano sin entidades HTML (Defecto 7 / Menor)
  let lineaAccion = '';
  const metaActual = getStoredMetaSemanal();
  const currentWeek = getWeekRange();
  let cobradoEstaSemana = 0;
  movimientosData.forEach((m) => {
    if (m.tipo === 'pago' && isSameWeek(getMovimientoFecha(m), currentWeek)) {
      cobradoEstaSemana += Number(m.monto) || 0;
    }
  });
  const faltaParaMeta = Math.max(0, metaActual - cobradoEstaSemana);

  if (faltaParaMeta > 0 && (ptsT < 28 || ptsR < 10)) {
    lineaAccion = `Cobra ${formatMoney(faltaParaMeta)} esta semana para alcanzar tu meta y subir puntaje.`;
  } else if (peorMorosoAntiguo && peorMorosoAntiguo.dias >= 14 && ptsA < 16) {
    lineaAccion = `La deuda de ${peorMorosoAntiguo.cliente} lleva ${peorMorosoAntiguo.dias} días (${formatMoney(peorMorosoAntiguo.debe)}). Es la más antigua.`;
  } else if (ptsV < 15) {
    lineaAccion = `Cierra ciclos pendientes cobrando los saldos de clientes con pedidos abiertos.`;
  } else if (faltaParaMeta === 0) {
    lineaAccion = `¡Meta semanal superada! Mantén el ritmo para extender tu racha.`;
  } else {
    lineaAccion = `Registra tus cobros a tiempo para mantener tu score en nivel ${nivelLabel}.`;
  }

  return {
    scoreTotal,
    ptsT,
    ptsV,
    ptsA,
    ptsR,
    nivelLabel,
    nivelColor,
    nivelBg,
    lineaAccion,
    pagos28,
    deudaExigible28
  };
}

// Calcula la racha activa de semanas consecutivas cerradas cumpliendo la meta (Defecto 3)
function calculateRachaSemanas() {
  const meta = getStoredMetaSemanal();
  const { inicio: currInicio } = getWeekRange();
  let rachaActual = 0;
  let recordHistorico = 0;
  let tempRacha = 0;

  // Analizar hasta 26 semanas cerradas hacia atrás (i=1 a 26)
  const maxSemanas = 26;
  const resultadosPorSemana = [];

  for (let i = 1; i <= maxSemanas; i++) {
    const wStart = new Date(currInicio);
    wStart.setDate(currInicio.getDate() - i * 7);
    const wEnd = new Date(wStart);
    wEnd.setDate(wStart.getDate() + 6);
    wEnd.setHours(23, 59, 59, 999);
    const wRange = { inicio: wStart, fin: wEnd };

    const cumplio = semanaCumplioMeta(wRange, meta);
    resultadosPorSemana.push(cumplio);
  }

  // Racha activa consecutiva desde la última semana cerrada
  for (let i = 0; i < resultadosPorSemana.length; i++) {
    if (resultadosPorSemana[i]) {
      rachaActual++;
    } else {
      break;
    }
  }

  // Récord histórico en la serie de semanas cerradas
  resultadosPorSemana.slice().reverse().forEach((cumplio) => {
    if (cumplio) {
      tempRacha++;
      if (tempRacha > recordHistorico) recordHistorico = tempRacha;
    } else {
      tempRacha = 0;
    }
  });

  if (rachaActual > recordHistorico) recordHistorico = rachaActual;

  return { rachaActual, recordHistorico };
}

// Calcula el ranking de clientes morosos anclado a referencia configurable (Defecto 7 / Claude Corrección 3)
function calculateRankingMorosos() {
  const now = new Date();
  const allGroups = groupByCliente(movimientosData);
  const deudores = allGroups.filter((g) => g.debe > 0.005);
  const deudaAltaRef = getStoredDeudaAltaRef();

  const ranking = deudores.map((g) => {
    const cicloActual = getMovimientosCicloActual(g.cliente);
    const primerPedido = cicloActual.find((m) => m.tipo === 'pedido' && m.estado !== 'pagado');
    const ultimoPago = g.movimientos.find((m) => m.tipo === 'pago');

    const fechaPrimerPedido = primerPedido ? parseLocalDate(getMovimientoFecha(primerPedido)) : null;
    const fechaUltimoPago = ultimoPago ? parseLocalDate(getMovimientoFecha(ultimoPago)) : null;

    const diasDeuda = fechaPrimerPedido ? Math.max(0, Math.floor((now - fechaPrimerPedido) / (1000 * 60 * 60 * 24))) : 0;
    const diasSinPago = fechaUltimoPago ? Math.max(0, Math.floor((now - fechaUltimoPago) / (1000 * 60 * 60 * 24))) : Math.max(diasDeuda, 28);

    // Fórmula anclada con deudaAltaRef configurable
    const componenteSaldo = 50 * Math.min(1, Math.max(0, g.debe / deudaAltaRef));
    const componenteDiasDeuda = 35 * Math.min(1, diasDeuda / 42);
    const componenteDiasSinPago = 15 * Math.min(1, diasSinPago / 28);

    const prioridad = Math.round(componenteSaldo + componenteDiasDeuda + componenteDiasSinPago);

    return {
      cliente: g.cliente,
      debe: g.debe,
      diasDeuda,
      diasSinPago,
      prioridad,
      ultimoPagoFecha: ultimoPago ? getMovimientoFecha(ultimoPago) : null
    };
  });

  return ranking.sort((a, b) => b.prioridad - a.prioridad);
}

function renderGamificacion() {
  // 1. Render Score
  const scoreData = calculateScoreCobranza();
  const scoreNumeroEl = document.getElementById('score-numero');
  const scoreBadgeEl = document.getElementById('score-nivel-badge');
  const scoreTasaEl = document.getElementById('score-tasa');
  const scoreVelEl = document.getElementById('score-velocidad');
  const scoreAntEl = document.getElementById('score-antiguedad');
  const scoreRachaEl = document.getElementById('score-racha');
  const scoreAccionTextoEl = document.getElementById('score-accion-texto');

  if (scoreNumeroEl) scoreNumeroEl.textContent = scoreData.scoreTotal;
  if (scoreBadgeEl) {
    scoreBadgeEl.textContent = scoreData.nivelLabel;
    scoreBadgeEl.style.color = scoreData.nivelColor;
    scoreBadgeEl.style.background = scoreData.nivelBg;
  }
  if (scoreTasaEl) scoreTasaEl.textContent = `${scoreData.ptsT}/40`;
  if (scoreVelEl) scoreVelEl.textContent = `${scoreData.ptsV}/25`;
  if (scoreAntEl) scoreAntEl.textContent = `${scoreData.ptsA}/20`;
  if (scoreRachaEl) scoreRachaEl.textContent = `${scoreData.ptsR}/15`;
  if (scoreAccionTextoEl) scoreAccionTextoEl.textContent = scoreData.lineaAccion;

  // 2. Render Meta Semanal
  const metaMonto = getStoredMetaSemanal();
  const currentWeek = getWeekRange();
  let cobradoSemanaActual = 0;
  movimientosData.forEach((m) => {
    if (m.tipo === 'pago' && isSameWeek(getMovimientoFecha(m), currentWeek)) {
      cobradoSemanaActual += Number(m.monto) || 0;
    }
  });

  const porcentajeMeta = Math.min(100, Math.round((cobradoSemanaActual / (metaMonto || 1)) * 100));
  const metaProgresoTextoEl = document.getElementById('meta-progreso-texto');
  const metaPorcentajeTextoEl = document.getElementById('meta-porcentaje-texto');
  const metaProgresoBarraEl = document.getElementById('meta-progreso-barra');
  const metaSubtextoEl = document.getElementById('meta-subtexto');

  if (metaProgresoTextoEl) {
    metaProgresoTextoEl.textContent = `${formatMoney(cobradoSemanaActual)} / ${formatMoney(metaMonto)}`;
  }
  if (metaPorcentajeTextoEl) {
    metaPorcentajeTextoEl.textContent = `${porcentajeMeta}%`;
    metaPorcentajeTextoEl.style.color = porcentajeMeta >= 100 ? '#00A859' : '#00B2E3';
  }
  if (metaProgresoBarraEl) {
    metaProgresoBarraEl.style.width = `${porcentajeMeta}%`;
    if (porcentajeMeta >= 100) {
      metaProgresoBarraEl.style.background = 'linear-gradient(90deg, #00A859, #059669)';
    } else {
      metaProgresoBarraEl.style.background = 'linear-gradient(90deg, #00B2E3, #00A859)';
    }
  }
  if (metaSubtextoEl) {
    const falta = Math.max(0, metaMonto - cobradoSemanaActual);
    metaSubtextoEl.textContent = falta > 0
      ? `Faltan ${formatMoney(falta)} para cumplir el objetivo`
      : '¡Objetivo semanal cumplido!';
  }

  // 3. Render Racha (Semanas cerradas + estado de la semana en progreso)
  const { rachaActual, recordHistorico } = calculateRachaSemanas();
  const rachaNumeroEl = document.getElementById('racha-numero');
  const rachaTituloEl = document.getElementById('racha-titulo');
  const rachaDetalleEl = document.getElementById('racha-detalle');
  const rachaRecordEl = document.getElementById('racha-record-label');

  if (rachaNumeroEl) rachaNumeroEl.textContent = rachaActual;
  if (rachaTituloEl) {
    rachaTituloEl.textContent = `${rachaActual} semana${rachaActual !== 1 ? 's' : ''} cerrada${rachaActual !== 1 ? 's' : ''}`;
  }
  if (rachaDetalleEl) {
    const cumplioActual = cobradoSemanaActual >= metaMonto;
    rachaDetalleEl.textContent = cumplioActual
      ? '¡Semana en curso cumplida!'
      : `Semana en curso: ${porcentajeMeta}% completado`;
  }
  if (rachaRecordEl) {
    rachaRecordEl.textContent = `Récord: ${recordHistorico} sem`;
  }

  // 4. Render Ranking de Morosos Priorizado
  renderRankingMorosos();
}

function renderRankingMorosos() {
  const container = document.getElementById('ranking-morosos-lista');
  if (!container) return;

  const ranking = calculateRankingMorosos();

  if (ranking.length === 0) {
    container.innerHTML = `
      <div class="py-4 text-center">
        <span class="material-symbols-outlined text-3xl text-[#00A859] mb-1">check_circle</span>
        <p class="text-xs font-semibold text-on-surface">¡Excelente! No hay clientes con saldo deudor.</p>
      </div>
    `;
    return;
  }

  // Mostrar top 5 más prioritarios
  const topMorosos = ranking.slice(0, 5);

  container.innerHTML = topMorosos
    .map((item, idx) => {
      const clienteEscaped = escapeHtml(item.cliente);
      const prioridadColor = item.prioridad >= 70 ? '#DC2626' : item.prioridad >= 40 ? '#EA580C' : '#00667A';
      const prioridadBg = item.prioridad >= 70 ? '#FEE2E2' : item.prioridad >= 40 ? '#FFEDD5' : '#E0F7FB';

      return `
        <div class="py-2.5 flex items-center justify-between gap-3">
          <div class="flex items-center gap-2.5 min-w-0">
            <span class="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-black shrink-0" style="background: ${prioridadBg}; color: ${prioridadColor};">
              ${idx + 1}
            </span>
            <div class="min-w-0">
              <p class="text-[13px] font-bold text-on-surface truncate">${clienteEscaped}</p>
              <div class="flex items-center gap-2 text-[11px] text-outline truncate">
                <span>${item.diasDeuda} días en mora</span>
                <span>\u00B7</span>
                <span class="font-bold text-[#DC2626]">${formatMoney(item.debe)}</span>
              </div>
            </div>
          </div>
          <div class="flex items-center gap-1.5 shrink-0">
            <span class="text-[10px] font-bold px-1.5 py-0.5 rounded" style="background: ${prioridadBg}; color: ${prioridadColor};" title="Índice de prioridad 0-100">
              P${item.prioridad}
            </span>
            <button type="button" class="btn-compartir-cliente p-1.5 rounded-full hover:bg-surface-container-high transition-colors active:scale-90" data-cliente="${clienteEscaped}" title="Compartir cobro por WhatsApp">
              <span class="material-symbols-outlined text-[16px]" style="color: #00A859;">share</span>
            </button>
          </div>
        </div>
      `;
    })
    .join('');
}

function updatePedidoFechaInfo() {
  const textEl = document.getElementById('pedido-fecha-text');
  if (!textEl) return;
  const hoy = new Date();
  const texto = hoy.toLocaleDateString('es-MX', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
  textEl.textContent = `Se registrará para: ${texto}`;
}

function setModoFormulario(modo) {
  modoFormulario = modo;
  const formPedido = document.getElementById('form-pedido');
  const formPago = document.getElementById('form-pago');
  const btnPedido = document.getElementById('btn-modo-pedido');
  const btnPago = document.getElementById('btn-modo-pago');

  const activeClass =
    'flex-1 h-11 rounded-full font-button text-button flex items-center justify-center gap-sm transition-all btn-gradient text-white';
  const inactiveClass =
    'flex-1 h-11 rounded-full font-button text-button bg-surface-container-high text-on-surface-variant flex items-center justify-center gap-sm transition-all hover:bg-surface-container';

  if (modo === 'pedido') {
    formPedido?.classList.remove('hidden');
    formPago?.classList.add('hidden');
    if (btnPedido) btnPedido.className = activeClass;
    if (btnPago) btnPago.className = inactiveClass;
    updatePedidoFechaInfo();
  } else {
    formPedido?.classList.add('hidden');
    formPago?.classList.remove('hidden');
    if (btnPedido) btnPedido.className = inactiveClass;
    if (btnPago) btnPago.className = activeClass;
    autofillPagoFechaHora();
  }
}

// ============================================
// Autocompletado de clientes
// ============================================
function removeAccents(str) {
  return String(str)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function normalizeClienteKey(name) {
  return removeAccents(name.trim().toLowerCase()).replace(/\s+/g, ' ');
}

// ============================================
// Cache y memoización de clientes y grupos
// ============================================
let cachedUniqueClientes = null;
let cachedCanonicalMap = new Map();
let cachedGlobalGroupMap = null;
let cachedGlobalGroupsArray = null;
let cachedCiclosMap = new Map();

function invalidateClientesCache() {
  cachedUniqueClientes = null;
  cachedCanonicalMap.clear();
  cachedGlobalGroupMap = null;
  cachedGlobalGroupsArray = null;
  cachedCiclosMap.clear();
}

function normalizeClienteNombre(name) {
  return name
    .trim()
    .replace(/\s+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

function getUniqueClientes() {
  if (cachedUniqueClientes) return cachedUniqueClientes;
  cachedUniqueClientes = [...new Set(movimientosData.map((m) => (m.cliente ? m.cliente.trim() : '')).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, 'es')
  );
  return cachedUniqueClientes;
}

function getCanonicalClienteNombre(nombre) {
  const key = normalizeClienteKey(nombre);
  if (!key) return normalizeClienteNombre(nombre);
  if (cachedCanonicalMap.has(key)) return cachedCanonicalMap.get(key);

  const match = getUniqueClientes().find((c) => normalizeClienteKey(c) === key);
  const canonical = match || normalizeClienteNombre(nombre);
  cachedCanonicalMap.set(key, canonical);
  return canonical;
}

function findSimilarClientes(nombre, maxResults = 3) {
  const key = normalizeClienteKey(nombre);
  if (!key || key.length < 2) return [];

  return getUniqueClientes()
    .filter((c) => {
      const ck = normalizeClienteKey(c);
      if (ck === key) return false;
      return ck.includes(key) || key.includes(ck);
    })
    .slice(0, maxResults);
}

async function resolveClienteNombre(rawNombre, inputId) {
  const normalized = normalizeClienteNombre(rawNombre);
  const canonical = getCanonicalClienteNombre(normalized);

  if (findClienteGroup(canonical)) {
    return canonical;
  }

  const similares = findSimilarClientes(normalized);
  if (similares.length === 0) {
    return canonical;
  }

  const lista = similares.map((s) => `• ${s}`).join('\n');
  const usarExistente = confirm(
    `No encontramos "${canonical}" exactamente.\n\n¿Quiso decir uno de estos clientes?\n${lista}\n\nAceptar = usar "${similares[0]}"\nCancelar = crear "${canonical}" como cliente nuevo`
  );

  if (usarExistente) {
    const resolved = similares[0];
    const input = document.getElementById(inputId);
    if (input) input.value = resolved;
    return resolved;
  }

  return canonical;
}

function refreshClienteDatalist() {
  const datalist = document.getElementById('lista-clientes');
  if (!datalist) return;
  datalist.innerHTML = getUniqueClientes()
    .map((c) => `<option value="${escapeHtml(c)}"></option>`)
    .join('');
}

function findClienteGroup(nombre) {
  const key = normalizeClienteKey(nombre);
  if (!key) return null;
  return groupByCliente(movimientosData).find((g) => normalizeClienteKey(g.cliente) === key);
}

function getClienteSaldo(nombre) {
  const group = findClienteGroup(nombre);
  if (!group) return null;
  return {
    debe: group.debe,
    totalVentas: group.totalVentas,
    totalCobrable: group.totalCobrable,
    totalPedido: group.totalVentas,
    totalPagado: group.totalPagado,
  };
}

function renderSugerenciasClientes(inputId, sugerenciasId, similares) {
  const container = document.getElementById(sugerenciasId);
  if (!container) return;

  if (!similares.length) {
    container.className = 'hidden';
    container.innerHTML = '';
    return;
  }

  container.className = 'flex flex-wrap';
  container.innerHTML = similares
    .map(
      (nombre) => `
        <button type="button" class="chip-sugerencia-cliente" data-input-id="${inputId}" data-nombre="${escapeHtml(nombre)}">
          ${escapeHtml(nombre)}
        </button>
      `
    )
    .join('');
}

function updateClienteSaldoHint(inputId, hintId, sugerenciasId) {
  const input = document.getElementById(inputId);
  const hint = document.getElementById(hintId);
  if (!input || !hint) return;

  const saldo = getClienteSaldo(input.value);
  if (saldo) {
    hint.classList.remove('hidden');
    renderSugerenciasClientes(inputId, sugerenciasId, []);
    if (saldo.debe > 0) {
      hint.className = 'font-label-md text-label-md mt-xs text-error';
      hint.textContent = `Cliente existente — Debe: ${formatMoney(saldo.debe)}`;
    } else if (saldo.debe < 0) {
      hint.className = 'font-label-md text-label-md mt-xs text-green-700';
      hint.textContent = `Cliente existente — Saldo a favor: ${formatMoney(Math.abs(saldo.debe))}`;
    } else {
      hint.className = 'font-label-md text-label-md mt-xs text-outline';
      hint.textContent = 'Cliente existente — Al corriente';
    }
    return;
  }

  const similares = findSimilarClientes(input.value);
  if (similares.length) {
    hint.classList.remove('hidden');
    hint.className = 'font-label-md text-label-md mt-xs';
    hint.style.color = '#00667A';
    hint.textContent = '¿Quiso decir uno de estos clientes?';
    renderSugerenciasClientes(inputId, sugerenciasId, similares);
    return;
  }

  hint.classList.add('hidden');
  hint.textContent = '';
  renderSugerenciasClientes(inputId, sugerenciasId, []);
}

function setupClienteAutocomplete() {
  const pairs = [
    ['pedido-cliente', 'hint-pedido-cliente', 'sugerencias-pedido-cliente'],
    ['pago-cliente', 'hint-pago-cliente', 'sugerencias-pago-cliente'],
  ];

  pairs.forEach(([inputId, hintId, sugerenciasId]) => {
    const input = document.getElementById(inputId);
    const refresh = () => updateClienteSaldoHint(inputId, hintId, sugerenciasId);
    input?.addEventListener('input', refresh);
    input?.addEventListener('change', refresh);
  });

  document.addEventListener('click', (event) => {
    const chip = event.target.closest('.chip-sugerencia-cliente');
    if (!chip) return;

    const input = document.getElementById(chip.dataset.inputId);
    if (input) {
      input.value = chip.dataset.nombre;
      input.dispatchEvent(new Event('change'));
    }
  });
}

// ============================================
// Renombrar cliente (masivo)
// ============================================
function openRenameClienteGrupo(clienteNombre) {
  const canonical = getCanonicalClienteNombre(clienteNombre);
  const affected = movimientosData.filter(
    (m) => normalizeClienteKey(m.cliente) === normalizeClienteKey(canonical)
  );
  if (affected.length === 0) return;

  const bodyHtml = `
    <div class="space-y-4">
      <div>
        <label class="block text-xs font-bold text-on-surface-variant mb-1.5 uppercase tracking-wider">Nombre actual</label>
        <input class="form-input w-full rounded-xl bg-surface-container-low px-4 py-3 text-[15px] text-on-surface" value="${escapeHtml(canonical)}" readonly type="text">
      </div>
      <div>
        <label class="block text-xs font-bold text-on-surface-variant mb-1.5 uppercase tracking-wider">Nuevo nombre</label>
        <input class="form-input w-full rounded-xl bg-white px-4 py-3 text-[15px] text-on-surface focus:outline-none transition-all" id="rename-nuevo-nombre" placeholder="Ej. Juan Perez" required type="text" autocomplete="off">
      </div>
      <div id="rename-aviso" class="px-3 py-2 rounded-xl text-[12px] font-semibold" style="background: #FEF3C7; color: #92400E;">
        Se actualizaran <strong>${affected.length}</strong> movimientos.
      </div>
    </div>
  `;

  openModal('Renombrar: ' + escapeHtml(canonical), bodyHtml, async () => {
    const nuevoNombre = document.getElementById('rename-nuevo-nombre')?.value.trim();
    if (!nuevoNombre) {
      alert('Escribe un nuevo nombre.');
      return;
    }

    const nuevoNormalizado = normalizeClienteNombre(nuevoNombre);
    if (normalizeClienteKey(nuevoNormalizado) === normalizeClienteKey(canonical)) {
      closeModal();
      return;
    }

    const existe = getUniqueClientes().find(
      (c) => normalizeClienteKey(c) === normalizeClienteKey(nuevoNormalizado)
    );

    let targetName = nuevoNormalizado;
    if (existe) {
      targetName = getCanonicalClienteNombre(existe);
      const confirmar = confirm(
        escapeHtml(existe) + ' ya existe.\n\n' +
        'Los ' + affected.length + ' movimientos de ' + escapeHtml(canonical) + ' se fusionaran con ' + escapeHtml(targetName) + '.\n\n' +
        'Esto NO se puede deshacer.'
      );
      if (!confirmar) return;
    }

    const btn = document.getElementById('modal-editar-guardar');
    try {
      setButtonLoading(btn, true);
      const { error } = await getSupabase()
        .from('movimientos')
        .update({ cliente: targetName })
        .eq('cliente', canonical);

      if (error) throw error;

      closeModal();
      await fetchMovimientos();
      showSuccessToast('Cliente renombrado a "' + targetName + '".');
    } catch (err) {
      console.error(err);
      alert(formatFriendlyError(err, 'Error al renombrar el cliente.'));
    } finally {
      setButtonLoading(btn, false);
    }
  });
}

// ============================================
// Modal de edición
// ============================================
function openModal(title, bodyHtml, onSave) {
  const modal = document.getElementById('modal-editar');
  document.getElementById('modal-editar-title').textContent = title;
  document.getElementById('modal-editar-body').innerHTML = bodyHtml;
  modalSaveHandler = onSave;
  modal?.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeModal() {
  document.getElementById('modal-editar')?.classList.add('hidden');
  document.getElementById('modal-editar-body').innerHTML = '';
  modalSaveHandler = null;
  document.body.style.overflow = '';
  revokePreviewUrls('preview-modal');
}

function initModal() {
  document.getElementById('modal-editar-cerrar')?.addEventListener('click', closeModal);
  document.getElementById('modal-editar-cancelar')?.addEventListener('click', closeModal);
  document.getElementById('modal-editar')?.addEventListener('click', (e) => {
    if (e.target.id === 'modal-editar') closeModal();
  });
  document.getElementById('modal-editar-guardar')?.addEventListener('click', async () => {
    const btn = document.getElementById('modal-editar-guardar');
    if (!modalSaveHandler) return;
    if (btn) setButtonLoading(btn, true);
    try {
      await modalSaveHandler();
    } catch (err) {
      console.error(err);
      alert(formatFriendlyError(err, 'Error al guardar cambios.'));
    } finally {
      if (btn) setButtonLoading(btn, false);
    }
  });
}

function renderExistingPhotosHtml(urls, prefix) {
  if (!urls?.length) return '';
  return `<div class="flex flex-wrap gap-xs mb-sm">${urls
    .map(
      (url, i) => `
      <div class="w-16 h-16 rounded-lg overflow-hidden bg-surface-container-high shrink-0">
        <a href="${escapeHtml(url)}" target="_blank" rel="noopener">
          <img class="w-full h-full object-cover" src="${escapeHtml(url)}" alt="Foto ${i + 1}">
        </a>
      </div>
    `
    )
    .join('')}</div>`;
}

function openEditMovimiento(id) {
  const mov = movimientosData.find((m) => m.id === id);
  if (!mov) return;

  const esPedido = mov.tipo === 'pedido';
  const fotos = Array.isArray(mov.array_urls_fotos) ? mov.array_urls_fotos : [];
  const fechaVal = normalizeDate(mov.fecha || mov.created_at);
  const horaVal = mov.hora ? String(mov.hora).slice(0, 5) : '';

  let fotosSection = '';
  if (esPedido) {
    fotosSection = `
      <div class="mt-md">
        <label class="block font-label-md text-label-md text-on-surface-variant mb-xs">Fotos actuales</label>
        ${fotos.length ? renderExistingPhotosHtml(fotos, 'pedido') : '<p class="text-outline font-label-md text-label-md mb-sm">Sin fotos</p>'}
        <label class="flex items-center gap-sm font-label-md text-label-md text-on-surface-variant mb-sm">
          <input type="checkbox" id="edit-pedido-reemplazar-fotos"> Reemplazar fotos anteriores
        </label>
        <input accept="image/*" class="hidden" id="edit-fotos-pedido" multiple type="file">
        <div class="w-full h-24 border-2 border-dashed border-outline-variant rounded-xl bg-surface-container-low flex flex-col items-center justify-center cursor-pointer hover:bg-surface-container transition-colors" data-default-label="Agregar fotos" id="dropzone-edit-pedido">
          <span class="font-label-md text-label-md text-outline">Agregar fotos</span>
        </div>
        <div class="preview-grid hidden" id="preview-modal"></div>
      </div>
    `;
  } else {
    const fotosComprobantes = mov.url_foto ? [mov.url_foto, ...fotos] : fotos;
    fotosSection = `
      <div class="mt-md">
        <label class="block font-label-md text-label-md text-on-surface-variant mb-xs">Comprobantes actuales</label>
        ${fotosComprobantes.length ? renderExistingPhotosHtml(fotosComprobantes, 'pago') : '<p class="text-outline font-label-md text-label-md mb-sm">Sin comprobante</p>'}
        <label class="flex items-center gap-sm font-label-md text-label-md text-on-surface-variant mb-sm">
          <input type="checkbox" id="edit-pago-reemplazar-fotos"> Reemplazar comprobantes anteriores
        </label>
        <input accept="image/*" class="hidden" id="edit-foto-pago" multiple type="file">
        <div class="w-full h-24 border-2 border-dashed border-outline-variant rounded-xl bg-surface-container-low flex flex-col items-center justify-center cursor-pointer hover:bg-surface-container transition-colors" data-default-label="Agregar comprobantes" id="dropzone-edit-pago">
          <span class="font-label-md text-label-md text-outline">Agregar comprobantes</span>
        </div>
        <div class="preview-grid hidden" id="preview-modal"></div>
      </div>
    `;
  }

  const bodyHtml = `
    <div class="space-y-md">
      <div>
        <label class="block font-label-md text-label-md text-on-surface-variant mb-xs">Cliente</label>
        <input class="form-input w-full rounded-lg border-outline-variant bg-surface-container-low px-md py-sm" type="text" value="${escapeHtml(mov.cliente)}" readonly>
      </div>
      <div>
        <label class="block font-label-md text-label-md text-on-surface-variant mb-xs">Monto ($)</label>
        <input class="form-input w-full rounded-lg border-outline-variant bg-surface px-md py-sm" id="edit-mov-monto" min="0.01" step="0.01" type="number" value="${Number(mov.monto)}">
      </div>
      <div>
        <label class="block font-label-md text-label-md text-on-surface-variant mb-xs">Descripción</label>
        <input class="form-input w-full rounded-lg border-outline-variant bg-surface px-md py-sm" id="edit-mov-descripcion" type="text" value="${escapeHtml(mov.descripcion || '')}">
      </div>
      ${
        !esPedido
          ? `<div class="grid grid-cols-2 gap-md">
              <div>
                <label class="block font-label-md text-label-md text-on-surface-variant mb-xs">Fecha</label>
                <input class="form-input w-full rounded-lg border-outline-variant bg-surface px-md py-sm" id="edit-mov-fecha" type="date" value="${fechaVal}">
              </div>
              <div>
                <label class="block font-label-md text-label-md text-on-surface-variant mb-xs">Hora</label>
                <input class="form-input w-full rounded-lg border-outline-variant bg-surface px-md py-sm" id="edit-mov-hora" type="time" value="${horaVal}">
              </div>
            </div>`
          : ''
      }
      ${fotosSection}
    </div>
  `;

  openModal(`Editar ${esPedido ? 'pedido' : 'pago'}`, bodyHtml, () => saveEditMovimiento(id));

  if (esPedido) {
    setupDropzone('dropzone-edit-pedido', 'edit-fotos-pedido', 'preview-modal', true);
  } else {
    setupDropzone('dropzone-edit-pago', 'edit-foto-pago', 'preview-modal', true);
  }
}

async function saveEditMovimiento(id) {
  const mov = movimientosData.find((m) => m.id === id);
  if (!mov) return;

  const monto = parseFloat(document.getElementById('edit-mov-monto')?.value);
  const descripcion = document.getElementById('edit-mov-descripcion')?.value.trim();

  if (Number.isNaN(monto) || monto <= 0) {
    alert('Ingrese un monto valido.');
    return;
  }

  const payload = {
    monto,
    descripcion: descripcion || null,
  };

  if (mov.tipo === 'pago') {
    payload.fecha = document.getElementById('edit-mov-fecha')?.value || null;
    payload.hora = document.getElementById('edit-mov-hora')?.value || null;

    let arrayUrlsFotos = Array.isArray(mov.array_urls_fotos) ? [...mov.array_urls_fotos] : [];
    if (mov.url_foto) arrayUrlsFotos = [mov.url_foto, ...arrayUrlsFotos];
    const fotoInput = document.getElementById('edit-foto-pago');
    const reemplazar = document.getElementById('edit-pago-reemplazar-fotos')?.checked;

    if (fotoInput?.files?.length) {
      const newUrls = [];
      for (const file of fotoInput.files) {
        const compressed = await compressImage(file);
        newUrls.push(await uploadToStorage(compressed));
      }
      arrayUrlsFotos = reemplazar ? newUrls : [...arrayUrlsFotos, ...newUrls];
    }
    payload.array_urls_fotos = arrayUrlsFotos;
    payload.url_foto = null;
  } else {
    let arrayUrlsFotos = Array.isArray(mov.array_urls_fotos) ? [...mov.array_urls_fotos] : [];
    const fotosInput = document.getElementById('edit-fotos-pedido');
    const reemplazar = document.getElementById('edit-pedido-reemplazar-fotos')?.checked;

    if (fotosInput?.files?.length) {
      const newUrls = [];
      for (const file of fotosInput.files) {
        const compressed = await compressImage(file);
        newUrls.push(await uploadToStorage(compressed));
      }
      arrayUrlsFotos = reemplazar ? newUrls : [...arrayUrlsFotos, ...newUrls];
    }
    payload.array_urls_fotos = arrayUrlsFotos;
  }

  const { error } = await getSupabase().from('movimientos').update(payload).eq('id', id);
  if (error) throw error;

  closeModal();
  await fetchMovimientos();
  showSuccessToast('Actualizado');
}

function openEditAsociado(id) {
  const asociado = asociadosData.find((a) => a.id === id);
  if (!asociado) return;

  const bodyHtml = `
    <div class="space-y-md">
      <div>
        <label class="block font-label-md text-label-md text-on-surface-variant mb-xs">Nombre Completo</label>
        <input class="form-input w-full rounded-lg border-outline-variant bg-surface px-md py-sm" id="edit-asoc-nombre" type="text" value="${escapeHtml(asociado.nombre_nuevo)}">
      </div>
      <div>
        <label class="block font-label-md text-label-md text-on-surface-variant mb-xs">Teléfono</label>
        <input class="form-input w-full rounded-lg border-outline-variant bg-surface px-md py-sm" id="edit-asoc-telefono" type="tel" value="${escapeHtml(asociado.telefono || '')}">
      </div>
      <div>
        <label class="block font-label-md text-label-md text-on-surface-variant mb-xs">Correo</label>
        <input class="form-input w-full rounded-lg border-outline-variant bg-surface px-md py-sm" id="edit-asoc-correo" type="email" value="${escapeHtml(asociado.correo || '')}">
      </div>
      <div>
        <label class="block font-label-md text-label-md text-on-surface-variant mb-xs">Recomendador</label>
        <input class="form-input w-full rounded-lg border-outline-variant bg-surface px-md py-sm" id="edit-asoc-recomendador" type="text" value="${escapeHtml(asociado.recomendador || '')}">
      </div>
      <div>
        <label class="block font-label-md text-label-md text-on-surface-variant mb-xs">Foto INE actual</label>
        ${
          asociado.url_ine
            ? `<div class="w-full h-32 rounded-lg overflow-hidden bg-surface-container-high mb-sm">
                <a href="${escapeHtml(asociado.url_ine)}" target="_blank" rel="noopener">
                  <img class="w-full h-full object-cover" src="${escapeHtml(asociado.url_ine)}" alt="INE">
                </a>
              </div>`
            : '<p class="text-outline font-label-md text-label-md mb-sm">Sin foto</p>'
        }
        <input accept="image/*" class="hidden" id="edit-foto-ine" type="file">
        <div class="w-full h-24 border-2 border-dashed border-outline-variant rounded-xl bg-surface-container-low flex flex-col items-center justify-center cursor-pointer hover:bg-surface-container transition-colors" data-default-label="Nueva foto INE" id="dropzone-edit-ine">
          <span class="font-label-md text-label-md text-outline">Nueva foto INE</span>
        </div>
        <div class="preview-grid hidden" id="preview-modal"></div>
      </div>
    </div>
  `;

  openModal('Editar asociado', bodyHtml, () => saveEditAsociado(id));
  setupDropzone('dropzone-edit-ine', 'edit-foto-ine', 'preview-modal');
}

async function saveEditAsociado(id) {
  const asociado = asociadosData.find((a) => a.id === id);
  if (!asociado) return;

  const nombre = normalizeClienteNombre(document.getElementById('edit-asoc-nombre')?.value.trim() || '');
  const telefono = document.getElementById('edit-asoc-telefono')?.value.trim();
  const correo = document.getElementById('edit-asoc-correo')?.value.trim();
  const recomendador = document.getElementById('edit-asoc-recomendador')?.value.trim();

  if (!nombre) {
    alert('Ingrese un nombre válido.');
    return;
  }

  const payload = {
    nombre_nuevo: nombre,
    telefono: telefono || null,
    correo: correo || null,
    recomendador: recomendador || null,
  };

  const fotoInput = document.getElementById('edit-foto-ine');
  if (fotoInput?.files?.[0]) {
    const compressed = await compressImage(fotoInput.files[0]);
    payload.url_ine = await uploadToStorage(compressed, 'ine_fotos');
  } else {
    payload.url_ine = asociado.url_ine;
  }

  const { error } = await getSupabase().from('asociados').update(payload).eq('id', id);
  if (error) throw error;

  closeModal();
  await fetchAsociados();
  showSuccessToast('Actualizado');
}

async function confirmDeleteDouble(titulo, detalle) {
  if (!confirm(`${titulo}\n\n${detalle}`)) return false;
  if (!confirm('Confirma de nuevo: sí, eliminar permanentemente.')) return false;
  return true;
}

async function deleteMovimiento(id) {
  const mov = movimientosData.find((m) => m.id === id);
  if (!mov) return;

  const tipo = mov.tipo === 'pedido' ? 'pedido' : 'pago';
  const ok = await confirmDeleteDouble(
    `Eliminar ${tipo}`,
    `${mov.cliente} — ${formatMoney(mov.monto)}\n${formatFecha(getMovimientoFecha(mov))}`
  );
  if (!ok) return;

  const { error } = await getSupabase().from('movimientos').delete().eq('id', id);
  if (error) throw error;

  await fetchMovimientos();
  showSuccessToast('Registro eliminado');
}

async function deleteAsociado(id) {
  const asociado = asociadosData.find((a) => a.id === id);
  if (!asociado) return;

  const ok = await confirmDeleteDouble(
    'Eliminar asociado',
    `${asociado.nombre_nuevo}\n${formatFecha(asociado.created_at)}`
  );
  if (!ok) return;

  const { error } = await getSupabase().from('asociados').delete().eq('id', id);
  if (error) throw error;

  await fetchAsociados();
  showSuccessToast('Asociado eliminado');
}

function setupEditDelegation(containerId, type) {
  const container = document.getElementById(containerId);
  if (!container) return;

  container.addEventListener('click', async (event) => {
    const renameBtn = event.target.closest('.btn-rename-cliente');
    if (renameBtn) {
      openRenameClienteGrupo(renameBtn.dataset.cliente);
      return;
    }

    const shareClienteBtn = event.target.closest('.btn-compartir-cliente');
    if (shareClienteBtn) {
      const icon = shareClienteBtn.innerHTML;
      shareClienteBtn.disabled = true;
      shareClienteBtn.innerHTML = '<span class="material-symbols-outlined text-[14px] animate-spin">progress_activity</span>';
      try {
        await shareClienteWhatsApp(shareClienteBtn.dataset.cliente);
      } finally {
        shareClienteBtn.disabled = false;
        shareClienteBtn.innerHTML = icon;
      }
      return;
    }

    const btnMov = event.target.closest('.btn-editar-movimiento');
    if (btnMov) {
      const id = Number(btnMov.dataset.id);
      if (Number.isNaN(id)) return;
      openEditMovimiento(id);
      return;
    }

    const btnDelMov = event.target.closest('.btn-eliminar-movimiento');
    if (btnDelMov) {
      try {
        const id = Number(btnDelMov.dataset.id);
        if (Number.isNaN(id)) return;
        await deleteMovimiento(Number(btnDelMov.dataset.id));
      } catch (err) {
        console.error(err);
        alert(formatFriendlyError(err, 'Error al eliminar.'));
      }
      return;
    }

    const btnAsoc = event.target.closest('.btn-editar-asociado');
    if (btnAsoc) {
      const id = Number(btnAsoc.dataset.id);
      if (Number.isNaN(id)) return;
      openEditAsociado(id);
      return;
    }

    const btnDelAsoc = event.target.closest('.btn-eliminar-asociado');
    if (btnDelAsoc) {
      try {
        const id = Number(btnDelAsoc.dataset.id);
        if (Number.isNaN(id)) return;
        await deleteAsociado(id);
      } catch (err) {
        console.error(err);
        alert(formatFriendlyError(err, 'Error al eliminar.'));
      }
    }
  });
}

// ============================================
// Navegación
// ============================================
function initNavigation() {
  const btnMenu = document.getElementById('btn-menu');
  const btnCloseMenu = document.getElementById('btn-close-menu');
  const drawerOverlay = document.getElementById('drawer-overlay');
  const navDrawer = document.getElementById('nav-drawer');
  const drawerItems = document.querySelectorAll('.nav-drawer-item');
  const bottomNavItems = document.querySelectorAll('.bottom-nav-item');
  const viewSections = document.querySelectorAll('.view-section');

  if (!drawerOverlay || !navDrawer) return;

  function openDrawer() {
    if (!drawerOverlay || !navDrawer) return;
    drawerOverlay.classList.remove('hidden');
    navDrawer.classList.add('drawer-open');
    navDrawer.classList.remove('-translate-x-full');
    setTimeout(() => drawerOverlay.classList.remove('opacity-0'), 10);
  }

  function closeDrawer() {
    if (!drawerOverlay || !navDrawer) return;
    drawerOverlay.classList.add('opacity-0');
    navDrawer.classList.remove('drawer-open');
    navDrawer.classList.add('-translate-x-full');
    setTimeout(() => drawerOverlay.classList.add('hidden'), 300);
  }

  btnMenu?.addEventListener('click', openDrawer);
  btnCloseMenu?.addEventListener('click', closeDrawer);
  drawerOverlay?.addEventListener('click', closeDrawer);

  function switchView(targetId) {
    viewSections.forEach((section) => section.classList.remove('active'));
    document.getElementById(targetId)?.classList.add('active');

    drawerItems.forEach((item) => {
      if (item.dataset.target === targetId) {
        item.style.background = '#E0F7FB';
        item.style.color = '#00667A';
      } else {
        item.style.background = '';
        item.style.color = '';
      }
    });

    bottomNavItems.forEach((item) => {
      if (item.dataset.target === targetId) {
        item.style.background = 'linear-gradient(135deg, #00B2E3, #002855)';
        item.style.color = 'white';
        item.style.minWidth = '100px';
        item.className = 'bottom-nav-item flex flex-col items-center justify-center rounded-2xl px-6 py-2 transition-all active:scale-90';
      } else {
        item.style.background = '';
        item.style.color = '';
        item.style.minWidth = '100px';
        item.className = 'bottom-nav-item flex flex-col items-center justify-center text-on-surface-variant px-6 py-2 hover:bg-surface-container-high transition-all active:scale-90 rounded-2xl';
      }
    });

    if (!drawerOverlay.classList.contains('hidden')) closeDrawer();
    window.scrollTo({ top: 0, behavior: 'smooth' });

    if (targetId === 'vista-clientes') {
      requestAnimationFrame(() => {
        try {
          chartHistoricoInstance?.resize();
          chartBarrasInstance?.resize();
          chartDonaInstance?.resize();
        } catch {}
      });
    }
  }

  switchViewFn = switchView;

  drawerItems.forEach((item) => item.addEventListener('click', () => switchView(item.dataset.target)));
  bottomNavItems.forEach((item) => item.addEventListener('click', () => switchView(item.dataset.target)));
}

// ============================================
// CRUD Clientes (movimientos)
// ============================================
function getFilteredMovimientos() {
  const nombre = document.getElementById('filtro-clientes-nombre')?.value.trim() || '';
  const fecha = document.getElementById('filtro-clientes-fecha')?.value || '';

  // Filtro de filas por nombre y/o fecha
  let filtered = movimientosData.filter(
    (mov) => matchesName(mov.cliente, nombre) && matchesDate(getMovimientoFecha(mov), fecha)
  );

  // El estado de deuda ('deudores' / 'al-dia') SIEMPRE se determina por el balance global del cliente,
  // NO por los movimientos aislados del día o rango filtrado (Corrección #20).
  if (filtroSaldo !== 'todos') {
    const globalGroups = groupByCliente(movimientosData);
    const globalClientesMap = new Set(
      globalGroups
        .filter((g) => (filtroSaldo === 'deudores' ? g.debe > 0.005 : g.debe <= 0.005))
        .map((g) => normalizeClienteKey(g.cliente))
    );
    filtered = filtered.filter((mov) => globalClientesMap.has(normalizeClienteKey(mov.cliente)));
  }

  if (filtroOrigen === 'online') {
    filtered = filtered.filter((mov) => mov.origen === 'online');
  }

  return filtered;
}

// Agrupa movimientos por cliente calculando:
// - totalVentas: volumen bruto total de todos los pedidos (incluye online/pagados)
// - totalCobrable: pedidos que exigen cobro manual (excluye pedidos online 'pagado')
// - totalPedido: alias compatible de totalVentas
// - totalPagado: total de pagos manuales
// - debe: saldo exigible (totalCobrable - totalPagado)
// - movimientos ordenados por fecha efectiva (getMovimientoDateTime)
function groupByCliente(movimientos) {
  const isGlobal = movimientos === movimientosData;
  if (isGlobal && cachedGlobalGroupsArray) {
    return cachedGlobalGroupsArray;
  }

  const groups = new Map();

  movimientos.forEach((mov) => {
    const rawName = mov.cliente ? String(mov.cliente).trim() : '';
    if (!rawName) return;
    const key = getCanonicalClienteNombre(rawName);
    if (!groups.has(key)) {
      groups.set(key, {
        cliente: key,
        movimientos: [],
        totalVentas: 0,
        totalCobrable: 0,
        totalPedido: 0,
        totalPagado: 0,
      });
    }

    const group = groups.get(key);
    group.movimientos.push(mov);

    if (mov.tipo === 'pedido') {
      const monto = Number(mov.monto) || 0;
      group.totalVentas += monto;
      group.totalPedido += monto;
      // Solo pedidos no pagados previamente con Stripe suman a la deuda a cobrar
      if (mov.estado !== 'pagado') {
        group.totalCobrable += monto;
      }
    } else if (mov.tipo === 'pago') {
      group.totalPagado += Number(mov.monto) || 0;
    }
  });

  const result = Array.from(groups.values())
    .map((group) => ({
      ...group,
      debe: group.totalCobrable - group.totalPagado,
      // Orden cronológico descendente por fecha efectiva (Bug #18 / #19)
      movimientos: group.movimientos.sort((a, b) => {
        const diff = getMovimientoDateTime(b) - getMovimientoDateTime(a);
        if (diff !== 0) return diff;
        const diffCreated = new Date(b.created_at || 0) - new Date(a.created_at || 0);
        if (diffCreated !== 0) return diffCreated;
        return (Number(b.id) || 0) - (Number(a.id) || 0);
      }),
    }))
    .sort((a, b) => a.cliente.localeCompare(b.cliente, 'es'));

  if (isGlobal) {
    cachedGlobalGroupsArray = result;
  }

  return result;
}

function renderMovimientoItem(mov) {
  const clienteSlug = escapeHtml(mov.cliente).replace(/\s+/g, '-');
  const esPedido = mov.tipo === 'pedido';
  const tipoLabel = esPedido ? 'Pedido' : 'Pago';
  const stripeColor = esPedido ? '#002855' : '#00A859';
  const badgeBg = esPedido ? '#E0F0FF' : '#D1FAE5';
  const badgeText = esPedido ? '#00667A' : '#004d26';
  const esOnline = mov.origen === 'online';
  const esPagado = mov.tipo === 'pedido' && mov.estado === 'pagado';
  const fotos = Array.isArray(mov.array_urls_fotos) ? mov.array_urls_fotos : [];
  const descripcion = mov.descripcion ? escapeHtml(mov.descripcion) : '';

  let fotosHtml = '';
  if (mov.url_foto) {
    fotosHtml = photoActionsHtml(mov.url_foto, `${mov.tipo}-${clienteSlug}.jpg`, true);
  } else if (fotos.length) {
    fotosHtml = `<div class="flex gap-1.5 mt-2 overflow-x-auto pb-1">${fotos
      .map(
        (url, i) => `
          <div class="shrink-0">
            <div class="w-12 h-12 rounded-lg overflow-hidden" style="background: #F3F4F6;">
              <a href="${escapeHtml(url)}" target="_blank" rel="noopener">
                <img class="w-full h-full object-cover" src="${escapeHtml(url)}" alt="Foto ${i + 1}" loading="lazy">
              </a>
            </div>
            ${photoActionsHtml(url, `${mov.tipo}-${clienteSlug}-${i + 1}.jpg`, true)}
          </div>
        `
      )
      .join('')}</div>`;
  }

  return `
    <div class="relative pl-3 py-2 first:py-0 mt-2 first:mt-0" style="border-left: 3px solid ${stripeColor};">
      <div class="flex items-start justify-between gap-2">
        <div class="min-w-0">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider"
                  style="background: ${badgeBg}; color: ${badgeText};">${tipoLabel}</span>
            ${esOnline ? '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] sm:text-[10px] font-bold uppercase tracking-wider flex-shrink-0 whitespace-nowrap" style="background: #E0F7FB; color: #00667A;"><span class="material-symbols-outlined text-[12px]">language</span> Online</span>' : ''}
            ${esPagado ? '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] sm:text-[10px] font-bold uppercase tracking-wider flex-shrink-0 whitespace-nowrap" style="background: #D1FAE5; color: #047857;"><span class="material-symbols-outlined text-[12px]">check_circle</span> Pagado</span>' : ''}
            <span class="font-semibold text-on-surface text-[15px]">${formatMoney(mov.monto)}</span>
          </div>
          ${descripcion ? `<p class="text-xs text-outline mt-1">${descripcion}</p>` : ''}
          ${esOnline && mov.usuario_id && perfilesAdminData[mov.usuario_id] ? `
            <div class="flex flex-wrap gap-x-4 gap-y-0.5 mt-1">
              ${perfilesAdminData[mov.usuario_id].telefono ? `<span class="text-[11px] font-semibold text-[#00667A] flex items-center gap-1"><span class="material-symbols-outlined text-[12px]">call</span> ${escapeHtml(perfilesAdminData[mov.usuario_id].telefono)}</span>` : ''}
              ${perfilesAdminData[mov.usuario_id].nombre ? `<span class="text-[11px] text-outline flex items-center gap-1"><span class="material-symbols-outlined text-[12px]">person</span> ${escapeHtml(perfilesAdminData[mov.usuario_id].nombre + ' ' + (perfilesAdminData[mov.usuario_id].apellidos || ''))}</span>` : ''}
              ${perfilesAdminData[mov.usuario_id].ciudad ? `<span class="text-[11px] text-outline flex items-center gap-1"><span class="material-symbols-outlined text-[12px]">location_on</span> ${escapeHtml(perfilesAdminData[mov.usuario_id].ciudad)}</span>` : ''}
            </div>
          ` : ''}
          <p class="text-[11px] text-outline mt-1">
            ${formatFecha(getMovimientoFecha(mov))}${mov.hora ? ` \u00B7 ${formatHora(mov.hora)}` : ''}
          </p>
        </div>
        <div class="flex items-center gap-1 shrink-0">
          <button type="button" class="btn-editar btn-editar-movimiento" data-id="${mov.id}">
            <span class="material-symbols-outlined text-[14px]" data-icon="edit">edit</span>
            Editar
          </button>
          <button type="button" class="btn-eliminar btn-eliminar-movimiento" data-id="${mov.id}" title="Eliminar">
            <span class="material-symbols-outlined text-[14px]">delete</span>
          </button>
        </div>
      </div>
      ${fotosHtml}
    </div>
  `;
}

// Devuelve los movimientos del "ciclo actual" del cliente: los posteriores a
// la última vez que su saldo quedó en cero o a favor.
// Ordenado por fecha efectiva ascendente (Bug #18).
function getMovimientosCicloActual(clienteNombre) {
  const key = normalizeClienteKey(clienteNombre);
  if (!key) return [];
  if (cachedCiclosMap.has(key)) return cachedCiclosMap.get(key);

  const movs = movimientosData
    .filter((m) => normalizeClienteKey(m.cliente) === key)
    .slice()
    .sort((a, b) => {
      const diff = getMovimientoDateTime(a) - getMovimientoDateTime(b);
      if (diff !== 0) return diff;
      const diffCreated = new Date(a.created_at || 0) - new Date(b.created_at || 0);
      if (diffCreated !== 0) return diffCreated;
      return (Number(a.id) || 0) - (Number(b.id) || 0);
    });

  let balance = 0;
  let inicio = 0;
  movs.forEach((m, i) => {
    // Solo pedidos cobrables suman al saldo pendiente
    if (m.tipo === 'pedido' && m.estado !== 'pagado') balance += Number(m.monto);
    else if (m.tipo === 'pago') balance -= Number(m.monto);
    // Cada vez que el saldo llega a cero (o a favor), se cierra el ciclo.
    if (balance <= 0.005) inicio = i + 1;
  });

  const ciclo = movs.slice(inicio);
  cachedCiclosMap.set(key, ciclo);
  return ciclo;
}

function buildClienteWhatsAppText(group) {
  let text = `*Betterorden*\n${group.cliente}\n\n`;

  if (group.debe > 0.005) {
    text += `*Debe: ${formatMoney(group.debe)}*\n`;
  } else if (group.debe < -0.005) {
    text += `✅ Al día (saldo a favor: ${formatMoney(Math.abs(group.debe))})\n`;
  } else {
    text += `✅ Al día. Sin adeudos.\n`;
  }

  return text.trim();
}

function getFotosPedidosCliente(clienteNombre, maxFotos = 12) {
  const seen = new Set();
  const urls = [];

  // Solo fotos del ciclo actual (deuda vigente). Si el cliente está al día,
  // el ciclo está vacío y no se comparte ninguna foto.
  getMovimientosCicloActual(clienteNombre).forEach((m) => {
    const list = [];
    if (m.url_foto) list.push(m.url_foto);
    if (Array.isArray(m.array_urls_fotos)) list.push(...m.array_urls_fotos);
    list.forEach((u) => {
      const clean = typeof u === 'string' ? u.trim() : '';
      if (clean && !seen.has(clean)) {
        seen.add(clean);
        urls.push(clean);
      }
    });
  });

  return urls.slice(0, maxFotos);
}

// Descarga una imagen individual con timeout defensivo y validación
async function fetchImageBlob(url, { timeoutMs = 12000, maxBytes = 15 * 1024 * 1024 } = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: controller.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const blob = await r.blob();
    if (!blob || blob.size === 0) throw new Error('Blob vacío');
    if (blob.size > maxBytes) throw new Error(`Imagen excede límite (${blob.size} bytes)`);
    return blob;
  } finally {
    clearTimeout(timeoutId);
  }
}

// Descarga fotos con reporte de progreso opcional (onProgress(completados, total))
async function descargarFotosBlobs(urls, onProgress) {
  let completados = 0;
  const total = urls.length;
  const blobs = await Promise.all(
    urls.map(async (url) => {
      try {
        const blob = await fetchImageBlob(url);
        completados++;
        if (typeof onProgress === 'function') onProgress(completados, total);
        return blob;
      } catch (err) {
        console.warn('fetch_image_failed:', url, err);
        completados++;
        if (typeof onProgress === 'function') onProgress(completados, total);
        return null;
      }
    })
  );
  return blobs.filter(Boolean);
}

// Decodifica un Blob a Bitmap/Image usando primero createImageBitmap (bypass de CSP)
// con redimensionado temprano (resizeWidth) para evitar picos de memoria masivos,
// y fallback a FileReader + dataUrl. NUNCA usa img.src = blob: dentro del generador.
async function decodeImageBlob(blob, targetSize = 400) {
  if (typeof createImageBitmap === 'function') {
    try {
      const resizeOptions = {
        imageOrientation: 'from-image',
        resizeWidth: targetSize,
        resizeQuality: 'high'
      };
      return await createImageBitmap(blob, resizeOptions);
    } catch {
      try {
        return await createImageBitmap(blob, { imageOrientation: 'from-image' });
      } catch (err) {
        console.warn('createImageBitmap fallback to FileReader:', err);
      }
    }
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('decode_failed_img_onerror'));
      img.src = dataUrl;
    };
    reader.onerror = () => reject(new Error('filereader_failed'));
    reader.readAsDataURL(blob);
  });
}

// Utilidad segura para dibujar rectángulos redondeados con fallback en Safari < 16.4
function drawRoundRectSafe(ctx, x, y, width, height, radius) {
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, width, height, radius);
  } else {
    // Fallback estándar en canvas antiguo
    ctx.rect(x, y, width, height);
  }
}

// Junta varias fotos en un solo collage con cabecera legible de deuda dentro del JPEG.
// WhatsApp descarta el texto cuando lleva archivos, por lo que el estado de cuenta debe
// dibujarse directamente en los pixeles.
async function crearCollageDesdeBlobs(blobs, infoCliente = {}, targetWidth = 1080) {
  if (!blobs || !blobs.length) return null;

  const gap = 12;
  const padding = 16;
  const initialCols = blobs.length >= 5 ? 3 : blobs.length >= 2 ? 2 : 1;
  const celdaEstimate = Math.floor((targetWidth - padding * 2 - (initialCols - 1) * gap) / initialCols);

  // Decodificar todos los blobs ya redimensionados a `celdaEstimate` para no saturar memoria
  const decodedItems = [];
  for (const blob of blobs) {
    try {
      const drawable = await decodeImageBlob(blob, celdaEstimate);
      if (drawable) decodedItems.push(drawable);
    } catch (err) {
      console.warn('decode_failed_item:', err);
    }
  }

  if (!decodedItems.length) return null;

  // Recalcular grid exacto con las imágenes que realmente se pudieron decodificar
  const validCount = decodedItems.length;
  let cols = 1;
  if (validCount >= 5) cols = 3;
  else if (validCount >= 2) cols = 2;

  const rows = Math.ceil(validCount / cols);
  const availableWidth = targetWidth - padding * 2 - (cols - 1) * gap;
  const celda = Math.floor(availableWidth / cols);
  const headerHeight = Math.round(160 * (targetWidth / 1080));

  const canvas = document.createElement('canvas');
  try {
    canvas.width = targetWidth;
    canvas.height = headerHeight + padding + rows * celda + (rows - 1) * gap + padding;

    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas_context_unavailable');

    // Fondo blanco general
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // --- Cabecera de cobranza dentro del JPEG ---
    const grad = ctx.createLinearGradient(0, 0, canvas.width, 0);
    grad.addColorStop(0, '#002855');
    grad.addColorStop(1, '#00B2E3');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, canvas.width, headerHeight);

    // Marca
    const scaleFactor = targetWidth / 1080;
    ctx.fillStyle = '#FFFFFF';
    ctx.font = `bold ${Math.round(36 * scaleFactor)}px sans-serif`;
    ctx.fillText('Betterorden', padding + 8, Math.round(48 * scaleFactor));

    // Subtítulo
    ctx.font = `${Math.round(18 * scaleFactor)}px sans-serif`;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.fillText('Resumen de cuenta y pedidos', padding + 8, Math.round(76 * scaleFactor));

    // Nombre del cliente
    const clienteNombre = infoCliente.cliente || 'Cliente';
    ctx.font = `bold ${Math.round(28 * scaleFactor)}px sans-serif`;
    ctx.fillStyle = '#FFFFFF';
    const boxWidth = Math.round(300 * scaleFactor);
    const boxHeight = Math.round(110 * scaleFactor);
    const boxX = canvas.width - padding - boxWidth;
    const boxY = Math.round(25 * scaleFactor);

    const maxNombreWidth = boxX - padding - 20;
    let nombreRender = clienteNombre;
    if (ctx.measureText(nombreRender).width > maxNombreWidth) {
      while (nombreRender.length > 4 && ctx.measureText(nombreRender + '...').width > maxNombreWidth) {
        nombreRender = nombreRender.slice(0, -1);
      }
      nombreRender += '...';
    }
    ctx.fillText(nombreRender, padding + 8, Math.round(126 * scaleFactor));

    // Fecha / Hora de corte
    const fechaCorte = new Date().toLocaleDateString('es-MX', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
    ctx.font = `${Math.round(15 * scaleFactor)}px sans-serif`;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
    ctx.fillText(`Corte: ${fechaCorte}`, padding + 8, Math.round(148 * scaleFactor));

    // Caja de Estado / Saldo a la derecha
    const saldo = typeof infoCliente.debe === 'number' ? infoCliente.debe : 0;
    const esDeuda = saldo > 0.005;
    const esFavor = saldo < -0.005;

    ctx.fillStyle = esDeuda ? '#FEF2F2' : '#ECFDF5';
    ctx.strokeStyle = esDeuda ? '#DC2626' : '#00A859';
    ctx.lineWidth = Math.max(2, Math.round(3 * scaleFactor));
    ctx.beginPath();
    drawRoundRectSafe(ctx, boxX, boxY, boxWidth, boxHeight, Math.round(14 * scaleFactor));
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = esDeuda ? '#991B1B' : '#065F46';
    ctx.font = `bold ${Math.round(16 * scaleFactor)}px sans-serif`;
    ctx.textAlign = 'center';
    const labelTexto = esDeuda ? 'TOTAL A PAGAR' : esFavor ? 'SALDO A FAVOR' : 'CUENTA AL DÍA';
    ctx.fillText(labelTexto, boxX + boxWidth / 2, boxY + Math.round(35 * scaleFactor));

    ctx.font = `bold ${Math.round(32 * scaleFactor)}px sans-serif`;
    ctx.fillStyle = esDeuda ? '#DC2626' : '#00A859';
    const montoTexto = formatMoney(Math.abs(saldo));
    ctx.fillText(montoTexto, boxX + boxWidth / 2, boxY + Math.round(78 * scaleFactor));
    ctx.textAlign = 'left';

    // --- Dibujar miniaturas de pedidos en cuadrícula ---
    const gridStartY = headerHeight + padding;
    decodedItems.forEach((img, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = padding + col * (celda + gap);
      const y = gridStartY + row * (celda + gap);

      const imgW = img.width || 1;
      const imgH = img.height || 1;
      const escala = Math.max(celda / imgW, celda / imgH);
      const dw = imgW * escala;
      const dh = imgH * escala;
      const dx = x + (celda - dw) / 2;
      const dy = y + (celda - dh) / 2;

      ctx.save();
      ctx.beginPath();
      drawRoundRectSafe(ctx, x, y, celda, celda, Math.round(10 * scaleFactor));
      ctx.clip();
      ctx.drawImage(img, dx, dy, dw, dh);

      // Borde sutil para cada foto
      ctx.strokeStyle = 'rgba(0,0,0,0.08)';
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, celda, celda);
      ctx.restore();
    });

    let blob = await canvasToJpegBlob(canvas, 0.8);
    // Reintento con dimensiones/calidad reducidas si exporta null (Paso 6 del plan)
    if (!blob && targetWidth > 720) {
      console.warn('Reintentando collage con resolución 720px y calidad 0.68...');
      return await crearCollageDesdeBlobs(blobs, infoCliente, 720);
    }

    if (!blob) throw new Error('canvas_export_failed');

    const safeCliente = (infoCliente.cliente || 'cliente').toLowerCase().replace(/[^a-z0-9]/g, '_');
    return new File([blob], `cobro_${safeCliente}.jpg`, { type: 'image/jpeg' });
  } finally {
    // Liberar memoria de ImageBitmaps
    decodedItems.forEach((item) => {
      if (typeof item.close === 'function') {
        try { item.close(); } catch {}
      }
    });
    canvas.width = 0;
    canvas.height = 0;
  }
}

// Exporta un canvas a JPEG de forma robusta. En caso de ausencia o fallo de toBlob,
// convierte toDataURL mediante atob -> Uint8Array -> Blob sin hacer peticiones fetch (que fallarían por CSP).
async function canvasToJpegBlob(canvas, quality = 0.8) {
  const viaToBlob = await new Promise((resolve) => {
    if (typeof canvas.toBlob !== 'function') {
      resolve(null);
      return;
    }
    try {
      canvas.toBlob(resolve, 'image/jpeg', quality);
    } catch (err) {
      console.warn('canvas.toBlob failed:', err);
      resolve(null);
    }
  });
  if (viaToBlob) return viaToBlob;

  try {
    const dataUrl = canvas.toDataURL('image/jpeg', quality);
    const parts = dataUrl.split(',');
    if (parts.length !== 2) throw new Error('data_url_invalid');
    const binary = atob(parts[1]);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new Blob([bytes], { type: 'image/jpeg' });
  } catch (err) {
    console.error('canvasToJpegBlob fallback conversion error:', err);
    return null;
  }
}

// Estado del modal de compartir en 2 tiempos
let currentShareState = {
  clienteNombre: '',
  group: null,
  text: '',
  file: null,
  previewObjectUrl: null,
};

function cleanupShareModalState() {
  if (currentShareState.previewObjectUrl) {
    URL.revokeObjectURL(currentShareState.previewObjectUrl);
    currentShareState.previewObjectUrl = null;
  }
  currentShareState = {
    clienteNombre: '',
    group: null,
    text: '',
    file: null,
    previewObjectUrl: null,
  };
}

// Abre el modal de compartir y prepara el collage en segundo plano.
// El tap final en "Compartir WhatsApp" será el que invoque navigator.share de forma inmediata
// para no perder la activación de usuario en Safari / WebViews.
async function openShareClienteModal(clienteNombre) {
  if (!clienteNombre) return;
  const group = groupByCliente(movimientosData).find(
    (g) => normalizeClienteKey(g.cliente) === normalizeClienteKey(clienteNombre)
  );
  if (!group) return;

  cleanupShareModalState();

  const modal = document.getElementById('modal-compartir-cobro');
  const infoEl = document.getElementById('modal-compartir-info');
  const progresoEl = document.getElementById('modal-compartir-progreso');
  const progresoTexto = document.getElementById('modal-compartir-progreso-texto');
  const previewWrap = document.getElementById('modal-compartir-preview-wrap');
  const previewImg = document.getElementById('modal-compartir-preview-img');
  const errorEl = document.getElementById('modal-compartir-error');
  const btnDescargar = document.getElementById('modal-compartir-btn-descargar');
  const btnShare = document.getElementById('modal-compartir-btn-share');

  if (!modal) {
    // Fallback si no está el modal en DOM
    await shareClienteWhatsAppDirect(group);
    return;
  }

  const text = buildClienteWhatsAppText(group);
  currentShareState.clienteNombre = clienteNombre;
  currentShareState.group = group;
  currentShareState.text = text;

  const saldoColor = group.debe > 0 ? '#DC2626' : group.debe < 0 ? '#00A859' : '#00B2E3';
  const saldoLabel = group.debe > 0 ? 'Debe' : group.debe < 0 ? 'Saldo a favor' : 'Al corriente';
  infoEl.innerHTML = `
    <div class="flex justify-between items-center">
      <span class="font-bold text-base text-on-surface">${escapeHtml(group.cliente)}</span>
      <span class="font-bold px-2.5 py-0.5 rounded-full text-xs" style="background: ${saldoColor}18; color: ${saldoColor};">
        ${saldoLabel}: ${formatMoney(Math.abs(group.debe))}
      </span>
    </div>
    <p class="text-xs text-outline mt-1">Se preparará el resumen para compartir por WhatsApp.</p>
  `;

  progresoEl.classList.remove('hidden');
  previewWrap.classList.add('hidden');
  errorEl.classList.add('hidden');
  btnDescargar.classList.add('hidden');
  modal.classList.remove('hidden');

  const fotoUrls = getFotosPedidosCliente(clienteNombre);

  if (!fotoUrls.length) {
    progresoEl.classList.add('hidden');
    infoEl.innerHTML += `<p class="text-xs text-on-surface-variant mt-2 italic">Sin fotos de pedidos en el ciclo actual. Se compartirá resumen en texto.</p>`;
    return;
  }

  progresoTexto.textContent = `Descargando fotos (0/${fotoUrls.length})...`;

  try {
    const blobs = await descargarFotosBlobs(fotoUrls, (completados, total) => {
      progresoTexto.textContent = `Descargando fotos (${completados}/${total})...`;
    });

    if (blobs.length) {
      progresoTexto.textContent = 'Generando collage con cabecera de cuenta...';
      const file = await crearCollageDesdeBlobs(blobs, {
        cliente: group.cliente,
        debe: group.debe
      });

      if (file) {
        currentShareState.file = file;
        currentShareState.previewObjectUrl = URL.createObjectURL(file);
        previewImg.src = currentShareState.previewObjectUrl;
        previewWrap.classList.remove('hidden');
        btnDescargar.classList.remove('hidden');
      }
    }
  } catch (err) {
    console.error('collage_preparation_failed:', err);
    errorEl.textContent = 'No se pudo generar el collage de imágenes. Se podrá compartir el mensaje de texto.';
    errorEl.classList.remove('hidden');
  } finally {
    progresoEl.classList.add('hidden');
  }
}

// Acción inmediata al pulsar "Compartir WhatsApp" en el modal.
// Se invoca navigator.share PRIMERO para no consumir la activación del usuario (gesture token).
async function executeShareFromModal() {
  const { group, text, file } = currentShareState;
  if (!group) return;

  const modal = document.getElementById('modal-compartir-cobro');

  // Copiar al portapapeles en segundo plano sin bloquear (sin await antes de share)
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    navigator.clipboard.writeText(text).then(() => {
      showSuccessToast('Mensaje copiado al portapapeles');
    }).catch(() => {});
  }

  if (file && navigator.share && navigator.canShare) {
    const sharePayload = { files: [file] };
    if (navigator.canShare(sharePayload)) {
      try {
        await navigator.share({
          title: `Betterorden - ${group.cliente}`,
          text: text,
          files: [file]
        });
        if (modal) modal.classList.add('hidden');
        cleanupShareModalState();
        return;
      } catch (err) {
        if (err?.name === 'AbortError') return;
        console.warn('navigator.share with collage failed:', err);
      }
    }
  }

  if (navigator.share) {
    try {
      await navigator.share({
        title: `Betterorden - ${group.cliente}`,
        text: text
      });
      if (modal) modal.classList.add('hidden');
      cleanupShareModalState();
      return;
    } catch (err) {
      if (err?.name === 'AbortError') return;
    }
  }

  // Si no hay Web Share, abrir WhatsApp Web / App
  window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
  if (modal) modal.classList.add('hidden');
  cleanupShareModalState();
}

// Fallback de compatibilidad
async function shareClienteWhatsApp(clienteNombre) {
  openShareClienteModal(clienteNombre);
}

function renderClientes() {
  const container = document.getElementById('historial-clientes');
  if (!container) return;

  updateChipCounts();
  renderDashboard();
  const filtered = getFilteredMovimientos();
  const groups = groupByCliente(filtered);

  if (movimientosData.length === 0) {
    renderEmptyState(container, 'No hay movimientos registrados.');
    return;
  }

  if (groups.length === 0) {
    renderEmptyState(container, 'No hay clientes que coincidan con la búsqueda.');
    return;
  }

  container.innerHTML = groups
    .map((group) => {
      const cliente = escapeHtml(group.cliente);
      const borderColor = group.debe > 0 ? '#DC2626' : group.debe < 0 ? '#00A859' : '#00B2E3';
      const cardBg = group.debe > 0 ? '#FEF2F2' : group.debe < 0 ? '#ECFDF5' : '#FFFFFF';
      const debeClass =
        group.debe > 0
          ? 'font-bold'
          : group.debe < 0
            ? 'font-bold'
            : 'font-bold';
      const debeColor = group.debe > 0 ? '#DC2626' : group.debe < 0 ? '#00A859' : '#00B2E3';
      const debeLabel =
        group.debe > 0 ? 'Debe' : group.debe < 0 ? 'Saldo a favor' : 'Al corriente';

      return `
        <div class="rounded-2xl p-4 flex gap-3 items-start transition-all" style="background: ${cardBg}; border-left: 4px solid ${borderColor}; box-shadow: 0 1px 4px rgba(0,0,0,0.05);">
          <div class="w-11 h-11 rounded-full flex items-center justify-center font-bold text-sm shrink-0"
               style="background: ${borderColor}18; color: ${borderColor};">
            ${getInitials(group.cliente)}
          </div>
          <div class="flex-1 min-w-0">
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0">
                <h4 class="font-semibold text-on-surface truncate text-[15px]">${cliente}</h4>
                <button type="button" class="btn-rename-cliente p-1.5 rounded-full hover:bg-surface-container-high transition-colors active:scale-90 ml-1 shrink-0" data-cliente="${escapeHtml(group.cliente)}" title="Renombrar cliente">
                  <span class="material-symbols-outlined text-[14px]" style="color: #92400E;">edit_square</span>
                </button>
                <button type="button" class="btn-compartir-cliente p-1.5 rounded-full hover:bg-surface-container-high transition-colors active:scale-90 ml-1 shrink-0" data-cliente="${escapeHtml(group.cliente)}" title="Compartir por WhatsApp">
                  <span class="material-symbols-outlined text-[14px]" style="color: #00A859;">share</span>
                </button>
                <div class="flex gap-3 mt-0.5 text-[11px] text-outline flex-wrap">
                  <span>Cobrable: ${formatMoney(group.totalCobrable)}</span>
                  <span>Pagado: ${formatMoney(group.totalPagado)}</span>
                  ${group.totalVentas !== group.totalCobrable ? `<span>Total pedidos: ${formatMoney(group.totalVentas)}</span>` : ''}
                </div>
              </div>
              <div class="text-right shrink-0">
                <p class="text-[11px]" style="color: ${debeColor};">${debeLabel}</p>
                <p class="text-base ${debeClass}" style="color: ${debeColor};">${formatMoney(Math.abs(group.debe))}</p>
              </div>
            </div>
            <div class="mt-2">
              ${group.movimientos.map(renderMovimientoItem).join('')}
            </div>
          </div>
        </div>
      `;
    })
    .join('');
}

async function fetchMovimientos() {
  const container = document.getElementById('historial-clientes');
  if (!container) return;

  const scrollY = window.scrollY;

  try {
    const { data, error } = await getSupabase()
      .from('movimientos')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;

    movimientosData = data || [];
    invalidateClientesCache();
    await fetchPerfilesAdmin();
    refreshClienteDatalist();
    renderClientes();
    renderPedidosSemanales();
    renderHistorialSemanas();
    updateCharts();
    renderGamificacion();
    requestAnimationFrame(() => window.scrollTo({ top: scrollY, behavior: 'instant' }));
  } catch (err) {
    console.error(err);
    renderEmptyState(container, 'Error al cargar movimientos.');
  }
}

async function handlePedidoSubmit(event) {
  event.preventDefault();

  const btn = document.getElementById('btn-guardar-pedido');
  const rawCliente = document.getElementById('pedido-cliente')?.value.trim();
  const monto = parseFloat(document.getElementById('pedido-monto')?.value);
  const descripcion = document.getElementById('pedido-descripcion')?.value.trim();
  const fotosInput = document.getElementById('input-fotos-pedido');

  if (!rawCliente) {
    alert('El nombre del cliente es obligatorio.');
    return;
  }

  if (Number.isNaN(monto) || monto <= 0) {
    alert('Ingrese un monto válido.');
    return;
  }

  const cliente = await resolveClienteNombre(rawCliente, 'pedido-cliente');
  if (!cliente) return;

  if (btn) setButtonLoading(btn, true);

  try {
    const arrayUrlsFotos = [];

    if (fotosInput?.files?.length) {
      for (const file of fotosInput.files) {
        const compressed = await compressImage(file);
        const url = await uploadToStorage(compressed);
        arrayUrlsFotos.push(url);
      }
    }

    const { error } = await getSupabase().from('movimientos').insert({
      cliente,
      tipo: 'pedido',
      monto,
      descripcion: descripcion || null,
      array_urls_fotos: arrayUrlsFotos,
      fecha: getTodayLocalDateString(),
    });

    if (error) throw error;

    document.getElementById('form-pedido')?.reset();
    if (fotosInput) fotosInput.value = '';
    clearFilePreview('preview-pedido', 'dropzone-pedido', 'Seleccionar Imágenes', true);
    updatePedidoFechaInfo();

    await fetchMovimientos();
    showSuccessToast('Pedido guardado', {
      actionLabel: 'Ver en Pedidos',
      onAction: () => switchViewFn?.('vista-pedidos'),
    });
  } catch (err) {
    console.error(err);
    alert(formatFriendlyError(err, 'Error al guardar el pedido.'));
  } finally {
    if (btn) setButtonLoading(btn, false);
  }
}

async function handlePagoSubmit(event) {
  event.preventDefault();

  const btn = document.getElementById('btn-guardar-pago');
  const rawCliente = document.getElementById('pago-cliente')?.value.trim();
  const monto = parseFloat(document.getElementById('pago-monto')?.value);
  const descripcion = document.getElementById('pago-descripcion')?.value.trim();
  const fecha = document.getElementById('pago-fecha')?.value;
  const hora = document.getElementById('pago-hora')?.value;
  const fotoInput = document.getElementById('input-foto-pago');

  if (!rawCliente) {
    alert('El nombre del cliente es obligatorio.');
    return;
  }

  if (Number.isNaN(monto) || monto <= 0) {
    alert('Ingrese un monto válido.');
    return;
  }

  const cliente = await resolveClienteNombre(rawCliente, 'pago-cliente');
  if (!cliente) return;

  if (btn) setButtonLoading(btn, true);

  try {
    const arrayUrlsFotos = [];

    if (fotoInput?.files?.length) {
      for (const file of fotoInput.files) {
        const compressed = await compressImage(file);
        const url = await uploadToStorage(compressed);
        arrayUrlsFotos.push(url);
      }
    }

    const { error } = await getSupabase().from('movimientos').insert({
      cliente,
      tipo: 'pago',
      monto,
      descripcion: descripcion || null,
      array_urls_fotos: arrayUrlsFotos,
      fecha,
      hora,
    });

    if (error) throw error;

    document.getElementById('form-pago')?.reset();
    autofillPagoFechaHora();
    if (fotoInput) fotoInput.value = '';
    clearFilePreview('preview-pago', 'dropzone-pago', 'Subir Comprobantes');

    await fetchMovimientos();
    showSuccessToast();
  } catch (err) {
    console.error(err);
    alert(formatFriendlyError(err, 'Error al guardar el pago.'));
  } finally {
    if (btn) setButtonLoading(btn, false);
  }
}

// ============================================
// CRUD Altas (Asociados)
// ============================================
function getFilteredAsociados() {
  const nombre = document.getElementById('filtro-altas-nombre')?.value.trim() || '';
  const fecha = document.getElementById('filtro-altas-fecha')?.value || '';

  let filtered = asociadosData.filter(
    (asociado) =>
      matchesName(asociado.nombre_nuevo, nombre) && matchesDate(asociado.created_at, fecha)
  );

  if (filtroAltasSaldo !== 'todos') {
    const groups = groupByCliente(movimientosData);
    const deudores = new Set(
      groups.filter((g) => g.debe > 0).map((g) => g.cliente.toLowerCase())
    );
    filtered = filtered.filter((asoc) => {
      const esDeudor = deudores.has(asoc.nombre_nuevo.trim().toLowerCase());
      return filtroAltasSaldo === 'deudores' ? esDeudor : !esDeudor;
    });
  }

  return filtered;
}

function renderAsociados() {
  const container = document.getElementById('historial-altas');
  if (!container) return;

  updateChipCounts();
  const data = getFilteredAsociados();

  if (asociadosData.length === 0) {
    renderEmptyState(container, 'No hay asociados registrados.');
    return;
  }

  if (data.length === 0) {
    renderEmptyState(container, 'No hay asociados que coincidan con la búsqueda.');
    return;
  }

  container.innerHTML = data
    .map((asociado) => {
      const nombre = escapeHtml(asociado.nombre_nuevo);
      const fotoUrl = asociado.url_ine || '';
      const fotoFilename = `ine-${nombre.replace(/\s+/g, '-')}.jpg`;

      return `
        <div class="rounded-2xl p-4 flex flex-col gap-3 transition-all" style="background: #FFFFFF; border-left: 4px solid #00B2E3; box-shadow: 0 1px 4px rgba(0,0,0,0.05);">
          <div class="flex items-center gap-3">
            <div class="w-11 h-11 rounded-full flex items-center justify-center font-bold text-sm shrink-0"
                 style="background: #E0F7FB; color: #00667A;">
              ${getInitials(asociado.nombre_nuevo)}
            </div>
            <div class="flex-1 min-w-0">
              <h4 class="font-semibold text-on-surface truncate text-[15px]">${nombre}</h4>
              ${
                asociado.recomendador
                  ? `<p class="text-[11px] text-outline truncate">Recomendada por: ${escapeHtml(asociado.recomendador)}</p>`
                  : ''
              }
              ${
                asociado.telefono
                  ? `<p class="text-[11px] text-outline">${escapeHtml(asociado.telefono)}</p>`
                  : ''
              }
              <p class="text-[11px] text-outline mt-1">${formatFecha(asociado.created_at)}</p>
            </div>
            <div class="flex items-center gap-2 shrink-0">
              <button type="button" class="btn-editar btn-editar-asociado" data-id="${asociado.id}">
                <span class="material-symbols-outlined text-[14px]" data-icon="edit">edit</span>
                Editar
              </button>
              <button type="button" class="btn-eliminar btn-eliminar-asociado" data-id="${asociado.id}" title="Eliminar">
                <span class="material-symbols-outlined text-[14px]">delete</span>
              </button>
            </div>
          </div>
          ${
            fotoUrl
              ? `<div>
                  <div class="w-full h-32 rounded-xl overflow-hidden" style="background: #F3F4F6;">
                    <a href="${escapeHtml(fotoUrl)}" target="_blank" rel="noopener">
                      <img class="w-full h-full object-cover" src="${escapeHtml(fotoUrl)}" alt="INE de ${nombre}" loading="lazy">
                    </a>
                  </div>
                  ${photoActionsHtml(fotoUrl, fotoFilename)}
                </div>`
              : ''
          }
        </div>
      `;
    })
    .join('');
}

async function fetchAsociados() {
  const container = document.getElementById('historial-altas');
  if (!container) return;

  try {
    const { data, error } = await getSupabase()
      .from('asociados')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;

    asociadosData = data || [];
    renderAsociados();
  } catch (err) {
    console.error(err);
    renderEmptyState(container, 'Error al cargar asociados.');
  }
}

async function handleAltasSubmit(event) {
  event.preventDefault();

  const btn = document.getElementById('btn-guardar-asociado');
  const nombre = normalizeClienteNombre(document.getElementById('altas-nombre')?.value.trim() || '');
  const telefono = document.getElementById('altas-telefono')?.value.trim();
  const correo = document.getElementById('altas-correo')?.value.trim();
  const recomendador = document.getElementById('altas-recomendador')?.value.trim();
  const fotoInput = document.getElementById('input-foto-ine');

  if (!nombre) {
    alert('Ingrese un nombre válido.');
    return;
  }

  if (btn) setButtonLoading(btn, true);

  try {
    let urlIne = null;

    if (fotoInput?.files?.[0]) {
      const compressed = await compressImage(fotoInput.files[0]);
      urlIne = await uploadToStorage(compressed, 'ine_fotos');
    }

    const { error } = await getSupabase().from('asociados').insert({
      nombre_nuevo: nombre,
      telefono: telefono || null,
      correo: correo || null,
      recomendador: recomendador || null,
      url_ine: urlIne,
    });

    if (error) throw error;

    document.getElementById('form-altas')?.reset();
    if (fotoInput) fotoInput.value = '';
    clearFilePreview('preview-ine', 'dropzone-ine', 'Subir Identificación');

    await fetchAsociados();
    showSuccessToast();
  } catch (err) {
    console.error(err);
    alert(formatFriendlyError(err, 'Error al guardar el asociado.'));
  } finally {
    if (btn) setButtonLoading(btn, false);
  }
}

// ============================================
// Filtros de saldo (deudores / al día)
// ============================================
function updateChipCounts() {
  const groups = groupByCliente(movimientosData);
  const total = groups.length;
  const deudores = groups.filter((g) => g.debe > 0.005).length;
  const alDia = total - deudores;

  const onlineClientKeys = new Set(
    movimientosData
      .filter((m) => m.origen === 'online' && m.cliente)
      .map((m) => normalizeClienteKey(m.cliente))
  );

  const setCount = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };
  setCount('count-todos', total);
  setCount('count-deudores', deudores);
  setCount('count-al-dia', alDia);
  setCount('count-online', onlineClientKeys.size);

  const allAsoc = asociadosData.length;
  const deudoresSet = new Set(groups.filter((g) => g.debe > 0.005).map((g) => normalizeClienteKey(g.cliente)));
  const asocDeudores = asociadosData.filter((a) => a.nombre_nuevo && deudoresSet.has(normalizeClienteKey(a.nombre_nuevo))).length;
  const asocAlDia = allAsoc - asocDeudores;

  setCount('count-altas-todos', allAsoc);
  setCount('count-altas-deudores', asocDeudores);
  setCount('count-altas-al-dia', asocAlDia);

  // Semanal
  const currentWeek = getWeekRange();
  const semanalGroups = groupByCliente(
    movimientosData.filter(
      (m) => m.tipo === 'pedido' && isSameWeek(getMovimientoFecha(m), currentWeek)
    )
  );
  const semanalSaldoMap = new Map(groups.map((g) => [normalizeClienteKey(g.cliente), g.debe]));
  const semanalDeudores = semanalGroups.filter(
    (g) => (semanalSaldoMap.get(normalizeClienteKey(g.cliente)) || 0) > 0.005
  ).length;
  const semanalAlDia = semanalGroups.length - semanalDeudores;

  setCount('count-semanal-todos', semanalGroups.length);
  setCount('count-semanal-deudores', semanalDeudores);
  setCount('count-semanal-al-dia', semanalAlDia);
}

function setupChipFiltro(containerId, renderFn, setFiltroFn) {
  const container = document.getElementById(containerId);
  if (!container) return;

  container.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip-filtro');
    if (!chip) return;

    container.querySelectorAll('.chip-filtro').forEach((c) => c.classList.remove('active'));
    chip.classList.add('active');
    setFiltroFn(chip.dataset.filtro);
    renderFn();
  });
}

// ============================================
// Pedidos Semanales
// ============================================
function getWeekRange(referenceDate) {
  const d = referenceDate ? parseLocalDate(referenceDate) : new Date();
  if (!d) {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    return getWeekRange(formatDateKey(now));
  }
  d.setHours(0, 0, 0, 0);

  const daysSinceFriday = (d.getDay() + 2) % 7;

  const inicio = new Date(d);
  inicio.setDate(d.getDate() - daysSinceFriday);
  inicio.setHours(0, 0, 0, 0);

  const fin = new Date(inicio);
  fin.setDate(inicio.getDate() + 6);
  fin.setHours(23, 59, 59, 999);

  return { inicio, fin };
}

function formatDateShort(date) {
  const d = new Date(date);
  const day = d.getDate();
  const months = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  return `${day} ${months[d.getMonth()]}`;
}

function getCurrentWeekLabel() {
  const { inicio, fin } = getWeekRange();
  return `Semana: Vie ${formatDateShort(inicio)} - Jue ${formatDateShort(fin)}`;
}

function getNextResetLabel() {
  const { fin } = getWeekRange();
  const reset = new Date(fin);
  reset.setDate(fin.getDate() + 1);
  return `Reinicia el vie ${formatDateShort(reset)}`;
}

function renderSemanaBadge() {
  const badge = document.getElementById('semana-actual-badge');
  if (!badge) return;
  badge.innerHTML = `
    <div>${getCurrentWeekLabel()}</div>
    <div class="text-[11px] font-semibold normal-case tracking-normal mt-0.5 opacity-90">${getNextResetLabel()}</div>
  `;
}

function isSameWeek(dateStr, weekRange) {
  return isDateInRange(dateStr, weekRange.inicio, weekRange.fin);
}

function getWeekKey(dateStr) {
  const { inicio } = getWeekRange(dateStr);
  return formatDateKey(inicio);
}

function getWeekLabelFromKey(key) {
  const { inicio, fin } = getWeekRange(key);
  return `Vie ${formatDateShort(inicio)} - Jue ${formatDateShort(fin)}`;
}

function getFilteredPedidosSemanales() {
  const nombre = document.getElementById('filtro-semanal-nombre')?.value.trim() || '';
  const currentWeek = getWeekRange();

  let weekPedidos = movimientosData.filter(
    (m) => m.tipo === 'pedido' && isSameWeek(getMovimientoFecha(m), currentWeek) && matchesName(m.cliente, nombre)
  );

  if (filtroSemanalSaldo !== 'todos') {
    const allGroups = groupByCliente(movimientosData);
    const deudores = new Set(
      allGroups.filter((g) => g.debe > 0).map((g) => normalizeClienteKey(g.cliente))
    );
    weekPedidos = weekPedidos.filter((p) => {
      const esDeudor = deudores.has(normalizeClienteKey(p.cliente));
      return filtroSemanalSaldo === 'deudores' ? esDeudor : !esDeudor;
    });
  }

  return groupByCliente(weekPedidos);
}

function computeSemanaResumenStats(groups) {
  const allGroups = groupByCliente(movimientosData);
  const saldoMap = new Map(allGroups.map((g) => [normalizeClienteKey(g.cliente), g.debe]));

  // totalMonto representa el volumen total vendido de los pedidos de la semana
  const totalMonto = groups.reduce((sum, g) => sum + (g.totalVentas || g.totalPedido || 0), 0);
  const numClientes = groups.length;
  const numPedidos = groups.reduce(
    (sum, g) => sum + g.movimientos.filter((m) => m.tipo === 'pedido').length,
    0
  );

  return { saldoMap, totalMonto, numClientes, numPedidos };
}

function buildResumenSemanalText(groups, weekLabel, extraHeaderLine) {
  const { totalMonto, numClientes, numPedidos } = computeSemanaResumenStats(groups);

  const allGroups = groupByCliente(movimientosData);
  const deudoresGenerales = allGroups.filter((g) => g.debe > 0);
  const numDeudoresGlobal = deudoresGenerales.length;
  const totalDeudoresGlobal = deudoresGenerales.reduce((s, g) => s + g.debe, 0);

  let text = `*Pedidos Betterorden*\n${weekLabel}\n`;
  if (extraHeaderLine) text += `${extraHeaderLine}\n`;
  text += `\nTotal semana: ${formatMoney(totalMonto)}\n`;
  text += `Clientes: ${numClientes}  |  Pedidos: ${numPedidos}\n`;
  text += `\nDeudores totales: ${numDeudoresGlobal}  |  ${formatMoney(totalDeudoresGlobal)}\n`;

  if (deudoresGenerales.length > 0) {
    text += `\n`;
    deudoresGenerales
      .slice()
      .sort((a, b) => a.cliente.localeCompare(b.cliente, 'es'))
      .forEach((g) => {
        text += `- ${g.cliente}: debe ${formatMoney(g.debe)}\n`;
      });
  }

  return text.trim();
}

function shareResumenSemanal() {
  const currentWeek = getWeekRange();
  const groups = groupByCliente(
    movimientosData.filter(
      (m) => m.tipo === 'pedido' && isSameWeek(getMovimientoFecha(m), currentWeek)
    )
  );

  const hayDeudoresGenerales = groupByCliente(movimientosData).some((g) => g.debe > 0);
  if (!groups.length && !hayDeudoresGenerales) {
    alert('No hay pedidos esta semana ni deudores para compartir.');
    return;
  }

  const weekLabel = getCurrentWeekLabel();
  const text = buildResumenSemanalText(groups, weekLabel, getNextResetLabel());
  window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
}

function shareResumenSemana(weekKey) {
  const groups = groupByCliente(
    movimientosData.filter(
      (m) => m.tipo === 'pedido' && getWeekKey(getMovimientoFecha(m)) === weekKey
    )
  );

  const hayDeudoresGenerales = groupByCliente(movimientosData).some((g) => g.debe > 0);
  if (!groups.length && !hayDeudoresGenerales) {
    alert('No hay pedidos en esta semana ni deudores para compartir.');
    return;
  }

  const weekLabel = `Semana: ${getWeekLabelFromKey(weekKey)}`;
  const text = buildResumenSemanalText(groups, weekLabel);
  window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
}

function renderResumenSemanal(totalMonto, numClientes, numPedidos, numDeudoresGlobal, totalDeudoresGlobal) {
  const container = document.getElementById('resumen-semanal');
  if (!container) return;

  container.classList.remove('hidden');
  container.innerHTML = `
    <div class="grid grid-cols-2 gap-3 mb-3">
      <div class="rounded-xl p-3 text-center" style="background: linear-gradient(135deg, #E0F7FB, #B3E5FC); border-left: 4px solid #00B2E3;">
        <p class="text-[10px] font-bold uppercase tracking-wider" style="color: #00667A;">Esta semana</p>
        <p class="text-lg font-bold" style="color: #00667A;">${formatMoney(totalMonto)}</p>
        <p class="text-[10px] font-semibold" style="color: #00667A; opacity: 0.7;">${numClientes} clientes \u00B7 ${numPedidos} pedidos</p>
      </div>
      <div class="rounded-xl p-3 text-center" style="background: linear-gradient(135deg, #FEE2E2, #FECACA); border-left: 4px solid #DC2626;">
        <p class="text-[10px] font-bold uppercase tracking-wider" style="color: #991B1B;">Deudores</p>
        <p class="text-lg font-bold" style="color: #991B1B;">${formatMoney(totalDeudoresGlobal)}</p>
        <p class="text-[10px] font-semibold" style="color: #991B1B; opacity: 0.7;">${numDeudoresGlobal} deudores</p>
      </div>
    </div>
    <button type="button" id="btn-compartir-semana" class="w-full h-11 mb-4 rounded-full font-button text-button flex items-center justify-center gap-sm transition-all text-white" style="background: linear-gradient(135deg, #00A859, #007A3D); box-shadow: 0 2px 8px rgba(0,168,89,0.3);">
      <span class="material-symbols-outlined text-[20px]">share</span>
      Compartir por WhatsApp
    </button>
  `;
}

function renderPedidosSemanales() {
  const container = document.getElementById('lista-pedidos-semanales');
  if (!container) return;

  updateChipCounts();
  renderSemanaBadge();
  const currentWeek = getWeekRange();
  const allWeekGroups = groupByCliente(
    movimientosData.filter(
      (m) => m.tipo === 'pedido' && isSameWeek(getMovimientoFecha(m), currentWeek)
    )
  );
  const { totalMonto, numClientes, numPedidos } = computeSemanaResumenStats(allWeekGroups);

  const allGroupsForDeudores = groupByCliente(movimientosData);
  const numDeudoresGlobal = allGroupsForDeudores.filter((g) => g.debe > 0).length;
  const totalDeudoresGlobal = allGroupsForDeudores.filter((g) => g.debe > 0).reduce((sum, g) => sum + g.debe, 0);

  renderResumenSemanal(totalMonto, numClientes, numPedidos, numDeudoresGlobal, totalDeudoresGlobal);

  const groups = getFilteredPedidosSemanales();
  const allGroups = groupByCliente(movimientosData);
  const saldoMap = new Map(allGroups.map((g) => [normalizeClienteKey(g.cliente), g.debe]));

  if (movimientosData.length === 0) {
    renderResumenSemanal(0, 0, 0, 0, 0);
    document.getElementById('resumen-semanal')?.classList.add('hidden');
    renderEmptyState(container, 'No hay pedidos registrados.');
    return;
  }

  if (groups.length === 0) {
    renderEmptyState(container, 'No hay pedidos esta semana.');
    return;
  }

  container.innerHTML = groups
    .map((group) => {
      const cliente = escapeHtml(group.cliente);
      const saldo = saldoMap.get(normalizeClienteKey(group.cliente)) || 0;
      const saldoColor = saldo > 0 ? '#DC2626' : saldo < 0 ? '#00A859' : '#00B2E3';
      const saldoLabel = saldo > 0 ? 'Debe' : saldo < 0 ? 'A favor' : 'Al d\u00EDa';

      const pedidosHtml = group.movimientos
        .map((mov) => {
          const desc = mov.descripcion ? escapeHtml(mov.descripcion) : '';
          const fotos = Array.isArray(mov.array_urls_fotos) ? mov.array_urls_fotos : [];
          let fotosHtml = '';
          if (mov.url_foto) {
            fotosHtml = `<div class="flex gap-1.5 mt-1"><div class="w-10 h-10 rounded-lg overflow-hidden" style="background:#F3F4F6;"><a href="${escapeHtml(mov.url_foto)}" target="_blank" rel="noopener"><img class="w-full h-full object-cover" src="${escapeHtml(mov.url_foto)}" alt="Foto" loading="lazy"></a></div></div>`;
          } else if (fotos.length) {
            fotosHtml = `<div class="flex gap-1.5 mt-1">${fotos.slice(0, 4).map((url, i) => `<div class="w-10 h-10 rounded-lg overflow-hidden" style="background:#F3F4F6;"><a href="${escapeHtml(url)}" target="_blank" rel="noopener"><img class="w-full h-full object-cover" src="${escapeHtml(url)}" alt="Foto ${i + 1}" loading="lazy"></a></div>`).join('')}${fotos.length > 4 ? `<div class="w-10 h-10 rounded-lg flex items-center justify-center text-[10px] font-bold" style="background:#E0F7FB;color:#00667A;">+${fotos.length - 4}</div>` : ''}</div>`;
          }

          return `
            <div class="py-1.5 border-t border-outline-variant/10 first:border-0 first:pt-0">
              <div class="flex items-center justify-between">
                <div class="min-w-0">
                  ${desc ? `<p class="text-[12px] text-outline truncate">${desc}</p>` : ''}
                  <p class="text-[11px] text-outline">${formatFecha(getMovimientoFecha(mov))}${mov.hora ? ` \u00B7 ${formatHora(mov.hora)}` : ''}</p>
                </div>
                <p class="text-[13px] font-bold shrink-0" style="color: #00B2E3;">${formatMoney(mov.monto)}</p>
              </div>
              ${fotosHtml}
            </div>
          `;
        })
        .join('');

      return `
        <div class="rounded-2xl p-4 transition-all" style="background: #FFFFFF; border-left: 4px solid ${saldoColor}; box-shadow: 0 1px 4px rgba(0,0,0,0.05);">
          <div class="flex items-center gap-3 mb-2">
            <div class="w-11 h-11 rounded-full flex items-center justify-center font-bold text-sm shrink-0"
                 style="background: ${saldoColor}18; color: ${saldoColor};">
              ${getInitials(group.cliente)}
            </div>
            <div class="flex-1 min-w-0">
              <h4 class="font-semibold text-on-surface truncate text-[15px]">${cliente}</h4>
              <p class="text-[11px] font-bold" style="color: ${saldoColor};">${saldoLabel}: ${formatMoney(Math.abs(saldo))}</p>
            </div>
            <div class="text-right shrink-0">
              <p class="text-[11px] text-outline">Esta semana</p>
              <p class="text-base font-bold" style="color: #00B2E3;">${formatMoney(group.totalPedido)}</p>
            </div>
          </div>
          <div class="mt-1">${pedidosHtml}</div>
        </div>
      `;
    })
    .join('');
}

function renderHistorialSemanas() {
  const container = document.getElementById('historial-semanas');
  if (!container) return;

  const currentWeek = getWeekRange();
  const pedidos = movimientosData.filter(
    (m) => m.tipo === 'pedido' && !isSameWeek(getMovimientoFecha(m), currentWeek)
  );

  if (pedidos.length === 0) {
    renderEmptyState(container, 'No hay semanas anteriores.');
    return;
  }

  const grouped = new Map();
  pedidos.forEach((p) => {
    const key = getWeekKey(getMovimientoFecha(p));
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(p);
  });

  const sortedWeeks = Array.from(grouped.entries()).sort((a, b) => b[0].localeCompare(a[0]));

  container.innerHTML = sortedWeeks
    .map(([weekKey, semanaPedidos]) => {
      const label = getWeekLabelFromKey(weekKey);
      const total = semanaPedidos.reduce((s, p) => s + Number(p.monto), 0);

      const weekGroups = groupByCliente(semanaPedidos);

      const clientsHtml = weekGroups
        .sort((a, b) => a.cliente.localeCompare(b.cliente, 'es'))
        .map((c) => `
          <div class="flex items-center justify-between py-2 border-t border-outline-variant/10 first:border-0 first:pt-0">
            <div class="flex items-center gap-2 min-w-0">
              <div class="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0"
                   style="background: #E0F7FB; color: #00667A;">
                ${getInitials(c.cliente)}
              </div>
              <div class="min-w-0">
                <p class="text-[13px] font-semibold text-on-surface truncate">${escapeHtml(c.cliente)}</p>
                <p class="text-[11px] text-outline">${c.movimientos.length} pedido${c.movimientos.length > 1 ? 's' : ''}</p>
              </div>
            </div>
            <p class="text-[13px] font-bold shrink-0" style="color: #00B2E3;">${formatMoney(c.totalPedido)}</p>
          </div>
        `)
        .join('');

      return `
        <div class="mb-2">
          <div class="semana-toggle-bar w-full flex items-center justify-between px-4 py-3 rounded-xl transition-colors cursor-pointer select-none focus:outline-none focus:ring-2 focus:ring-[#00B2E3]" style="background: #F3F4F6;" data-week="${weekKey}" role="button" tabindex="0" aria-expanded="false">
            <div class="semana-title-area flex-1">
              <p class="text-[13px] font-bold text-on-surface">Semana del ${label}</p>
              <p class="text-[11px] text-outline">${semanaPedidos.length} pedidos \u00B7 ${formatMoney(total)} \u00B7 ${weekGroups.length} clientes</p>
            </div>
            <div class="flex items-center gap-2">
              <button type="button" class="share-week-btn flex items-center gap-1 text-[11px] font-semibold text-white px-3 py-1.5 rounded-full z-10 active:scale-95 transition-transform" style="background: #00A859;" data-share-week="${weekKey}">
                <span class="material-symbols-outlined text-[14px]">share</span>
                Compartir
              </button>
              <span class="material-symbols-outlined text-[18px] text-outline transition-transform semana-chevron">expand_more</span>
            </div>
          </div>
          <div class="semana-pedidos hidden px-4 pb-3" data-week-content="${weekKey}">
            ${clientsHtml}
          </div>
        </div>
      `;
    })
    .join('');

  container.querySelectorAll('.semana-toggle-bar').forEach((bar) => {
    const toggleSemana = () => {
      const week = bar.dataset.week;
      const content = container.querySelector(`[data-week-content="${week}"]`);
      const chevron = bar.querySelector('.semana-chevron');
      if (content) {
        const isHidden = content.classList.toggle('hidden');
        bar.setAttribute('aria-expanded', String(!isHidden));
        if (chevron) chevron.style.transform = isHidden ? '' : 'rotate(180deg)';
      }
    };

    bar.addEventListener('click', (e) => {
      if (e.target.closest('.share-week-btn')) return;
      toggleSemana();
    });

    bar.addEventListener('keydown', (e) => {
      if (e.target.closest('.share-week-btn')) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleSemana();
      }
    });
  });
}

// ============================================
// PWA — instalación en iPhone
// ============================================
function isIosDevice() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

function isStandaloneApp() {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true
  );
}

function initPwaInstallHint() {
  const banner = document.getElementById('ios-install-banner');
  const dismiss = document.getElementById('ios-install-dismiss');
  if (!banner || !isIosDevice() || isStandaloneApp()) return;
  if (localStorage.getItem('bettermancera-ios-install-dismissed') === '1') return;

  banner.classList.remove('hidden');
  dismiss?.addEventListener('click', () => {
    banner.classList.add('hidden');
    localStorage.setItem('bettermancera-ios-install-dismissed', '1');
  });
}

// ============================================
// Inicialización
// ============================================
document.addEventListener('DOMContentLoaded', () => {
  initNavigation();
  initPwaInstallHint();

  document.getElementById('btn-modo-pedido')?.addEventListener('click', () => setModoFormulario('pedido'));
  document.getElementById('btn-modo-pago')?.addEventListener('click', () => setModoFormulario('pago'));
  setModoFormulario('pedido');

  setupDropzone('dropzone-pedido', 'input-fotos-pedido', 'preview-pedido', true);
  setupDropzone('dropzone-pago', 'input-foto-pago', 'preview-pago', true);
  setupDropzone('dropzone-ine', 'input-foto-ine', 'preview-ine');

  setupDownloadDelegation('historial-clientes');
  setupDownloadDelegation('historial-altas');
  setupEditDelegation('historial-clientes', 'movimiento');
  setupEditDelegation('historial-altas', 'asociado');
  setupEditDelegation('ranking-morosos-lista');

  setupClienteAutocomplete();
  initModal();

  setupFilterListeners({
    nombreId: 'filtro-clientes-nombre',
    fechaId: 'filtro-clientes-fecha',
    limpiarId: 'filtro-clientes-limpiar',
    onFilter: renderClientes,
    chipContainerId: 'chips-saldo-clientes',
    setFiltroFn: (v) => { filtroSaldo = v; },
  });

  setupFilterListeners({
    nombreId: 'filtro-altas-nombre',
    fechaId: 'filtro-altas-fecha',
    limpiarId: 'filtro-altas-limpiar',
    onFilter: renderAsociados,
    chipContainerId: 'chips-saldo-altas',
    setFiltroFn: (v) => { filtroAltasSaldo = v; },
  });

  setupChipFiltro('chips-saldo-clientes', renderClientes, (v) => {
    if (v === 'online') { filtroOrigen = 'online'; filtroSaldo = 'todos'; }
    else { filtroSaldo = v; filtroOrigen = 'todos'; }
  });
  setupChipFiltro('chips-saldo-altas', renderAsociados, (v) => { filtroAltasSaldo = v; });
  setupChipFiltro('chips-saldo-semanal', renderPedidosSemanales, (v) => { filtroSemanalSaldo = v; });

  autofillPagoFechaHora();

  document.getElementById('form-pedido')?.addEventListener('submit', handlePedidoSubmit);
  document.getElementById('form-pago')?.addEventListener('submit', handlePagoSubmit);
  document.getElementById('form-altas')?.addEventListener('submit', handleAltasSubmit);

  document.getElementById('filtro-semanal-nombre')?.addEventListener('input', debounce(renderPedidosSemanales, 250));

  document.getElementById('resumen-semanal')?.addEventListener('click', (event) => {
    if (event.target.closest('#btn-compartir-semana')) shareResumenSemanal();
  });

  document.getElementById('historial-semanas')?.addEventListener('click', (event) => {
    const btn = event.target.closest('.share-week-btn');
    if (btn) shareResumenSemana(btn.dataset.shareWeek);
  });

  // Modal Compartir Cobro Listeners
  const modalShare = document.getElementById('modal-compartir-cobro');
  const closeShareModal = () => {
    if (modalShare) modalShare.classList.add('hidden');
    cleanupShareModalState();
  };
  document.getElementById('modal-compartir-cerrar')?.addEventListener('click', closeShareModal);
  document.getElementById('modal-compartir-cancelar')?.addEventListener('click', closeShareModal);
  document.getElementById('modal-compartir-btn-share')?.addEventListener('click', executeShareFromModal);
  document.getElementById('modal-compartir-btn-copiar')?.addEventListener('click', async () => {
    if (currentShareState.text && navigator.clipboard) {
      try {
        await navigator.clipboard.writeText(currentShareState.text);
        showSuccessToast('Mensaje copiado al portapapeles');
      } catch {
        showSuccessToast('No se pudo copiar');
      }
    }
  });
  document.getElementById('modal-compartir-btn-descargar')?.addEventListener('click', () => {
    if (currentShareState.file && currentShareState.previewObjectUrl) {
      const a = document.createElement('a');
      a.href = currentShareState.previewObjectUrl;
      a.download = currentShareState.file.name || 'cobro.jpg';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      showSuccessToast('Descargando imagen...');
    }
  });
  // Modal Meta Semanal Listeners
  const modalMeta = document.getElementById('modal-meta');
  const inputMeta = document.getElementById('input-meta-monto');
  const inputDeudaRef = document.getElementById('input-deuda-ref-monto');
  const openMetaModal = () => {
    if (!modalMeta) return;
    if (inputMeta) inputMeta.value = getStoredMetaSemanal();
    if (inputDeudaRef) inputDeudaRef.value = getStoredDeudaAltaRef();
    modalMeta.classList.remove('hidden');
    inputMeta?.focus();
  };
  const closeMetaModal = () => {
    if (modalMeta) modalMeta.classList.add('hidden');
  };

  document.getElementById('btn-editar-meta')?.addEventListener('click', openMetaModal);
  document.getElementById('modal-meta-cerrar')?.addEventListener('click', closeMetaModal);
  document.getElementById('modal-meta-cancelar')?.addEventListener('click', closeMetaModal);
  document.getElementById('modal-meta-guardar')?.addEventListener('click', () => {
    const valMeta = parseFloat(inputMeta?.value);
    const valDeuda = parseFloat(inputDeudaRef?.value);
    if (Number.isNaN(valMeta) || valMeta <= 0) {
      alert('Ingresa un monto de meta válido mayor a 0');
      return;
    }
    setStoredMetaSemanal(valMeta);
    if (!Number.isNaN(valDeuda) && valDeuda > 0) {
      setStoredDeudaAltaRef(valDeuda);
    }
    renderGamificacion();
    closeMetaModal();
    showSuccessToast('Configuración actualizada');
  });

  updatePedidoFechaInfo();
  setupAuthListeners();

  try {
    getSupabase();
    checkInitialAdminSession();
  } catch (err) {
    console.error(err);
    alert(formatFriendlyError(err, 'Error al conectar con Supabase.'));
  }
});
