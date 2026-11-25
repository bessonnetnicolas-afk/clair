/* =========================================================
   Clair — scan de produits alimentaires (PWA)
   Données : Open Food Facts (licence ODbL)
   ========================================================= */

/* ---------- 1. CONFIGURATION ---------- */
const APP_VERSION = '1.0.0';
// Ton serveur Infomaniak (API de synchro, mises à jour, référentiels)
const SERVER = 'https://clair.bessonnetnicolas.space';
// true quand l'appli tourne dans l'APK Android (Capacitor)
const isNative = !!window.Capacitor?.isNativePlatform?.();
const OFF_BASE = 'https://world.openfoodfacts.org';
// Champs demandés à l'API (limite le volume téléchargé)
const OFF_FIELDS = ['code','product_name','product_name_fr','brands','quantity','image_front_small_url','image_front_url',
  'nutriscore_grade','nova_group','additives_tags','allergens_tags','traces_tags','ingredients_analysis_tags',
  'labels_tags','ingredients_text','ingredients_text_fr','nutriments'].join(',');
const urlProduct = c => `${OFF_BASE}/api/v2/product/${c}.json?lc=fr&fields=${OFF_FIELDS}`;
// Recherche plein texte, limitée aux produits vendus en France
const urlSearch = q => `${OFF_BASE}/cgi/search.pl?search_terms=${encodeURIComponent(q)}&search_simple=1&action=process&json=1&page_size=24&lc=fr&tagtype_0=countries&tag_contains_0=contains&tag_0=france&fields=${OFF_FIELDS}`;

const DEFAULT_SETTINGS = {
  weights: { nutri: 50, nova: 25, additives: 25, bio: 0 },
  profiles: [{ id: 'p1', name: 'Moi', active: true, alerts: [] }]
};

/* ---------- 2. RÉFÉRENTIELS (additifs, NOVA, alertes) ---------- */
// Liste indicative d'additifs controversés — valeur par défaut,
// remplacée par data/referentiels.json du serveur si disponible
let ADDITIVES = {
  high: {
    E171: 'Dioxyde de titane — interdit dans l’UE depuis 2022',
    E249: 'Nitrite — lien avec le cancer colorectal (ANSES 2022)',
    E250: 'Nitrite de sodium — lien avec le cancer colorectal (ANSES 2022)',
    E251: 'Nitrate — lien avec le cancer colorectal (ANSES 2022)',
    E252: 'Nitrate — lien avec le cancer colorectal (ANSES 2022)',
    E320: 'BHA — cancérogène possible (CIRC)',
    E102: 'Colorant azoïque — avertissement obligatoire (enfants)',
    E104: 'Colorant — avertissement obligatoire (enfants)',
    E110: 'Colorant azoïque — avertissement obligatoire (enfants)',
    E122: 'Colorant azoïque — avertissement obligatoire (enfants)',
    E124: 'Colorant azoïque — avertissement obligatoire (enfants)',
    E129: 'Colorant azoïque — avertissement obligatoire (enfants)'
  },
  moderate: {
    E150C: 'Caramel ammoniacal', E150D: 'Caramel au sulfite d’ammonium',
    E321: 'BHT (antioxydant)', E407: 'Carraghénanes',
    E433: 'Polysorbate 80 (émulsifiant)', E466: 'Carboxyméthylcellulose (émulsifiant)',
    E950: 'Acésulfame K (édulcorant)', E951: 'Aspartame — cancérogène possible (CIRC 2023)',
    E954: 'Saccharine (édulcorant)', E955: 'Sucralose (édulcorant)',
    E338: 'Acide phosphorique', E339: 'Phosphates', E340: 'Phosphates', E341: 'Phosphates',
    E450: 'Polyphosphates', E451: 'Polyphosphates', E452: 'Polyphosphates'
  }
};

const NOVA_TXT = {
  1: 'aliment brut ou peu transformé',
  2: 'ingrédient culinaire (huile, sucre, sel…)',
  3: 'aliment transformé',
  4: 'aliment ultra-transformé'
};

// Alertes disponibles pour les profils
// allergen = tag Open Food Facts ; bad / unknown = tags d'analyse des ingrédients
const ALERTS = {
  gluten:      { label: 'Gluten', allergen: 'en:gluten' },
  milk:        { label: 'Lait / lactose', allergen: 'en:milk' },
  eggs:        { label: 'Œufs', allergen: 'en:eggs' },
  peanuts:     { label: 'Arachides', allergen: 'en:peanuts' },
  nuts:        { label: 'Fruits à coque', allergen: 'en:nuts' },
  soy:         { label: 'Soja', allergen: 'en:soybeans' },
  fish:        { label: 'Poisson', allergen: 'en:fish' },
  crustaceans: { label: 'Crustacés', allergen: 'en:crustaceans' },
  molluscs:    { label: 'Mollusques', allergen: 'en:molluscs' },
  sesame:      { label: 'Sésame', allergen: 'en:sesame-seeds' },
  mustard:     { label: 'Moutarde', allergen: 'en:mustard' },
  celery:      { label: 'Céleri', allergen: 'en:celery' },
  lupin:       { label: 'Lupin', allergen: 'en:lupin' },
  sulphites:   { label: 'Sulfites', allergen: 'en:sulphur-dioxide-and-sulphites' },
  vegetarian:  { label: 'Végétarien', bad: ['en:non-vegetarian'], maybe: ['en:maybe-vegetarian'], unknown: 'en:vegetarian-status-unknown' },
  vegan:       { label: 'Végan', bad: ['en:non-vegan'], maybe: ['en:maybe-vegan'], unknown: 'en:vegan-status-unknown' },
  palm:        { label: 'Sans huile de palme', bad: ['en:palm-oil'], maybe: ['en:may-contain-palm-oil'], unknown: 'en:palm-oil-content-unknown' }
};

