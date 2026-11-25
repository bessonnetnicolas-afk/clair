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
// Mise à jour à distance du code (Capgo) : on confirme tout de suite que
// cette version démarre bien, sinon le plugin revient à la version précédente
const Updater = window.capacitorCapacitorUpdater?.CapacitorUpdater;
if (isNative && Updater) Updater.notifyAppReady();
const OFF_BASE = 'https://world.openfoodfacts.org';
// Champs demandés à l'API (limite le volume téléchargé)
const OFF_FIELDS = ['code','product_name','product_name_fr','brands','quantity','image_front_small_url','image_front_url',
  'nutriscore_grade','nova_group','additives_tags','allergens_tags','traces_tags','ingredients_analysis_tags',
  'labels_tags','ingredients_text','ingredients_text_fr','nutriments','categories_tags'].join(',');
// Alternatives : produits de la même catégorie vendus en France
const urlAlt = cat => `${OFF_BASE}/api/v2/search?categories_tags=${encodeURIComponent(cat)}&countries_tags=en:france&page_size=50&fields=${OFF_FIELDS}`;
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
      const r = indexedDB.open('clair', 3);
      r.onupgradeneeded = () => {
        const db = r.result, has = n => db.objectStoreNames.contains(n);
        if (!has('products')) db.createObjectStore('products', { keyPath: 'code' });
        if (!has('history')) db.createObjectStore('history', { keyPath: 'code' });
        if (!has('kv')) db.createObjectStore('kv');
        if (!has('pending')) db.createObjectStore('pending', { keyPath: 'id' });
        if (!has('list')) db.createObjectStore('list', { keyPath: 'code' }); // liste de courses
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
    categories: p.categories_tags || [],
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
  if (view === 'list') renderList();
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
    else if (r.notFound) renderAddForm(r.code);
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
  // Mode comparaison : le 2e produit ouvert affiche le comparatif
  if (compareA && compareA.code !== p.code) { const a = compareA; endCompare(); return renderCompare(a, p); }
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

    <!-- Actions : liste de courses + comparaison -->
    <div class="actions">
      <button id="btn-list" class="ghost">+ Liste</button>
      <button id="btn-compare" class="ghost">⇄ Comparer</button>
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

    <!-- Meilleures alternatives (recherche à la demande : l'API limite les recherches) -->
    ${(p.categories || []).length ? `<div class="card"><h2 style="margin-top:0">Meilleures alternatives</h2>
      <button id="btn-alt" class="ghost">Chercher dans la même catégorie</button>
      <ul id="alt-list" class="list" style="margin-top:.6rem"></ul></div>` : ''}

    <!-- Ingrédients + source -->
    <div class="card"><h2 style="margin-top:0">Ingrédients</h2>
      <p>${esc(p.ingredients) || '<span class="hint">Non renseignés</span>'}</p>
      <p class="hint">Source : <a href="${OFF_BASE}/product/${esc(p.code)}" target="_blank" rel="noopener">Open Food Facts</a> (ODbL) · code ${esc(p.code)}</p>
    </div>`;
  bindBack();
  bindProductActions(p, s.total);
}

// Boutons de la fiche : liste, comparaison, alternatives
async function bindProductActions(p, myScore) {
  const btnList = $('#btn-list');
  const setLabel = inList => (btnList.textContent = inList ? '✓ Dans la liste' : '+ Liste');
  setLabel(!!(await DB.get('list', p.code)));
  btnList.onclick = async () => setLabel(await toggleList(p));
  $('#btn-compare').onclick = () => startCompare(p);
  const btnAlt = $('#btn-alt');
  if (btnAlt) btnAlt.onclick = () => findAlternatives(p, myScore);
  const altList = $('#alt-list');
  if (altList) altList.onclick = e => {
    const li = e.target.closest('.item'); if (!li) return;
    const x = altResults.find(q => q.code === li.dataset.code);
    if (x) openProductData(x);
  };
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
    for (const l of await DB.all('list')) await this.queue('list', l.code, { ts: l.ts, done: l.done, p: await DB.get('products', l.code) });
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
  } else if (c.store === 'list') {
    if (c.deleted) await DB.del('list', c.key);
    else {
      await DB.put('list', { code: c.key, ts: c.data.ts, done: !!c.data.done });
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
    const j = await getJSON(`${SERVER}/data/referentiels.json`);
    if (j.additives) { ADDITIVES = j.additives; await DB.put('kv', j, 'ref'); }
  } catch (_) { /* hors ligne : on garde la version en cache */ }
}

// Compare 1.2.3 et 1.10.0
const newer = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };

async function checkUpdate() {
  if (!isNative) return;
  try {
    const j = await getJSON(`${SERVER}/version.json`);
    if (j.version && newer(j.version, APP_VERSION)) {
      const u = $('#update');
      u.innerHTML = `Nouvelle version ${esc(j.version)} disponible${j.notes ? ' : ' + esc(j.notes) : ''}. <a href="${esc(j.apk)}" target="_blank" rel="noopener">Télécharger</a>`;
      u.hidden = false;
    }
  } catch (_) {}
}

/* ---------- 18. MISE À JOUR AUTOMATIQUE DU CODE (sans réinstaller) ---------- */
// GitHub publie sur le serveur live/latest.json { build, url } + un zip du dossier www.
// Si le build du serveur est plus récent, on le télécharge en arrière-plan ;
// il s'applique quand l'appli passe en arrière-plan ou au prochain lancement.
async function checkLiveUpdate() {
  const status = t => { const el = $('#upd-status'); if (el) el.textContent = 'Mise à jour : ' + t; };
  if (!isNative) return;
  if (!Updater) return status('module absent (réinstaller l’APK)');
  try {
    const mine = await (await fetch('build.json', { cache: 'no-store' })).json();
    $('#version').textContent = `Version ${APP_VERSION} · build ${mine.build}`;
    status('vérification…');
    const latest = await getJSON(`${SERVER}/live/latest.json`);
    if (!(Number(latest.build) > Number(mine.build))) return status('à jour');
    const version = String(latest.build);
    // Déjà téléchargé lors d'un précédent lancement ?
    const { bundles } = await Updater.list();
    let bundle = bundles.find(b => b.version === version && b.status !== 'error');
    if (!bundle) {
      status(`téléchargement du build ${version}…`);
      bundle = await Updater.download({ url: latest.url, version });
    }
    await Updater.next({ id: bundle.id });
    status(`build ${version} prêt : ferme complètement l’appli puis rouvre-la`);
  } catch (e) { status('erreur — ' + (e?.message || e)); }
}

// Lecture d'un JSON du serveur : canal natif dans l'APK (pas de blocage CORS)
async function getJSON(url) {
  const http = window.capacitorExports?.CapacitorHttp;
  if (isNative && http) {
    const r = await http.get({ url: url + '?t=' + Date.now() });
    if (r.status !== 200) throw new Error('HTTP ' + r.status);
    return typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
  }
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

/* ---------- 19. LISTE DE COURSES ---------- */
// Ajoute / retire un produit de la liste ; renvoie true s'il y est maintenant
async function toggleList(p) {
  if (await DB.get('list', p.code)) {
    await DB.del('list', p.code);
    Sync.queue('list', p.code, null, true);
    return false;
  }
  const item = { code: p.code, ts: Date.now(), done: false };
  await DB.put('list', item);
  Sync.queue('list', p.code, { ts: item.ts, done: false, p });
  return true;
}

async function renderList() {
  const [items, prods] = await Promise.all([DB.all('list'), DB.all('products')]);
  const by = Object.fromEntries(prods.map(p => [p.code, p]));
  // Non cochés d'abord, puis les plus récents
  const rows = items.filter(i => by[i.code]).sort((a, b) => a.done - b.done || b.ts - a.ts);
  // Note du panier = moyenne des notes des produits
  const scores = rows.map(i => computeScore(by[i.code], settings.weights).total).filter(v => v != null);
  const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
  const nAlert = rows.filter(i => checkAlerts(by[i.code]).some(a => a.level === 'danger')).length;
  $('#shop-summary').innerHTML = rows.length ? `
    <div class="card head">
      <div class="big" style="background:${scoreColor(avg)}"><b>${avg ?? '?'}</b><small>Panier</small></div>
      <div class="t"><strong>${rows.length} produit(s)</strong>, ${rows.filter(i => i.done).length} coché(s)<br>
      ${nAlert ? `<span class="lvl-high">⚠ ${nAlert} produit(s) avec alerte</span>` : '<span class="hint">Aucune alerte pour le foyer</span>'}</div>
    </div>` : '';
  $('#shop').innerHTML = rows.length
    ? rows.map(i => {
        const p = by[i.code], s = computeScore(p, settings.weights).total;
        const danger = checkAlerts(p).some(a => a.level === 'danger');
        return `<li class="item ${i.done ? 'done' : ''}" data-code="${esc(p.code)}">
          <input type="checkbox" class="chk" ${i.done ? 'checked' : ''}>
          ${p.img ? `<img src="${esc(p.img)}" alt="" loading="lazy">` : '<div class="noimg"></div>'}
          <div class="txt"><div class="name">${danger ? '⚠ ' : ''}${esc(p.name)}</div><div class="brand">${esc(p.brand)}</div></div>
          <span class="badge" style="background:${scoreColor(s)}">${s ?? '?'}</span>
          <button class="del" title="Retirer">✕</button></li>`;
      }).join('')
    : '<p class="hint">Liste vide. Ajoute des produits depuis leur fiche (« + Liste »).</p>';
}

$('#shop').onclick = async e => {
  const li = e.target.closest('.item'); if (!li) return;
  const code = li.dataset.code;
  if (e.target.classList.contains('chk')) {          // cocher / décocher
    const it = await DB.get('list', code);
    it.done = e.target.checked;
    await DB.put('list', it);
    Sync.queue('list', code, { ts: it.ts, done: it.done, p: await DB.get('products', code) });
    return renderList();
  }
  if (e.target.classList.contains('del')) {          // retirer
    await DB.del('list', code);
    Sync.queue('list', code, null, true);
    return renderList();
  }
  const p = await DB.get('products', code);          // ouvrir la fiche
  if (p) { show('product'); renderProduct(p, !navigator.onLine); }
};
$('#btn-shop-clean').onclick = async () => {
  for (const it of await DB.all('list')) if (it.done) { await DB.del('list', it.code); Sync.queue('list', it.code, null, true); }
  renderList();
};

/* ---------- 20. COMPARATEUR (2 produits) ---------- */
let compareA = null;
function startCompare(p) {
  compareA = p;
  const b = $('#compare-banner');
  b.innerHTML = `Comparaison avec <b>${esc(p.name)}</b> : scanne ou ouvre le 2e produit. <button class="ghost" id="cmp-cancel">Annuler</button>`;
  b.hidden = false;
  $('#cmp-cancel').onclick = endCompare;
  show('scan');
}
function endCompare() { compareA = null; $('#compare-banner').hidden = true; }

function renderCompare(a, b) {
  const sa = computeScore(a, settings.weights), sb = computeScore(b, settings.weights);
  const risky = p => p.additives.map(additiveInfo).filter(x => x.level !== 'other').length;
  const dangers = p => checkAlerts(p).filter(x => x.level === 'danger').length;
  // [libellé, valeur A, valeur B, sens : 1 = plus haut = mieux, -1 = plus bas = mieux]
  const rows = [
    ['Note Clair', sa.total, sb.total, 1],
    ['Nutri-Score', a.nutri.toUpperCase() || null, b.nutri.toUpperCase() || null, -1],
    ['NOVA', a.nova, b.nova, -1],
    ['Additifs à risque', risky(a), risky(b), -1],
    ['Énergie (kcal)', a.n.kcal, b.n.kcal, -1],
    ['Sucres (g)', a.n.sugars, b.n.sugars, -1],
    ['Gras saturés (g)', a.n.sat, b.n.sat, -1],
    ['Sel (g)', a.n.salt, b.n.salt, -1],
    ['Fibres (g)', a.n.fiber, b.n.fiber, 1],
    ['Protéines (g)', a.n.prot, b.n.prot, 1],
    ['Alertes foyer', dangers(a), dangers(b), -1]
  ];
  const empty = v => v == null || v === '';
  const cell = (v, o, dir) => {
    if (empty(v)) return '<td>—</td>';
    const win = !empty(o) && v !== o && (dir > 0 ? v > o : v < o);
    return `<td class="${win ? 'win' : ''}">${esc(typeof v === 'number' ? Math.round(v * 10) / 10 : v)}</td>`;
  };
  $('#v-product').innerHTML = `${backBtn()}
    <div class="card" style="margin-top:.8rem"><h2 style="margin-top:0">Comparatif</h2>
      <table class="cmp">
        <tr><th></th>${[a, b].map(p => `<th data-code="${esc(p.code)}">${p.img ? `<img src="${esc(p.img)}" alt="">` : ''}<div>${esc(p.name)}</div></th>`).join('')}</tr>
        ${rows.map(r => `<tr><td>${r[0]}</td>${cell(r[1], r[2], r[3])}${cell(r[2], r[1], r[3])}</tr>`).join('')}
      </table>
      <p class="hint">En vert : le meilleur des deux. Touche un produit pour ouvrir sa fiche.</p>
    </div>`;
  bindBack();
  $('#v-product').querySelectorAll('th[data-code]').forEach(th => th.onclick = async () => {
    const p = await DB.get('products', th.dataset.code); if (p) renderProduct(p, false);
  });
}

/* ---------- 21. MEILLEURES ALTERNATIVES ---------- */
// Même catégorie (la plus précise), notées avec TES poids, sans alerte du foyer
let altResults = [];
async function findAlternatives(p, myScore) {
  const box = $('#alt-list'), btn = $('#btn-alt');
  btn.disabled = true; btn.textContent = 'Recherche…';
  try {
    const cat = p.categories[p.categories.length - 1];
    const r = await fetch(urlAlt(cat));
    if (r.status === 429) throw new Error('Trop de recherches d’affilée : réessaie dans une minute.');
    const j = await r.json();
    const best = (j.products || []).filter(x => x.code && x.code !== p.code).map(normalize)
      .map(x => ({ p: x, s: computeScore(x, settings.weights).total }))
      .filter(x => x.s != null && (myScore == null || x.s > myScore) && !checkAlerts(x.p).some(a => a.level === 'danger'))
      .sort((a, b) => b.s - a.s).slice(0, 5);
    altResults = best.map(x => x.p);
    box.innerHTML = best.length ? altResults.map(x => itemHTML(x, false)).join('')
      : '<p class="hint">Pas de meilleure alternative trouvée dans cette catégorie.</p>';
    btn.hidden = true;
  } catch (e) {
    btn.disabled = false; btn.textContent = 'Réessayer';
    box.innerHTML = `<p class="hint">${esc(e.message || 'Erreur réseau')}</p>`;
  }
}

/* ---------- 22. AJOUT D'UN PRODUIT DANS OPEN FOOD FACTS ---------- */
const PHOTOS = [
  { field: 'front_fr', label: 'Photo face avant' },
  { field: 'ingredients_fr', label: 'Photo des ingrédients' },
  { field: 'nutrition_fr', label: 'Photo du tableau nutritionnel' }
];
const NUTRI_FIELDS = [
  { key: 'energy-kcal', label: 'Énergie (kcal)', unit: 'kcal' },
  { key: 'fat', label: 'Matières grasses (g)', unit: 'g' },
  { key: 'saturated-fat', label: 'dont saturées (g)', unit: 'g' },
  { key: 'carbohydrates', label: 'Glucides (g)', unit: 'g' },
  { key: 'sugars', label: 'dont sucres (g)', unit: 'g' },
  { key: 'fiber', label: 'Fibres (g)', unit: 'g' },
  { key: 'proteins', label: 'Protéines (g)', unit: 'g' },
  { key: 'salt', label: 'Sel (g)', unit: 'g' }
];

async function renderAddForm(code) {
  // Identifiants Open Food Facts : gardés sur le téléphone uniquement
  const off = await DB.get('kv', 'off');
  $('#v-product').innerHTML = `${backBtn()}
    <div class="card" style="margin-top:.8rem">
      <h2 style="margin-top:0">Produit inconnu</h2>
      <p class="hint">Le code ${esc(code)} n’est pas dans Open Food Facts. Ajoute-le : ta contribution servira à tous.</p>
      <div class="form">
        ${off
          ? `<p class="hint">Compte Open Food Facts : <b>${esc(off.user)}</b> <button class="ghost" id="off-change" type="button">Changer</button></p>`
          : `<p class="hint">Il faut un compte Open Food Facts (gratuit) : <a href="https://world.openfoodfacts.org/cgi/user.pl" target="_blank" rel="noopener">créer un compte</a>.</p>
             <input id="off-user" placeholder="Identifiant Open Food Facts (pas l’e-mail)" autocomplete="username">
             <input id="off-pass" type="password" placeholder="Mot de passe Open Food Facts" autocomplete="current-password">`}
        <h3>Photos</h3>
        ${PHOTOS.map(ph => `<label class="photo">${ph.label}<input type="file" accept="image/*" capture="environment" data-field="${ph.field}"></label>`).join('')}
        <h3>Informations</h3>
        <input id="add-name" placeholder="Nom du produit *">
        <input id="add-brand" placeholder="Marque">
        <input id="add-qty" placeholder="Quantité (ex : 500 g)">
        <input id="add-cat" placeholder="Catégorie (ex : Yaourts nature)">
        <textarea id="add-ingr" placeholder="Ingrédients, tels qu’écrits sur l’emballage"></textarea>
        <h3>Valeurs pour 100 g (facultatif)</h3>
        <div class="grid2">${NUTRI_FIELDS.map(f => `<input type="number" step="any" inputmode="decimal" data-n="${f.key}" placeholder="${f.label}">`).join('')}</div>
        <button id="add-send" class="primary" type="button">Envoyer à Open Food Facts</button>
        <p id="add-msg" class="hint"></p>
      </div>
    </div>`;
  bindBack();
  const change = $('#off-change');
  if (change) change.onclick = async () => { await DB.del('kv', 'off'); renderAddForm(code); };
  $('#add-send').onclick = () => sendProduct(code);
}

async function sendProduct(code) {
  const msg = t => ($('#add-msg').textContent = t);
  let off = await DB.get('kv', 'off');
  if (!off) {
    const user = $('#off-user').value.trim(), pass = $('#off-pass').value;
    if (!user || !pass) return msg('Identifiant et mot de passe Open Food Facts requis.');
    off = { user, pass };
  }
  const name = $('#add-name').value.trim();
  if (!name) return msg('Le nom du produit est obligatoire.');

  // 1. Informations texte + valeurs nutritionnelles
  const f = new FormData();
  const add = (k, v) => { if (v !== '' && v != null) f.append(k, v); };
  add('code', code); add('user_id', off.user); add('password', off.pass);
  add('lang', 'fr'); add('app_name', 'Clair'); add('app_version', APP_VERSION);
  add('comment', 'Ajout via l’appli Clair');
  add('product_name', name);
  add('brands', $('#add-brand').value.trim());
  add('quantity', $('#add-qty').value.trim());
  add('categories', $('#add-cat').value.trim());
  add('ingredients_text_fr', $('#add-ingr').value.trim());
  let hasN = false;
  document.querySelectorAll('[data-n]').forEach(i => {
    if (i.value === '') return;
    const nf = NUTRI_FIELDS.find(x => x.key === i.dataset.n);
    add('nutriment_' + nf.key, i.value); add('nutriment_' + nf.key + '_unit', nf.unit); hasN = true;
  });
  if (hasN) add('nutrition_data_per', '100g');

  msg('Envoi des informations…');
  try {
    const r = await fetch(`${OFF_BASE}/cgi/product_jqm2.pl`, { method: 'POST', body: f });
    const j = await r.json();
    if (j.status !== 1) throw new Error(j.status_verbose || 'refusé (identifiants Open Food Facts ?)');
    await DB.put('kv', off, 'off'); // identifiants valides : on les garde

    // 2. Photos (réduites à 1600 px pour limiter les données)
    const inputs = [...document.querySelectorAll('input[data-field]')].filter(i => i.files[0]);
    for (const [k, inp] of inputs.entries()) {
      msg(`Envoi des photos (${k + 1}/${inputs.length})…`);
      const g = new FormData();
      g.append('code', code); g.append('user_id', off.user); g.append('password', off.pass);
      g.append('imagefield', inp.dataset.field);
      g.append('imgupload_' + inp.dataset.field, await shrinkImage(inp.files[0]), inp.dataset.field + '.jpg');
      await fetch(`${OFF_BASE}/cgi/product_image_upload.pl`, { method: 'POST', body: g });
    }
    msg('Merci ! Produit ajouté à Open Food Facts.');
    setTimeout(() => openProduct(code), 1500);
  } catch (e) { msg('Échec de l’envoi : ' + (e.message || 'erreur réseau')); }
}

// Réduit une photo (max 1600 px) et la convertit en JPEG
function shrinkImage(file, max = 1600) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      c.toBlob(b => (b ? res(b) : rej(new Error('photo illisible'))), 'image/jpeg', 0.85);
    };
    img.onerror = () => rej(new Error('photo illisible'));
    img.src = URL.createObjectURL(file);
  });
}

/* ---------- 23. DÉMARRAGE ---------- */
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
  checkLiveUpdate();
  Sync.run().catch(() => {});
})();
