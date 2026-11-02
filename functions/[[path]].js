const DEFAULT_FIREBASE_PROJECT_ID = 'anna-menu';
const SAFE_KEY_REGEX = /^[a-zA-Z0-9_-]{3,120}\.(webp|jpg|jpeg|png)$/;
let dbInitialized = false;

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders
    }
  });
}

// Minimal Database Initialization
async function ensureDatabase(db) {
  if (dbInitialized) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, description TEXT DEFAULT '', display_order INTEGER NOT NULL DEFAULT 0, is_active INTEGER NOT NULL DEFAULT 1)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS menu_items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT DEFAULT '', price_paise INTEGER NOT NULL DEFAULT 0, original_price_paise INTEGER NOT NULL DEFAULT 0, custom_badge TEXT DEFAULT '', category_id INTEGER NOT NULL, image_key TEXT DEFAULT '', image_url TEXT DEFAULT '', is_vegetarian INTEGER NOT NULL DEFAULT 1, is_available INTEGER NOT NULL DEFAULT 1, is_featured INTEGER NOT NULL DEFAULT 0, display_order INTEGER NOT NULL DEFAULT 0)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS restaurant_settings (id INTEGER PRIMARY KEY CHECK (id = 1), restaurant_name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', address TEXT NOT NULL, phone TEXT NOT NULL, opening_hours TEXT NOT NULL DEFAULT '', announcement TEXT DEFAULT '', logo_url TEXT DEFAULT '', services TEXT NOT NULL DEFAULT '["Dine-in","Drive-through","Delivery"]', additional_settings TEXT NOT NULL DEFAULT '{"hindi_name":"अन्ना साउथ इंडियन डोसा","established":"Since 2001"}')`),
    db.prepare(`CREATE TABLE IF NOT EXISTS authorized_admins (email TEXT PRIMARY KEY, password_note TEXT DEFAULT '', added_at TEXT)`),
    db.prepare(`INSERT OR IGNORE INTO restaurant_settings (id, restaurant_name, address, phone, opening_hours) VALUES (1, 'Anna South Indian Dosa', 'PNB St, near Geeta Bhawan, Rori Bazar, B Block, Subhash Chowk, Sirsa, Haryana 125055', '98135-01421 / 98219-14139', 'Closes 10:00 PM')`)
  ]);
  dbInitialized = true;
}

function base64UrlToUint8Array(str) {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = base64.length % 4;
  if (pad) {
    if (pad === 1) throw new Error('Invalid base64 string length');
    base64 += new Array(5 - pad).join('=');
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Fixed Firebase Token Verifier
async function verifyFirebaseToken(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  if (!authHeader.startsWith('Bearer ')) return { ok: false, error: 'Missing authentication token.' };

  const parts = authHeader.slice(7).trim().split('.');
  if (parts.length !== 3) return { ok: false, error: 'Invalid token format.' };

  try {
    const header = JSON.parse(new TextDecoder().decode(base64UrlToUint