/* ---------- 3. STOCKAGE LOCAL (IndexedDB) ---------- */
// Tables : products (fiches en cache), history (code + date), kv (réglages),
// pending (modifications en attente d'envoi au serveur)
const DB = (() => {
  let dbp;
  function open() {
    if (!dbp) dbp = new Promise((res, rej) => {
      const r = indexedDB.open('clair', 2);
      r.onupgradeneeded = () => {
        const db = r.result, has = n => db.objectStoreNames.contains(n);
        if (!has('products')) db.createObjectStore('products', { keyPath: 'code' });
        if (!has('history')) db.createObjectStore('history', { keyPath: 'code' });
        if (!has('kv')) db.createObjectStore('kv');
        if (!has('pending')) db.createObjectStore('pending', { keyPath: 'id' });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  async function run(store, mode, fn) {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(store, mode);
      const req = fn(t.objectStore(store));
      t.oncomplete = () => res(req ? req.result : undefined);
      t.onerror = () => rej(t.error);
    });
  }
  return {
    get: (s, k) => run(s, 'readonly', st => st.get(k)),
    put: (s, v, k) => run(s, 'readwrite', st => (k === undefined ? st.put(v) : st.put(v, k))),
    del: (s, k) => run(s, 'readwrite', st => st.delete(k)),
    all: s => run(s, 'readonly', st => st.getAll()),
    clear: s => run(s, 'readwrite', st => st.clear())
  };
})();

let settings = structuredClone(DEFAULT_SETTINGS);
// Enregistre les réglages en local et les met en file pour la synchro
async function saveSettings() {
  await DB.put('kv', settings, 'settings');
  Sync.queue('settings', 'weights', settings.weights);
  Sync.queue('profiles', 'all', settings.profiles);
}

/* ---------- 4. OUTILS ---------- */
const $ = s => document.querySelector(s);
// Échappe le texte venant d'Open Food Facts avant affichage (sécurité)
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const scoreColor = v => v == null ? '#9aa39e' : v >= 75 ? '#1e9e57' : v >= 50 ? '#7cb342' : v >= 25 ? '#f39c12' : '#e74c3c';
const scoreLabel = v => v == null ? 'Inconnu' : v >= 75 ? 'Excellent' : v >= 50 ? 'Bon' : v >= 25 ? 'Médiocre' : 'Mauvais';
const fmt = (v, u) => v == null || v === '' ? '—' : `${Math.round(v * 10) / 10} ${u}`;

/* ---------- 5. DONNÉES PRODUIT (API + cache) ---------- */
// Simplifie la fiche Open Food Facts pour ne garder que l'utile
function normalize(p) {
  const n = p.nutriments || {};
  const grade = String(p.nutriscore_grade || '').toLowerCase();
  return {
    code: String(p.code),
    name: p.product_name_fr || p.product_name || 'Produit sans nom',
    brand: (p.brands || '').split(',')[0].trim(),
    qty: p.quantity || '',
    img: p.image_front_small_url || p.image_front_url || '',
    nutri: /^[a-e]$/.test(grade) ? grade : '',
    nova: Number(p.nova_group) || null,
    additives: p.additives_tags || [],
    allergens: p.allergens_tags || [],
    traces: p.traces_tags || [],
    analysis: p.ingredients_analysis_tags || [],
    labels: p.labels_tags || [],
    ingredients: p.ingredients_text_fr || p.ingredients_text || '',
    n: {
      kcal: n['energy-kcal_100g'], fat: n['fat_100g'], sat: n['saturated-fat_100g'],
      carbs: n['carbohydrates_100g'], sugars: n['sugars_100g'], fiber: n['fiber_100g'],
      prot: n['proteins_100g'], salt: n['salt_100g']
    },
    fetched: Date.now()
  };
}

// Cherche un produit : réseau d'abord, cache local si hors ligne ou en erreur
async function getProduct(code) {
  code = code.replace(/\D/g, '');
  if (code.length === 12) code = '0' + code; // UPC-A → EAN-13
  const cached = await DB.get('products', code);
  if (!navigator.onLine) return cached ? { product: cached, offline: true } : { offlineMiss: true, code };
  try {
    const r = await fetch(urlProduct(code));
    if (r.status === 404) return { notFound: true, code };
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    if (!j.product) return { notFound: true, code };
    const p = normalize({ ...j.product, code });
    await DB.put('products', p);
    return { product: p };
  } catch (e) {
    if (cached) return { product: cached, offline: true };
    throw e;
  }
}

// Ajoute à l'historique + file de synchro (avec la fiche, pour un autre téléphone)
async function addHistory(code) {
  const ts = Date.now();
  await DB.put('history', { code, ts });
  Sync.queue('history', code, { ts, p: await DB.get('products', code) });
}

/* ---------- 6. CALCUL DE LA NOTE (transparente) ---------- */
// Classe chaque additif : high / moderate / other
function additiveInfo(tag) {
  const m = tag.replace(/^en:/, '').toUpperCase().match(/^E(\d+)([A-Z]*)/);
  if (!m) return { code: tag, level: 'other', note: '' };
  const full = 'E' + m[1] + m[2], root = 'E' + m[1];
  for (const lvl of ['high', 'moderate']) {
    const note = ADDITIVES[lvl][full] || ADDITIVES[lvl][root];
    if (note) return { code: full, level: lvl, note };
  }
  return { code: full, level: 'other', note: '' };
}

// Note = moyenne pondérée des critères disponibles (poids réglables)
function computeScore(p, w) {
  const parts = [];
  if (p.nutri) parts.push({
    key: 'nutri', label: 'Nutri-Score', weight: w.nutri,
    value: { a: 100, b: 75, c: 50, d: 25, e: 0 }[p.nutri],
    detail: `Note ${p.nutri.toUpperCase()} : équilibre sucre, sel, gras saturés, fibres, protéines…`
  });
  if (p.nova) parts.push({
    key: 'nova', label: 'Transformation (NOVA)', weight: w.nova,
    value: { 1: 100, 2: 75, 3: 50, 4: 0 }[p.nova],
    detail: `Groupe ${p.nova} : ${NOVA_TXT[p.nova]}`
  });
  if (p.ingredients || p.additives.length) {
    const list = p.additives.map(additiveInfo);
    const c = { high: 0, moderate: 0, other: 0 };
    list.forEach(a => c[a.level]++);
    parts.push({
      key: 'additives', label: 'Additifs', weight: w.additives,
      value: Math.max(0, 100 - c.high * 30 - c.moderate * 15 - c.other * 3),
      detail: list.length ? `${list.length} additif(s) : ${c.high} à risque élevé, ${c.moderate} modéré(s)` : 'Aucun additif'
    });
  }
  if (w.bio > 0) parts.push({
    key: 'bio', label: 'Bio', weight: w.bio,
    value: p.labels.includes('en:organic') ? 100 : 0,
    detail: p.labels.includes('en:organic') ? 'Produit certifié bio' : 'Pas de label bio'
  });
  const used = parts.filter(x => x.weight > 0);
  const sw = used.reduce((s, x) => s + x.weight, 0);
  const total = sw ? Math.round(used.reduce((s, x) => s + x.value * x.weight, 0) / sw) : null;
  return { total, parts, partial: used.length < 3 };
}

/* ---------- 7. ALERTES DES PROFILS ---------- */
function checkAlerts(p) {
  const out = [];
  const noData = !p.ingredients && !p.allergens.length;
  settings.profiles.filter(pr => pr.active).forEach(pr => {
    pr.alerts.forEach(key => {
      const a = ALERTS[key]; if (!a) return;
      const who = settings.profiles.filter(x => x.active).length > 1 ? `${pr.name} · ` : '';
      if (a.allergen) {
        if (p.allergens.includes(a.allergen)) out.push({ level: 'danger', text: `${who}Contient : ${a.label}` });
        else if (p.traces.includes(a.allergen)) out.push({ level: 'warn', text: `${who}Peut contenir : ${a.label}` });
        else if (noData) out.push({ level: 'unknown', text: `${who}${a.label} : ingrédients non renseignés` });
      } else {
        if (a.bad.some(t => p.analysis.includes(t))) out.push({ level: 'danger', text: `${who}Ne convient pas : ${a.label}` });
        else if (a.maybe.some(t => p.analysis.includes(t))) out.push({ level: 'warn', text: `${who}À vérifier : ${a.label}` });
        else if (p.analysis.includes(a.unknown) || !p.analysis.length) out.push({ level: 'unknown', text: `${who}${a.label} : statut inconnu` });
      }
    });
  });
  return out;
}

/* ---------- 8. NAVIGATION ENTRE LES VUES ---------- */
let prevView = 'scan';
function show(view) {
  if (view !== 'scan') stopScan();
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'v-' + view));
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.view === view));
  if (view !== 'product') prevView = view;
  if (view === 'history') renderHistory();
  if (view === 'settings') renderSettings();
  window.scrollTo(0, 0);
}
document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => show(b.dataset.view));

