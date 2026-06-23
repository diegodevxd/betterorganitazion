// ============================================
// CONFIGURACIÓN SUPABASE — editar aquí
// URL del proyecto + publishable key (Dashboard → Settings → API)
// ============================================
const SUPABASE_URL = 'https://lijzftjgevwnjorpycxa.supabase.co';
const SUPABASE_KEY = 'sb_publishable_Y1v63ZdMakSGbx449TKpiA_cKNykbk2';
const STORAGE_BUCKET = 'movimientos_fotos';

let supabaseClient = null;
let movimientosData = [];
let asociadosData = [];
let modoFormulario = 'pedido';
let modalSaveHandler = null;
let filtroSaldo = 'todos';
let filtroAltasSaldo = 'todos';
let filtroSemanalSaldo = 'todos';
let switchViewFn = null;
const previewUrls = new Map();

function getSupabase() {
  if (supabaseClient) return supabaseClient;

  if (!window.supabase?.createClient) {
    throw new Error('Supabase no se cargó. Revisa tu conexión o recarga la página.');
  }

  supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
  return supabaseClient;
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
  return nombre
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('');
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
  const btnStyle = compact ? '' : 'background: #FEF3C7; color: #92400E;';

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
      <span class="material-symbols-outlined text-[48px] mb-3" style="color: #D4A574;">inbox</span>
      <p class="text-sm text-outline max-w-[200px]">${message}</p>
    </div>
  `;
}

function renderDashboard() {
  const container = document.getElementById('dashboard-clientes');
  if (!container) return;

  const groups = groupByCliente(movimientosData);
  const numDeudores = groups.filter((g) => g.debe > 0).length;
  const totalDeudores = groups.filter((g) => g.debe > 0).reduce((sum, g) => sum + g.debe, 0);
  const numAlDia = groups.filter((g) => g.debe <= 0).length;
  const totalAlDia = groups.filter((g) => g.debe <= 0).reduce((s, g) => s + g.totalPagado, 0);
  const balanceGeneral = groups.reduce((sum, g) => sum + g.debe, 0);

  container.innerHTML = `
    <div class="rounded-xl p-3 text-center" style="background: linear-gradient(135deg, #FEE2E2, #FECACA); border-left: 4px solid #DC2626;">
      <p class="text-[10px] font-bold uppercase tracking-wider" style="color: #991B1B;">Deudores</p>
      <p class="text-xl font-bold" style="color: #991B1B;">${numDeudores}</p>
      <p class="text-[11px] font-semibold" style="color: #DC2626;">${formatMoney(totalDeudores)}</p>
    </div>
    <div class="rounded-xl p-3 text-center" style="background: linear-gradient(135deg, #D1FAE5, #A7F3D0); border-left: 4px solid #059669;">
      <p class="text-[10px] font-bold uppercase tracking-wider" style="color: #065F46;">Al dia</p>
      <p class="text-xl font-bold" style="color: #065F46;">${numAlDia}</p>
      <p class="text-[11px] font-semibold" style="color: #059669;">${formatMoney(totalAlDia)}</p>
    </div>
    <div class="rounded-xl p-3 text-center" style="background: linear-gradient(135deg, #FEF3C7, #FDE68A); border-left: 4px solid #D97706;">
      <p class="text-[10px] font-bold uppercase tracking-wider" style="color: #92400E;">Balance</p>
      <p class="text-xl font-bold" style="color: #92400E;">${groups.length}</p>
      <p class="text-[11px] font-semibold" style="color: ${balanceGeneral >= 0 ? '#059669' : '#DC2626'};">${formatMoney(Math.abs(balanceGeneral))}</p>
    </div>
  `;
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
  return [...new Set(movimientosData.map((m) => m.cliente.trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, 'es')
  );
}

function getCanonicalClienteNombre(nombre) {
  const key = normalizeClienteKey(nombre);
  if (!key) return normalizeClienteNombre(nombre);
  const match = getUniqueClientes().find((c) => normalizeClienteKey(c) === key);
  return match || normalizeClienteNombre(nombre);
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
    totalPedido: group.totalPedido,
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
    hint.style.color = '#92400E';
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
    fotosSection = `
      <div class="mt-md">
        <label class="block font-label-md text-label-md text-on-surface-variant mb-xs">Comprobante actual</label>
        ${
          mov.url_foto
            ? `<div class="w-full h-32 rounded-lg overflow-hidden bg-surface-container-high mb-sm">
                <a href="${escapeHtml(mov.url_foto)}" target="_blank" rel="noopener">
                  <img class="w-full h-full object-cover" src="${escapeHtml(mov.url_foto)}" alt="Comprobante">
                </a>
              </div>`
            : '<p class="text-outline font-label-md text-label-md mb-sm">Sin comprobante</p>'
        }
        <input accept="image/*" class="hidden" id="edit-foto-pago" type="file">
        <div class="w-full h-24 border-2 border-dashed border-outline-variant rounded-xl bg-surface-container-low flex flex-col items-center justify-center cursor-pointer hover:bg-surface-container transition-colors" data-default-label="Nuevo comprobante" id="dropzone-edit-pago">
          <span class="font-label-md text-label-md text-outline">Nuevo comprobante</span>
        </div>
        <div class="preview-grid hidden" id="preview-modal"></div>
      </div>
    `;
  }

  const bodyHtml = `
    <div class="space-y-md">
      <div>
        <label class="block font-label-md text-label-md text-on-surface-variant mb-xs">Nombre del Cliente</label>
        <input class="form-input w-full rounded-lg border-outline-variant bg-surface px-md py-sm" id="edit-mov-cliente" list="lista-clientes" type="text" value="${escapeHtml(mov.cliente)}">
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
    setupDropzone('dropzone-edit-pago', 'edit-foto-pago', 'preview-modal');
  }
}

