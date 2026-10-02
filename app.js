const MAX_PHOTOS = 5;
const MAX_SIDE = 1280;

const $ = (id) => document.getElementById(id);
const els = {
  btnCamera: $('btn-camera'), fileInput: $('file-input'), cameraBox: $('camera-box'),
  video: $('video'), btnShot: $('btn-shot'), btnSwitch: $('btn-switch'), btnClose: $('btn-close'),
  dropzone: $('dropzone'), camMsg: $('cam-msg'), photosCard: $('photos-card'), photos: $('photos'),
  btnIdentify: $('btn-identify'), btnClear: $('btn-clear'), resultsCard: $('results-card'),
  status: $('status'), results: $('results'), remaining: $('remaining'), canvas: $('canvas'),
};

const ORGANS = [
  ['auto', 'Automático'], ['leaf', 'Hoja'], ['flower', 'Flor'],
  ['fruit', 'Fruto'], ['bark', 'Corteza'], ['habit', 'Planta completa'], ['other', 'Otro'],
];

let photos = []; // { id, blob, url, organ }
let stream = null;
let facing = 'environment';
let nextId = 1;

/* ---------- utilidades ---------- */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const c of children) node.append(c);
  return node;
}

function message(text, isError = false) {
  els.camMsg.hidden = !text;
  els.camMsg.textContent = text || '';
  els.camMsg.classList.toggle('error', isError);
}

// Redimensiona (máx. MAX_SIDE px) y convierte a JPEG; corrige la orientación EXIF.
async function resizeToBlob(source) {
  let bmp;
  if (source instanceof HTMLVideoElement) {
    bmp = await createImageBitmap(source);
  } else {
    try { bmp = await createImageBitmap(source, { imageOrientation: 'from-image' }); }
    catch { bmp = await createImageBitmap(source); }
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale);
  const h = Math.round(bmp.height * scale);
  const c = els.canvas;
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  return new Promise((resolve, reject) =>
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('No se pudo procesar la imagen'))), 'image/jpeg', 0.85));
}

/* ---------- cámara ---------- */
async function startCamera() {
  message('');
  if (!navigator.mediaDevices?.getUserMedia) {
    message('Tu navegador no permite acceder a la cámara o la página no usa HTTPS. Puedes subir imágenes en su lugar.', true);
    return;
  }
  stopCamera();
  try {
    // Aquí el navegador muestra su aviso de permiso de cámara.
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
    els.video.srcObject = stream;
    els.cameraBox.hidden = false;
    await els.video.play().catch(() => {});
  } catch (err) {
    const denied = 'Permiso de cámara denegado. Habilítalo en los ajustes del navegador o sube una imagen.';
    const map = {
      NotAllowedError: denied,
      PermissionDeniedError: denied,
      NotFoundError: 'No se encontró ninguna cámara en este dispositivo. Sube una imagen.',
      NotReadableError: 'La cámara está siendo usada por otra aplicación.',
      OverconstrainedError: 'No se pudo usar la cámara solicitada.',
    };
    message(map[err.name] || `No se pudo abrir la cámara (${err.name}).`, true);
  }
}

function stopCamera() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  els.video.srcObject = null;
  els.cameraBox.hidden = true;
}

async function takeShot() {
  if (!stream || !els.video.videoWidth) return;
  if (photos.length >= MAX_PHOTOS) return message(`Máximo ${MAX_PHOTOS} fotos.`, true);
  try {
    addPhoto(await resizeToBlob(els.video));
    message('Foto añadida. Puedes tomar otra desde otro ángulo o identificar ya.');
  } catch (e) {
    message(e.message, true);
  }
}