/* ---------- 9. SCANNER (caméra + BarcodeDetector) ---------- */
let stream = null, scanTimer = null;
// Scanner natif Android (Google ML Kit) quand on est dans l'APK
async function nativeScan() {
  const msg = $('#scan-msg');
  const BS = window.capacitorBarcodeScanner.BarcodeScanner;
  try {
    const { available } = await BS.isGoogleBarcodeScannerModuleAvailable();
    if (!available) {
      msg.textContent = 'Installation du module de scan Google… réessaie dans quelques secondes.';
      await BS.installGoogleBarcodeScannerModule();
      return;
    }
    const { barcodes } = await BS.scan({ formats: ['EAN_13', 'EAN_8', 'UPC_A', 'UPC_E'] });
    if (barcodes?.length) openProduct(barcodes[0].rawValue);
  } catch (e) {
    if (!/cancel/i.test(e?.message || '')) msg.textContent = 'Scan impossible : ' + (e?.message || e);
  }
}

async function startScan() {
  const msg = $('#scan-msg');
  if (isNative) return nativeScan();
  if (!('BarcodeDetector' in window)) {
    msg.textContent = 'Le scan caméra n’est pas pris en charge par ce navigateur (utilise Chrome sur Android). Saisis le code-barres ci-dessous.';
    return;
  }
  try {
    const supported = await BarcodeDetector.getSupportedFormats();
    const detector = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e'].filter(f => supported.includes(f)) });
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    const video = $('#video');
    video.srcObject = stream;
    await video.play();
    $('#btn-scan').textContent = 'Arrêter';
    msg.textContent = 'Vise le code-barres du produit.';
    // Analyse une image toutes les 250 ms
    scanTimer = setInterval(async () => {
      try {
        const codes = await detector.detect(video);
        if (codes.length) {
          const code = codes[0].rawValue;
          stopScan();
          navigator.vibrate?.(80);
          openProduct(code);
        }
      } catch (_) { /* image pas prête : on réessaie */ }
    }, 250);
  } catch (e) {
    msg.textContent = 'Caméra indisponible (autorisation refusée ?). Saisis le code-barres ci-dessous.';
    stopScan();
  }
}
function stopScan() {
  clearInterval(scanTimer); scanTimer = null;
  stream?.getTracks().forEach(t => t.stop()); stream = null;
  $('#btn-scan').textContent = 'Démarrer le scan';
}
$('#btn-scan').onclick = () => (stream ? stopScan() : startScan());
$('#f-manual').onsubmit = e => {
  e.preventDefault();
  const v = $('#manual').value.trim();
  if (/^\d{8,14}$/.test(v)) { $('#manual').value = ''; openProduct(v); }
  else $('#scan-msg').textContent = 'Un code-barres contient 8 à 14 chiffres.';
};