async function saveEditMovimiento(id) {
  const mov = movimientosData.find((m) => m.id === id);
  if (!mov) return;

  const cliente = getCanonicalClienteNombre(
    document.getElementById('edit-mov-cliente')?.value.trim() || ''
  );
  const monto = parseFloat(document.getElementById('edit-mov-monto')?.value);
  const descripcion = document.getElementById('edit-mov-descripcion')?.value.trim();

  if (!cliente) {
    alert('El nombre del cliente es obligatorio.');
    return;
  }
  if (Number.isNaN(monto) || monto <= 0) {
    alert('Ingrese un monto válido.');
    return;
  }

  const payload = {
    cliente,
    monto,
    descripcion: descripcion || null,
  };

  if (mov.tipo === 'pago') {
    payload.fecha = document.getElementById('edit-mov-fecha')?.value || null;
    payload.hora = document.getElementById('edit-mov-hora')?.value || null;

    const fotoInput = document.getElementById('edit-foto-pago');
    if (fotoInput?.files?.[0]) {
      const compressed = await compressImage(fotoInput.files[0]);
      payload.url_foto = await uploadToStorage(compressed);
    } else {
      payload.url_foto = mov.url_foto;
    }
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
    const btnMov = event.target.closest('.btn-editar-movimiento');
    if (btnMov) {
      openEditMovimiento(Number(btnMov.dataset.id));
      return;
    }

    const btnDelMov = event.target.closest('.btn-eliminar-movimiento');
    if (btnDelMov) {
      try {
        await deleteMovimiento(Number(btnDelMov.dataset.id));
      } catch (err) {
        console.error(err);
        alert(formatFriendlyError(err, 'Error al eliminar.'));
      }
      return;
    }

    const btnAsoc = event.target.closest('.btn-editar-asociado');
    if (btnAsoc) {
      openEditAsociado(Number(btnAsoc.dataset.id));
      return;
    }

    const btnDelAsoc = event.target.closest('.btn-eliminar-asociado');
    if (btnDelAsoc) {
      try {
        await deleteAsociado(Number(btnDelAsoc.dataset.id));
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
        item.style.background = '#FEF3C7';
        item.style.color = '#92400E';
      } else {
        item.style.background = '';
        item.style.color = '';
      }
    });

    bottomNavItems.forEach((item) => {
      if (item.dataset.target === targetId) {
        item.style.background = 'linear-gradient(135deg, #D97706, #EA580C)';
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

  let filtered = movimientosData.filter(
    (mov) => matchesName(mov.cliente, nombre) && matchesDate(getMovimientoFecha(mov), fecha)
  );

  if (filtroSaldo !== 'todos') {
    const groups = groupByCliente(filtered);
    const clientes = new Set(
      groups
        .filter((g) => (filtroSaldo === 'deudores' ? g.debe > 0 : g.debe <= 0))
        .map((g) => g.cliente)
    );
    filtered = filtered.filter((mov) => clientes.has(mov.cliente));
  }

  return filtered;
}

function groupByCliente(movimientos) {
  const groups = new Map();

  movimientos.forEach((mov) => {
    const key = getCanonicalClienteNombre(mov.cliente.trim());
    if (!groups.has(key)) {
      groups.set(key, {
        cliente: key,
        movimientos: [],
        totalPedido: 0,
        totalPagado: 0,
      });
    }

    const group = groups.get(key);
    group.movimientos.push(mov);

    if (mov.tipo === 'pedido') {
      group.totalPedido += Number(mov.monto);
    } else if (mov.tipo === 'pago') {
      group.totalPagado += Number(mov.monto);
    }
  });

  return Array.from(groups.values())
    .map((group) => ({
      ...group,
      debe: group.totalPedido - group.totalPagado,
      movimientos: group.movimientos.sort(
        (a, b) => new Date(b.created_at) - new Date(a.created_at)
      ),
    }))
    .sort((a, b) => a.cliente.localeCompare(b.cliente, 'es'));
}

function renderMovimientoItem(mov) {
  const clienteSlug = escapeHtml(mov.cliente).replace(/\s+/g, '-');
  const esPedido = mov.tipo === 'pedido';
  const tipoLabel = esPedido ? 'Pedido' : 'Pago';
  const stripeColor = esPedido ? '#EA580C' : '#059669';
  const badgeBg = esPedido ? '#FFEDD5' : '#D1FAE5';
  const badgeText = esPedido ? '#9A3412' : '#065F46';
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
            <div class="w-12 h-12 rounded-lg overflow-hidden" style="background: #F5F5F4;">
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
            <span class="font-semibold text-on-surface text-[15px]">${formatMoney(mov.monto)}</span>
          </div>
          ${descripcion ? `<p class="text-xs text-outline mt-1">${descripcion}</p>` : ''}
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
      const borderColor = group.debe > 0 ? '#DC2626' : group.debe < 0 ? '#059669' : '#D97706';
      const cardBg = group.debe > 0 ? '#FEF2F2' : group.debe < 0 ? '#ECFDF5' : '#FFFBF5';
      const debeClass =
        group.debe > 0
          ? 'font-bold'
          : group.debe < 0
            ? 'font-bold'
            : 'font-bold';
      const debeColor = group.debe > 0 ? '#DC2626' : group.debe < 0 ? '#059669' : '#D97706';
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
                <div class="flex gap-3 mt-0.5 text-[11px] text-outline">
                  <span>Pedido: ${formatMoney(group.totalPedido)}</span>
                  <span>Pagado: ${formatMoney(group.totalPagado)}</span>
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

  try {
    const { data, error } = await getSupabase()
      .from('movimientos')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;

    movimientosData = data || [];
    refreshClienteDatalist();
    renderClientes();
    renderPedidosSemanales();
    renderHistorialSemanas();
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
    let urlFoto = null;

    if (fotoInput?.files?.[0]) {
      const compressed = await compressImage(fotoInput.files[0]);
      urlFoto = await uploadToStorage(compressed);
    }

    const { error } = await getSupabase().from('movimientos').insert({
      cliente,
      tipo: 'pago',
      monto,
      descripcion: descripcion || null,
      url_foto: urlFoto,
      fecha,
      hora,
    });

    if (error) throw error;

    document.getElementById('form-pago')?.reset();
    autofillPagoFechaHora();
    if (fotoInput) fotoInput.value = '';
    clearFilePreview('preview-pago', 'dropzone-pago', 'Subir Comprobante');

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
        <div class="rounded-2xl p-4 flex flex-col gap-3 transition-all" style="background: #FFFBF5; border-left: 4px solid #D97706; box-shadow: 0 1px 4px rgba(0,0,0,0.05);">
          <div class="flex items-center gap-3">
            <div class="w-11 h-11 rounded-full flex items-center justify-center font-bold text-sm shrink-0"
                 style="background: #FEF3C7; color: #92400E;">
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
                  <div class="w-full h-32 rounded-xl overflow-hidden" style="background: #F5F5F4;">
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
  const deudores = groups.filter((g) => g.debe > 0).length;
  const alDia = total - deudores;

  const setCount = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };
  setCount('count-todos', total);
  setCount('count-deudores', deudores);
  setCount('count-al-dia', alDia);

  const allAsoc = asociadosData.length;
  const deudoresSet = new Set(groups.filter((g) => g.debe > 0).map((g) => g.cliente.toLowerCase()));
  const asocDeudores = asociadosData.filter((a) => deudoresSet.has(a.nombre_nuevo.trim().toLowerCase())).length;
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
    (g) => (semanalSaldoMap.get(normalizeClienteKey(g.cliente)) || 0) > 0
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

function buildResumenSemanalText(groups) {
  const allGroups = groupByCliente(movimientosData);
  const saldoMap = new Map(allGroups.map((g) => [normalizeClienteKey(g.cliente), g.debe]));

  const totalMonto = groups.reduce((sum, g) => sum + g.totalPedido, 0);
  let porCobrar = 0;
  groups.forEach((g) => {
    const debe = saldoMap.get(normalizeClienteKey(g.cliente)) || 0;
    if (debe > 0) porCobrar += debe;
  });

  const numPedidos = groups.reduce(
    (sum, g) => sum + g.movimientos.filter((m) => m.tipo === 'pedido').length,
    0
  );

  let text = `*Pedidos Betterorden*\n${getCurrentWeekLabel()}\n${getNextResetLabel()}\n\n`;
  text += `Total semana: ${formatMoney(totalMonto)}\n`;
  text += `Por cobrar (deudores): ${formatMoney(porCobrar)}\n`;
  text += `Clientes: ${groups.length} | Pedidos: ${numPedidos}\n\n`;

  groups
    .slice()
    .sort((a, b) => a.cliente.localeCompare(b.cliente, 'es'))
    .forEach((g) => {
      const debe = saldoMap.get(normalizeClienteKey(g.cliente)) || 0;
      const debeTxt = debe > 0 ? ` (debe ${formatMoney(debe)})` : '';
      text += `- ${g.cliente}: ${formatMoney(g.totalPedido)}${debeTxt}\n`;
    });

  return text.trim();
}

function shareResumenSemanal() {
  const currentWeek = getWeekRange();
  const groups = groupByCliente(
    movimientosData.filter(
      (m) => m.tipo === 'pedido' && isSameWeek(getMovimientoFecha(m), currentWeek)
    )
  );

  if (!groups.length) {
    alert('No hay pedidos esta semana para compartir.');
    return;
  }

  const text = buildResumenSemanalText(groups);
  window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
}

function renderResumenSemanal(groups) {
  const container = document.getElementById('resumen-semanal');
  if (!container) return;

  if (!groups.length) {
    container.classList.add('hidden');
    container.innerHTML = '';
    return;
  }

  const allGroups = groupByCliente(movimientosData);
  const saldoMap = new Map(allGroups.map((g) => [normalizeClienteKey(g.cliente), g.debe]));

  const totalMonto = groups.reduce((sum, g) => sum + g.totalPedido, 0);
  const numClientes = groups.length;
  const numPedidos = groups.reduce(
    (sum, g) => sum + g.movimientos.filter((m) => m.tipo === 'pedido').length,
    0
  );
  let porCobrar = 0;
  groups.forEach((g) => {
    const debe = saldoMap.get(normalizeClienteKey(g.cliente)) || 0;
    if (debe > 0) porCobrar += debe;
  });

  container.classList.remove('hidden');
  container.innerHTML = `
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
      <div class="rounded-xl p-3 text-center" style="background: linear-gradient(135deg, #FEF3C7, #FDE68A); border-left: 4px solid #D97706;">
        <p class="text-[10px] font-bold uppercase tracking-wider" style="color: #92400E;">Total semana</p>
        <p class="text-lg font-bold" style="color: #92400E;">${formatMoney(totalMonto)}</p>
      </div>
      <div class="rounded-xl p-3 text-center" style="background: linear-gradient(135deg, #FEE2E2, #FECACA); border-left: 4px solid #DC2626;">
        <p class="text-[10px] font-bold uppercase tracking-wider" style="color: #991B1B;">Por cobrar</p>
        <p class="text-lg font-bold" style="color: #991B1B;">${formatMoney(porCobrar)}</p>
      </div>
      <div class="rounded-xl p-3 text-center" style="background: #FFFBF5; border-left: 4px solid #EA580C;">
        <p class="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">Clientes</p>
        <p class="text-lg font-bold text-on-surface">${numClientes}</p>
      </div>
      <div class="rounded-xl p-3 text-center" style="background: #FFFBF5; border-left: 4px solid #D97706;">
        <p class="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">Pedidos</p>
        <p class="text-lg font-bold text-on-surface">${numPedidos}</p>
      </div>
    </div>
    <button type="button" id="btn-compartir-semana" class="w-full h-11 mb-4 rounded-full font-button text-button flex items-center justify-center gap-sm transition-all text-white" style="background: linear-gradient(135deg, #059669, #047857); box-shadow: 0 2px 8px rgba(5,150,105,0.3);">
      <span class="material-symbols-outlined text-[20px]">share</span>
      Compartir resumen por WhatsApp
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
  renderResumenSemanal(allWeekGroups);
  const groups = getFilteredPedidosSemanales();
  const allGroups = groupByCliente(movimientosData);
  const saldoMap = new Map(allGroups.map((g) => [normalizeClienteKey(g.cliente), g.debe]));

  if (movimientosData.length === 0) {
    renderResumenSemanal([]);
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
      const saldoColor = saldo > 0 ? '#DC2626' : saldo < 0 ? '#059669' : '#D97706';
      const saldoLabel = saldo > 0 ? 'Debe' : saldo < 0 ? 'A favor' : 'Al dia';

      const pedidosHtml = group.movimientos
        .map((mov) => {
          const desc = mov.descripcion ? escapeHtml(mov.descripcion) : '';
          const fotos = Array.isArray(mov.array_urls_fotos) ? mov.array_urls_fotos : [];
          let fotosHtml = '';
          if (mov.url_foto) {
            fotosHtml = `<div class="flex gap-1.5 mt-1"><div class="w-10 h-10 rounded-lg overflow-hidden" style="background:#F5F5F4;"><a href="${escapeHtml(mov.url_foto)}" target="_blank" rel="noopener"><img class="w-full h-full object-cover" src="${escapeHtml(mov.url_foto)}" alt="Foto" loading="lazy"></a></div></div>`;
          } else if (fotos.length) {
            fotosHtml = `<div class="flex gap-1.5 mt-1">${fotos.slice(0, 4).map((url, i) => `<div class="w-10 h-10 rounded-lg overflow-hidden" style="background:#F5F5F4;"><a href="${escapeHtml(url)}" target="_blank" rel="noopener"><img class="w-full h-full object-cover" src="${escapeHtml(url)}" alt="Foto ${i + 1}" loading="lazy"></a></div>`).join('')}${fotos.length > 4 ? `<div class="w-10 h-10 rounded-lg flex items-center justify-center text-[10px] font-bold" style="background:#FEF3C7;color:#92400E;">+${fotos.length - 4}</div>` : ''}</div>`;
          }

          return `
            <div class="py-1.5 border-t border-outline-variant/10 first:border-0 first:pt-0">
              <div class="flex items-center justify-between">
                <div class="min-w-0">
                  ${desc ? `<p class="text-[12px] text-outline truncate">${desc}</p>` : ''}
                  <p class="text-[11px] text-outline">${formatFecha(getMovimientoFecha(mov))}${mov.hora ? ` \u00B7 ${formatHora(mov.hora)}` : ''}</p>
                </div>
                <p class="text-[13px] font-bold shrink-0" style="color: #D97706;">${formatMoney(mov.monto)}</p>
              </div>
              ${fotosHtml}
            </div>
          `;
        })
        .join('');

      return `
        <div class="rounded-2xl p-4 transition-all" style="background: #FFFBF5; border-left: 4px solid ${saldoColor}; box-shadow: 0 1px 4px rgba(0,0,0,0.05);">
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
              <p class="text-base font-bold" style="color: #D97706;">${formatMoney(group.totalPedido)}</p>
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

      const groupedByClient = new Map();
      semanaPedidos.forEach((p) => {
        const key = p.cliente.trim();
        if (!groupedByClient.has(key)) groupedByClient.set(key, { cliente: key, total: 0, count: 0 });
        const g = groupedByClient.get(key);
        g.total += Number(p.monto);
        g.count++;
      });

      const clientsHtml = Array.from(groupedByClient.values())
        .sort((a, b) => a.cliente.localeCompare(b.cliente, 'es'))
        .map((c) => `
          <div class="flex items-center justify-between py-2 border-t border-outline-variant/10 first:border-0 first:pt-0">
            <div class="flex items-center gap-2 min-w-0">
              <div class="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0"
                   style="background: #FEF3C7; color: #92400E;">
                ${getInitials(c.cliente)}
              </div>
              <div class="min-w-0">
                <p class="text-[13px] font-semibold text-on-surface truncate">${escapeHtml(c.cliente)}</p>
                <p class="text-[11px] text-outline">${c.count} pedido${c.count > 1 ? 's' : ''}</p>
              </div>
            </div>
            <p class="text-[13px] font-bold shrink-0" style="color: #D97706;">${formatMoney(c.total)}</p>
          </div>
        `)
        .join('');

      return `
        <div class="mb-2">
          <button type="button" class="semana-toggle w-full flex items-center justify-between px-4 py-3 rounded-xl text-left transition-colors" style="background: #F5F5F4;" data-week="${weekKey}">
            <div>
              <p class="text-[13px] font-bold text-on-surface">Semana del ${label}</p>
              <p class="text-[11px] text-outline">${semanaPedidos.length} pedidos \u00B7 ${formatMoney(total)}</p>
            </div>
            <span class="material-symbols-outlined text-[18px] text-outline transition-transform semana-chevron">expand_more</span>
          </button>
          <div class="semana-pedidos hidden px-4 pb-3" data-week-content="${weekKey}">
            ${clientsHtml}
          </div>
        </div>
      `;
    })
    .join('');

  container.querySelectorAll('.semana-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const week = btn.dataset.week;
      const content = container.querySelector(`[data-week-content="${week}"]`);
      const chevron = btn.querySelector('.semana-chevron');
      if (content) {
        content.classList.toggle('hidden');
        if (chevron) chevron.style.transform = content.classList.contains('hidden') ? '' : 'rotate(180deg)';
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
  if (localStorage.getItem('betterorden-ios-install-dismissed') === '1') return;

  banner.classList.remove('hidden');
  dismiss?.addEventListener('click', () => {
    banner.classList.add('hidden');
    localStorage.setItem('betterorden-ios-install-dismissed', '1');
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
  setupDropzone('dropzone-pago', 'input-foto-pago', 'preview-pago');
  setupDropzone('dropzone-ine', 'input-foto-ine', 'preview-ine');

  setupDownloadDelegation('historial-clientes');
  setupDownloadDelegation('historial-altas');
  setupEditDelegation('historial-clientes', 'movimiento');
  setupEditDelegation('historial-altas', 'asociado');

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

  setupChipFiltro('chips-saldo-clientes', renderClientes, (v) => { filtroSaldo = v; });
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

  updatePedidoFechaInfo();

  try {
    getSupabase();
    fetchMovimientos();
    fetchAsociados();
  } catch (err) {
    console.error(err);
    alert(formatFriendlyError(err, 'Error al conectar con Supabase.'));
  }
});