/* ---------- archivos ---------- */
async function addFiles(fileList) {
  message('');
  const files = [...fileList].filter((f) => /^image\//.test(f.type));
  if (!files.length) return message('Selecciona archivos de imagen (JPG, PNG o WebP).', true);
  for (const f of files) {
    if (photos.length >= MAX_PHOTOS) { message(`Máximo ${MAX_PHOTOS} fotos.`, true); break; }
    try { addPhoto(await resizeToBlob(f)); }
    catch { message(`No se pudo leer "${f.name}".`, true); }
  }
}

function addPhoto(blob) {
  photos.push({ id: nextId++, blob, url: URL.createObjectURL(blob), organ: 'auto' });
  renderPhotos();
}

function removePhoto(id) {
  const p = photos.find((x) => x.id === id);
  if (p) URL.revokeObjectURL(p.url);
  photos = photos.filter((x) => x.id !== id);
  renderPhotos();
}

function renderPhotos() {
  els.photos.replaceChildren(...photos.map((p) => {
    const select = el('select', { ariaLabel: 'Parte de la planta' });
    ORGANS.forEach(([v, label]) => select.append(el('option', { value: v, textContent: label, selected: v === p.organ })));
    select.addEventListener('change', () => { p.organ = select.value; });
    const rm = el('button', { className: 'remove', type: 'button', title: 'Quitar', textContent: '✕' });
    rm.addEventListener('click', () => removePhoto(p.id));
    return el('li', {}, el('img', { src: p.url, alt: 'Foto de la planta' }), rm, select);
  }));
  els.photosCard.hidden = photos.length === 0;
}

/* ---------- identificación ---------- */
function setStatus(text, { loading = false, error = false } = {}) {
  els.resultsCard.hidden = false;
  els.status.hidden = !text;
  els.status.className = 'status' + (error ? ' error' : '');
  els.status.replaceChildren(...(loading ? [el('div', { className: 'spinner' })] : []), el('span', { textContent: text || '' }));
}

async function identify() {
  if (!photos.length) return;
  els.results.replaceChildren();
  els.remaining.textContent = '';
  setStatus('Identificando…', { loading: true });
  els.btnIdentify.disabled = true;
  els.resultsCard.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const form = new FormData();
  photos.forEach((p, i) => {
    form.append('images', p.blob, `foto${i + 1}.jpg`);
    form.append('organs', p.organ);
  });

  try {
    const res = await fetch('/api/identify', { method: 'POST', body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
    renderResults(data);
  } catch (e) {
    setStatus(e.message || 'No se pudo completar la identificación.', { error: true });
  } finally {
    els.btnIdentify.disabled = false;
  }
}

function renderResults(data) {
  const list = data.results || [];
  if (!list.length) return setStatus('No se encontraron coincidencias. Prueba con fotos más nítidas de hojas o flores.', { error: true });
  setStatus(data.mock ? 'Modo demostración: resultados de ejemplo, no reales.' : '');

  els.results.replaceChildren(...list.map((r, i) => {
    const pct = Math.round((r.score || 0) * 100);
    const li = el('li', { className: 'result' + (i === 0 ? ' best' : '') });
    li.append(el('h3', { textContent: r.scientificName || 'Especie desconocida' }));
    if (r.commonNames?.length) li.append(el('p', { className: 'common', textContent: r.commonNames.slice(0, 3).join(' · ') }));
    li.append(el('p', { className: 'meta', textContent: [r.family && `Familia ${r.family}`, r.genus && `Género ${r.genus}`].filter(Boolean).join(' · ') }));
    li.append(el('div', { className: 'bar' }, el('span', { style: `width:${pct}%` })));
    li.append(el('p', { className: 'meta', textContent: `Coincidencia: ${pct}%` }));
    if (r.images?.length) {
      li.append(el('div', { className: 'refs' }, ...r.images.map((u) =>
        el('img', { src: u, alt: `Referencia de ${r.scientificName}`, loading: 'lazy', referrerPolicy: 'no-referrer' }))));
    }
    const q = encodeURIComponent(r.scientificName || '');
    li.append(
      el('a', { href: `https://es.wikipedia.org/wiki/${q}`, target: '_blank', rel: 'noopener', textContent: 'Wikipedia' }),
      el('a', { href: `https://www.google.com/search?q=${q}`, target: '_blank', rel: 'noopener', textContent: 'Buscar' }),
    );
    return li;
  }));

  if (data.remaining != null) els.remaining.textContent = `Identificaciones restantes hoy en la API: ${data.remaining}`;
}

/* ---------- eventos ---------- */
els.btnCamera.addEventListener('click', startCamera);
els.btnClose.addEventListener('click', stopCamera);
els.btnShot.addEventListener('click', takeShot);
els.btnSwitch.addEventListener('click', () => { facing = facing === 'environment' ? 'user' : 'environment'; startCamera(); });
els.fileInput.addEventListener('change', async (e) => { await addFiles(e.target.files); e.target.value = ''; });
els.btnIdentify.addEventListener('click', identify);
els.btnClear.addEventListener('click', () => {
  photos.forEach((p) => URL.revokeObjectURL(p.url));
  photos = []; renderPhotos();
  els.resultsCard.hidden = true; els.results.replaceChildren();
});

['dragenter', 'dragover'].forEach((ev) => els.dropzone.addEventListener(ev, (e) => { e.preventDefault(); els.dropzone.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => els.dropzone.addEventListener(ev, (e) => { e.preventDefault(); els.dropzone.classList.remove('over'); }));
els.dropzone.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));
els.dropzone.addEventListener('click', () => els.fileInput.click());
els.dropzone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); els.fileInput.click(); } });

document.addEventListener('visibilitychange', () => { if (document.hidden) stopCamera(); });
window.addEventListener('pagehide', stopCamera);