/* ---------- 10. FICHE PRODUIT ---------- */
async function openProduct(code) {
  const v = $('#v-product');
  show('product');
  v.innerHTML = `${backBtn()}<p class="hint">Chargement…</p>`;
  bindBack();
  try {
    const r = await getProduct(code);
    if (r.product) { await addHistory(r.product.code); renderProduct(r.product, r.offline); }
    else if (r.notFound) renderMessage(`Produit inconnu (${esc(r.code)})`, 'Ce produit n’est pas encore dans Open Food Facts. L’ajout depuis l’appli arrive dans la prochaine version.');
    else renderMessage('Hors ligne', 'Ce produit n’a jamais été scanné sur ce téléphone. Réessaie une fois connecté.');
  } catch (e) {
    renderMessage('Erreur réseau', 'Impossible de joindre Open Food Facts. Réessaie dans un instant.');
  }
}
// Ouvre directement une fiche déjà chargée (résultats de recherche)
async function openProductData(p) {
  await DB.put('products', p); await addHistory(p.code);
  show('product'); renderProduct(p, false);
}

const backBtn = () => `<button class="ghost" id="btn-back">← Retour</button>`;
const bindBack = () => { $('#btn-back').onclick = () => show(prevView); };

function renderMessage(title, text) {
  $('#v-product').innerHTML = `${backBtn()}<div class="card" style="margin-top:.8rem"><h2>${title}</h2><p>${text}</p></div>`;
  bindBack();
}

function renderProduct(p, offline) {
  const s = computeScore(p, settings.weights);
  const alerts = checkAlerts(p);
  const adds = p.additives.map(additiveInfo);
  const lvlTxt = { high: 'Risque élevé', moderate: 'Modéré', other: 'Pas de risque identifié' };
  const n = p.n;

  $('#v-product').innerHTML = `
    ${backBtn()}
    ${offline ? '<p class="hint">Hors ligne : fiche enregistrée sur le téléphone.</p>' : ''}

    <!-- En-tête : image, nom, note -->
    <div class="card head" style="margin-top:.8rem">
      ${p.img ? `<img src="${esc(p.img)}" alt="">` : ''}
      <div class="t">
        <h2 style="margin:0">${esc(p.name)}</h2>
        <div class="hint">${esc(p.brand)} ${esc(p.qty)}</div>
      </div>
      <div class="big" style="background:${scoreColor(s.total)}">
        <b>${s.total ?? '?'}</b><small>${scoreLabel(s.total)}</small>
      </div>
    </div>

    <!-- Alertes des profils -->
    ${alerts.length ? `<div class="card">${alerts.map(a => `<div class="alert ${a.level}">${esc(a.text)}</div>`).join('')}</div>` : ''}

    <!-- Détail de la note -->
    <div class="card">
      <h2 style="margin-top:0">Pourquoi cette note</h2>
      ${s.partial ? '<p class="hint">Note partielle : certaines données manquent pour ce produit.</p>' : ''}
      ${s.parts.map(x => `
        <div class="part">
          <div class="lbl"><span>${x.label}</span><span>${x.value}/100 · poids ${x.weight}</span></div>
          <div class="bar"><i style="width:${x.value}%;background:${scoreColor(x.value)}"></i></div>
          <p>${esc(x.detail)}</p>
        </div>`).join('') || '<p class="hint">Pas assez de données pour calculer une note.</p>'}
    </div>

    <!-- Additifs -->
    ${adds.length ? `<div class="card"><h2 style="margin-top:0">Additifs</h2>
      ${adds.map(a => `<div class="add"><span><b>${esc(a.code)}</b> ${esc(a.note)}</span><span class="lvl-${a.level}">${lvlTxt[a.level]}</span></div>`).join('')}
    </div>` : ''}

    <!-- Valeurs nutritionnelles -->
    <div class="card"><h2 style="margin-top:0">Pour 100 g</h2>
      <table>
        <tr><td>Énergie</td><td>${fmt(n.kcal, 'kcal')}</td></tr>
        <tr><td>Matières grasses</td><td>${fmt(n.fat, 'g')}</td></tr>
        <tr><td>dont saturées</td><td>${fmt(n.sat, 'g')}</td></tr>
        <tr><td>Glucides</td><td>${fmt(n.carbs, 'g')}</td></tr>
        <tr><td>dont sucres</td><td>${fmt(n.sugars, 'g')}</td></tr>
        <tr><td>Fibres</td><td>${fmt(n.fiber, 'g')}</td></tr>
        <tr><td>Protéines</td><td>${fmt(n.prot, 'g')}</td></tr>
        <tr><td>Sel</td><td>${fmt(n.salt, 'g')}</td></tr>
      </table>
    </div>

    <!-- Ingrédients + source -->
    <div class="card"><h2 style="margin-top:0">Ingrédients</h2>
      <p>${esc(p.ingredients) || '<span class="hint">Non renseignés</span>'}</p>
      <p class="hint">Source : <a href="${OFF_BASE}/product/${esc(p.code)}" target="_blank" rel="noopener">Open Food Facts</a> (ODbL) · code ${esc(p.code)}</p>
    </div>`;
  bindBack();
}

/* ---------- 11. LISTES (recherche + historique) ---------- */
function itemHTML(p, withDelete) {
  const s = computeScore(p, settings.weights).total;
  return `<li class="item" data-code="${esc(p.code)}">
    ${p.img ? `<img src="${esc(p.img)}" alt="" loading="lazy">` : '<div class="noimg"></div>'}
    <div class="txt"><div class="name">${esc(p.name)}</div><div class="brand">${esc(p.brand)}</div></div>
    <span class="badge" style="background:${scoreColor(s)}">${s ?? '?'}</span>
    ${withDelete ? '<button class="del" title="Supprimer">✕</button>' : ''}
  </li>`;
}

/* ---------- 12. RECHERCHE ---------- */
let lastResults = [];
$('#f-search').onsubmit = async e => {
  e.preventDefault();
  const q = $('#q').value.trim(); if (q.length < 2) return;
  const msg = $('#search-msg'), ul = $('#search-res');
  ul.innerHTML = '';
  try {
    if (!navigator.onLine) {
      // Hors ligne : recherche dans les produits déjà enregistrés
      const ql = q.toLowerCase();
      lastResults = (await DB.all('products')).filter(p => (p.name + ' ' + p.brand).toLowerCase().includes(ql));
      msg.textContent = `Hors ligne : ${lastResults.length} produit(s) enregistré(s) trouvé(s).`;
    } else {
      msg.textContent = 'Recherche…';
      const r = await fetch(urlSearch(q));
      if (r.status === 429) { msg.textContent = 'Trop de recherches d’affilée : réessaie dans une minute.'; return; }
      const j = await r.json();
      lastResults = (j.products || []).filter(p => p.code).map(normalize);
      msg.textContent = lastResults.length ? `${lastResults.length} résultat(s)` : 'Aucun résultat.';
    }
    ul.innerHTML = lastResults.map(p => itemHTML(p, false)).join('');
  } catch (_) { msg.textContent = 'Erreur réseau, réessaie.'; }
};
$('#search-res').onclick = e => {
  const li = e.target.closest('.item'); if (!li) return;
  const p = lastResults.find(x => x.code === li.dataset.code);
  if (p) openProductData(p);
};

/* ---------- 13. HISTORIQUE ---------- */
async function renderHistory() {
  const [hist, prods] = await Promise.all([DB.all('history'), DB.all('products')]);
  const byCode = Object.fromEntries(prods.map(p => [p.code, p]));
  const items = hist.sort((a, b) => b.ts - a.ts).map(h => byCode[h.code]).filter(Boolean);
  $('#hist').innerHTML = items.length ? items.map(p => itemHTML(p, true)).join('') : '<p class="hint">Aucun produit scanné pour l’instant.</p>';
}
$('#hist').onclick = async e => {
  const li = e.target.closest('.item'); if (!li) return;
  if (e.target.classList.contains('del')) {
    await DB.del('history', li.dataset.code);
    Sync.queue('history', li.dataset.code, null, true); // suppression à propager
    renderHistory(); return;
  }
  const p = await DB.get('products', li.dataset.code);
  if (p) { show('product'); renderProduct(p, !navigator.onLine); }
};
$('#btn-clear').onclick = async () => {
  if (!confirm('Vider tout l’historique ?')) return;
  const all = await DB.all('history');
  await DB.clear('history');
  for (const h of all) await Sync.queue('history', h.code, null, true);
  renderHistory();
};

/* ---------- 14. RÉGLAGES (poids + profils) ---------- */
const WEIGHT_LABELS = { nutri: 'Nutri-Score', nova: 'Transformation (NOVA)', additives: 'Additifs', bio: 'Bio' };

function renderSettings() {
  renderAccount();
  // Curseurs de poids
  $('#weights').innerHTML = Object.keys(WEIGHT_LABELS).map(k => `
    <div class="w"><div class="lbl"><span>${WEIGHT_LABELS[k]}</span><b id="wv-${k}">${settings.weights[k]}</b></div>
    <input type="range" min="0" max="100" step="5" value="${settings.weights[k]}" data-w="${k}"></div>`).join('');
  $('#weights').querySelectorAll('input').forEach(i => i.oninput = () => {
    settings.weights[i.dataset.w] = Number(i.value);
    $('#wv-' + i.dataset.w).textContent = i.value;
    saveSettings();
  });

  // Profils
  $('#profiles').innerHTML = settings.profiles.map(pr => `
    <div class="profile" data-id="${pr.id}">
      <div class="row">
        <input value="${esc(pr.name)}" data-act="name" style="flex:1">
        <label><input type="checkbox" data-act="active" ${pr.active ? 'checked' : ''} style="width:auto"> Actif</label>
        ${settings.profiles.length > 1 ? '<button class="ghost" data-act="del">✕</button>' : ''}
      </div>
      <div class="chips">${Object.entries(ALERTS).map(([k, a]) =>
        `<button class="chip ${pr.alerts.includes(k) ? 'on' : ''}" data-act="alert" data-k="${k}">${a.label}</button>`).join('')}</div>
    </div>`).join('');
}

// Un seul écouteur pour tous les profils
$('#profiles').addEventListener('click', e => {
  const box = e.target.closest('.profile'); if (!box) return;
  const pr = settings.profiles.find(x => x.id === box.dataset.id);
  const act = e.target.dataset.act;
  if (act === 'alert') {
    const k = e.target.dataset.k;
    pr.alerts = pr.alerts.includes(k) ? pr.alerts.filter(x => x !== k) : [...pr.alerts, k];
  } else if (act === 'del') {
    settings.profiles = settings.profiles.filter(x => x !== pr);
  } else return;
  saveSettings(); renderSettings();
});
$('#profiles').addEventListener('change', e => {
  const box = e.target.closest('.profile'); if (!box) return;
  const pr = settings.profiles.find(x => x.id === box.dataset.id);
  if (e.target.dataset.act === 'name') pr.name = e.target.value.trim() || 'Profil';
  if (e.target.dataset.act === 'active') pr.active = e.target.checked;
  saveSettings();
});
$('#btn-add-profile').onclick = () => {
  settings.profiles.push({ id: 'p' + Date.now(), name: 'Profil ' + (settings.profiles.length + 1), active: true, alerts: [] });
  saveSettings(); renderSettings();
};

/* ---------- 15. SYNCHRONISATION AVEC LE SERVEUR ---------- */
// Principe : le téléphone reste la référence hors ligne. Chaque modification
// est mise en file (table pending) puis envoyée ; le serveur renvoie les
// modifications faites ailleurs. En cas de conflit, la plus récente gagne.
const Sync = {
  state: { token: null, email: null, consent: false, lastSync: 0, lastOk: null },
  timer: null, busy: false,

  async load() { const s = await DB.get('kv', 'sync'); if (s) this.state = { ...this.state, ...s }; },
  save() { return DB.put('kv', this.state, 'sync'); },

  // Appel à l'API (le jeton voyage dans le corps JSON, plus fiable chez Infomaniak)
  async api(action, body = {}) {
    const r = await fetch(`${SERVER}/api/?action=${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, token: this.state.token })
    });
    const j = await r.json().catch(() => ({ error: 'Réponse invalide du serveur' }));
    if (!r.ok || j.error) throw new Error(j.error || 'Erreur ' + r.status);
    return j;
  },

  // Met une modification en file et programme un envoi dans 3 s
  async queue(store, key, data, deleted = false) {
    await DB.put('pending', { id: store + ':' + key, store, key, data, updated: Date.now(), deleted });
    clearTimeout(this.timer);
    if (this.state.token) this.timer = setTimeout(() => this.run().catch(() => {}), 3000);
  },

  // Met toutes les données locales en file (après connexion)
  async queueAll() {
    for (const h of await DB.all('history')) await this.queue('history', h.code, { ts: h.ts, p: await DB.get('products', h.code) });
    await this.queue('settings', 'weights', settings.weights);
    await this.queue('profiles', 'all', settings.profiles);
  },

  // Envoi + réception
  async run() {
    if (!this.state.token || !navigator.onLine || this.busy) return;
    this.busy = true;
    try {
      // Sans consentement santé, les profils (allergies, régimes) ne partent pas
      const pending = (await DB.all('pending')).filter(p => this.state.consent || p.store !== 'profiles');
      const j = await this.api('sync', { since: this.state.lastSync, changes: pending });
      for (const p of pending) {
        const cur = await DB.get('pending', p.id);
        if (cur && cur.updated === p.updated) await DB.del('pending', p.id); // pas modifié entre-temps
      }
      for (const c of j.changes) await applyRemote(c);
      this.state.lastSync = j.now; this.state.lastOk = Date.now();
      await this.save();
    } catch (e) {
      if (/session/i.test(e.message)) { this.state.token = null; await this.save(); }
      throw e;
    } finally { this.busy = false; }
  }
};

// Applique une modification venue du serveur (sans la renvoyer)
async function applyRemote(c) {
  if (c.store === 'history') {
    if (c.deleted) await DB.del('history', c.key);
    else {
      await DB.put('history', { code: c.key, ts: c.data.ts });
      if (c.data.p) await DB.put('products', c.data.p);
    }
  } else if (c.store === 'settings' && c.data) {
    settings.weights = { ...DEFAULT_SETTINGS.weights, ...c.data };
    await DB.put('kv', settings, 'settings');
  } else if (c.store === 'profiles' && Array.isArray(c.data) && c.data.length) {
    settings.profiles = c.data;
    await DB.put('kv', settings, 'settings');
  }
}

/* ---------- 16. ÉCRAN COMPTE (dans Réglages) ---------- */
const CONSENT_TXT = 'J’accepte que mes profils (allergies, régimes) soient sauvegardés sur le serveur de Clair pour être synchronisés. Je peux retirer ce consentement à tout moment.';

function renderAccount() {
  const box = $('#account'), st = Sync.state;
  if (!st.token) {
    box.innerHTML = `
      <p>Crée un compte pour sauvegarder tes données et les retrouver sur un autre téléphone.</p>
      <div class="form">
        <input id="ac-email" type="email" placeholder="E-mail" autocomplete="email">
        <input id="ac-pass" type="password" placeholder="Mot de passe (8 caractères min.)" autocomplete="current-password">
        <label><input id="ac-consent" type="checkbox"> ${CONSENT_TXT}</label>
        <div class="btns">
          <button id="ac-login">Se connecter</button>
          <button id="ac-register" class="ghost">Créer un compte</button>
          <button id="ac-forgot" class="ghost">Mot de passe oublié</button>
        </div>
        <p class="hint">En créant un compte, tu acceptes la <a href="${SERVER}/privacy.html" target="_blank" rel="noopener">politique de confidentialité</a>.</p>
        <p id="ac-msg" class="hint"></p>
      </div>`;
    const creds = () => ({ email: $('#ac-email').value.trim(), password: $('#ac-pass').value });
    $('#ac-login').onclick = () => accountAction('login', creds());
    $('#ac-register').onclick = () => accountAction('register', { ...creds(), consent: $('#ac-consent').checked });
    $('#ac-forgot').onclick = async () => {
      try { await Sync.api('request_reset', { email: creds().email }); $('#ac-msg').textContent = 'Si ce compte existe, un e-mail de réinitialisation vient d’être envoyé.'; }
      catch (e) { $('#ac-msg').textContent = e.message; }
    };
  } else {
    box.innerHTML = `
      <p>Connecté : <strong>${esc(st.email)}</strong><br>
      <span class="hint">Dernière synchro : ${st.lastOk ? new Date(st.lastOk).toLocaleString('fr-FR') : 'jamais'}</span></p>
      <div class="form"><label><input id="ac-consent" type="checkbox" ${st.consent ? 'checked' : ''}> ${CONSENT_TXT}</label></div>
      <div class="btns">
        <button id="ac-sync">Synchroniser</button>
        <button id="ac-export" class="ghost">Mes données</button>
        <button id="ac-logout" class="ghost">Se déconnecter</button>
        <button id="ac-delete" class="danger-btn">Supprimer mon compte</button>
      </div>
      <p id="ac-msg" class="hint"></p>
      <div id="ac-export-box"></div>`;
    const msg = t => ($('#ac-msg').textContent = t);
    $('#ac-sync').onclick = async () => { msg('Synchronisation…'); try { await Sync.run(); renderAccount(); } catch (e) { msg(e.message); } };
    $('#ac-consent').onchange = async e => {
      try {
        await Sync.api('consent', { value: e.target.checked });
        Sync.state.consent = e.target.checked; await Sync.save();
        if (Sync.state.consent) await Sync.queue('profiles', 'all', settings.profiles);
        msg(Sync.state.consent ? 'Profils synchronisés.' : 'Profils supprimés du serveur, ils restent sur ce téléphone.');
      } catch (err) { e.target.checked = !e.target.checked; msg(err.message); }
    };
    // Droit d'accès RGPD : affiche toutes les données stockées sur le serveur
    $('#ac-export').onclick = async () => {
      try {
        const j = await Sync.api('export');
        $('#ac-export-box').innerHTML = `<textarea readonly>${esc(JSON.stringify(j, null, 2))}</textarea><button id="ac-copy" class="ghost">Copier</button>`;
        $('#ac-copy').onclick = () => navigator.clipboard?.writeText(JSON.stringify(j, null, 2)).then(() => msg('Copié.'));
      } catch (e) { msg(e.message); }
    };
    $('#ac-logout').onclick = async () => {
      try { await Sync.api('logout'); } catch (_) {}
      Sync.state = { ...Sync.state, token: null, email: null, lastSync: 0, lastOk: null };
      await Sync.save(); renderAccount();
    };
    $('#ac-delete').onclick = async () => {
      const pw = prompt('Pour supprimer définitivement ton compte et tes données du serveur, saisis ton mot de passe :');
      if (!pw) return;
      try {
        await Sync.api('delete_account', { password: pw });
        Sync.state = { token: null, email: null, consent: false, lastSync: 0, lastOk: null };
        await Sync.save(); renderAccount();
      } catch (e) { msg(e.message); }
    };
  }
}

async function accountAction(action, body) {
  const msg = t => ($('#ac-msg').textContent = t);
  if (!body.email || !body.password) return msg('E-mail et mot de passe requis.');
  msg('Connexion…');
  try {
    const j = await Sync.api(action, body);
    Sync.state = { ...Sync.state, token: j.token, email: j.email, consent: !!j.consent, lastSync: 0 };
    await Sync.save();
    await Sync.queueAll();   // envoie ce qui est déjà sur le téléphone
    await Sync.run();        // et récupère ce qui est sur le serveur
    renderAccount();
  } catch (e) { msg(e.message); }
}

/* ---------- 17. SERVEUR : RÉFÉRENTIELS + MISES À JOUR ---------- */
// Liste des additifs modifiable sur le serveur sans recompiler l'appli
async function loadReferentials() {
  const cached = await DB.get('kv', 'ref');
  if (cached?.additives) ADDITIVES = cached.additives;
  try {
    const r = await fetch(`${SERVER}/data/referentiels.json`, { cache: 'no-store' });
    if (r.ok) { const j = await r.json(); if (j.additives) { ADDITIVES = j.additives; await DB.put('kv', j, 'ref'); } }
  } catch (_) { /* hors ligne : on garde la version en cache */ }
}

// Compare 1.2.3 et 1.10.0
const newer = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };

async function checkUpdate() {
  if (!isNative) return;
  try {
    const r = await fetch(`${SERVER}/version.json`, { cache: 'no-store' });
    const j = await r.json();
    if (j.version && newer(j.version, APP_VERSION)) {
      const u = $('#update');
      u.innerHTML = `Nouvelle version ${esc(j.version)} disponible${j.notes ? ' : ' + esc(j.notes) : ''}. <a href="${esc(j.apk)}" target="_blank" rel="noopener">Télécharger</a>`;
      u.hidden = false;
    }
  } catch (_) {}
}

/* ---------- 18. DÉMARRAGE ---------- */
function updateNet() { $('#net').textContent = navigator.onLine ? '' : '● Hors ligne'; }
window.addEventListener('online', () => { updateNet(); Sync.run().catch(() => {}); });
window.addEventListener('offline', updateNet);

(async function init() {
  $('#version').textContent = 'Version ' + APP_VERSION;
  updateNet();
  const saved = await DB.get('kv', 'settings');
  if (saved) settings = { ...structuredClone(DEFAULT_SETTINGS), ...saved, weights: { ...DEFAULT_SETTINGS.weights, ...saved.weights } };
  await Sync.load();
  // Service worker seulement en version web (inutile dans l'APK)
  if (!isNative && 'serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js');
  // Dans l'APK, pas de vidéo : le scanner natif ouvre son propre écran
  if (isNative) $('.cam').hidden = true;
  loadReferentials();
  checkUpdate();
  Sync.run().catch(() => {});
})();
