const FIREBASE_API_KEY = 'AIzaSyDxxCYCn-HL6ifsoGiQZ_quskyjJgN-JXs';
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

async function ensureDatabase(db) {
  if (dbInitialized) return;
  const queries = [
    `CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, description TEXT DEFAULT '', display_order INTEGER NOT NULL DEFAULT 0, is_active INTEGER NOT NULL DEFAULT 1)`,
    `CREATE TABLE IF NOT EXISTS menu_items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT DEFAULT '', price_paise INTEGER NOT NULL DEFAULT 0, original_price_paise INTEGER NOT NULL DEFAULT 0, custom_badge TEXT DEFAULT '', category_id INTEGER NOT NULL, image_key TEXT DEFAULT '', image_url TEXT DEFAULT '', is_vegetarian INTEGER NOT NULL DEFAULT 1, is_available INTEGER NOT NULL DEFAULT 1, is_featured INTEGER NOT NULL DEFAULT 0, display_order INTEGER NOT NULL DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS restaurant_settings (id INTEGER PRIMARY KEY CHECK (id = 1), restaurant_name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', address TEXT NOT NULL, phone TEXT NOT NULL, opening_hours TEXT NOT NULL DEFAULT '', announcement TEXT DEFAULT '', logo_url TEXT DEFAULT '', services TEXT NOT NULL DEFAULT '["Dine-in","Drive-through","Delivery"]', additional_settings TEXT NOT NULL DEFAULT '{"hindi_name":"अन्ना साउथ इंडियन डोसा","established":"Since 2001"}')`,
    `CREATE TABLE IF NOT EXISTS authorized_admins (email TEXT PRIMARY KEY, password_note TEXT DEFAULT '', added_at TEXT)`,
    `INSERT OR IGNORE INTO restaurant_settings (id, restaurant_name, address, phone, opening_hours) VALUES (1, 'Anna South Indian Dosa', 'PNB St, near Geeta Bhawan, Rori Bazar, B Block, Subhash Chowk, Sirsa, Haryana 125055', '98135-01421 / 98219-14139', 'Closes 10:00 PM')`,
    // Safe schema upgrades for new features
    `ALTER TABLE menu_items ADD COLUMN item_tag TEXT DEFAULT ''`,
    `ALTER TABLE menu_items ADD COLUMN out_of_stock_at INTEGER DEFAULT 0`
  ];
  for (const q of queries) { try { await db.prepare(q).run(); } catch(e) {} }
  dbInitialized = true;
}

// Auto-Reset Out of Stock items if it is a new calendar day in Indian Standard Time (IST)
function applyAutoStockReset(items) {
  const now = Date.now();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const todayIST = new Date(now + istOffset).toISOString().split('T')[0];

  items.forEach(item => {
    if (item.is_available === 0 && item.out_of_stock_at > 0) {
      const oosIST = new Date(item.out_of_stock_at + istOffset).toISOString().split('T')[0];
      if (oosIST !== todayIST) {
        item.is_available = 1; // Auto-correct to available for the frontend
      }
    }
  });
}

function base64UrlToUint8Array(str) {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = base64.length % 4;
  if (pad) { if (pad === 1) throw new Error('Invalid base64 string length'); base64 += new Array(5 - pad).join('='); }
  const binary = atob(base64); const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function verifyFirebaseToken(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  if (!authHeader.startsWith('Bearer ')) return { ok: false, error: 'Missing authentication token.' };
  const token = authHeader.slice(7).trim();

  try {
    const fbRes = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken: token }) });
    const fbData = await fbRes.json();
    if (!fbRes.ok || !fbData.users || fbData.users.length === 0) return { ok: false, error: 'Firebase rejected session.' };
    const email = (fbData.users[0].email || '').toLowerCase();
    
    const countRow = await env.DB.prepare(`SELECT COUNT(*) AS c FROM authorized_admins`).first();
    if (!countRow || countRow.c === 0) {
      await env.DB.prepare(`INSERT INTO authorized_admins (email, added_at) VALUES (?, datetime('now'))`).bind(email).run();
    } else {
      const check = await env.DB.prepare(`SELECT email FROM authorized_admins WHERE email = ?`).bind(email).first();
      if (!check) return { ok: false, error: 'Email not authorized.' };
    }
    return { ok: true, email };
  } catch (err) { return { ok: false, error: 'Auth Error: ' + err.message }; }
}

async function cleanupOrphanedR2Image(env, imageKey) {
  if (!imageKey || !SAFE_KEY_REGEX.test(imageKey)) return;
  try {
    const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM menu_items WHERE image_key = ?`).bind(imageKey).first();
    if (!row || row.count === 0) await env.MEDIA_BUCKET.delete(imageKey);
  } catch {}
}

export async function onRequest(context) {
  try {
    const { request, env } = context;
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();

    if (!env.DB) throw new Error("Cloudflare D1 Database binding missing.");
    if (!env.MEDIA_BUCKET) throw new Error("Cloudflare R2 Bucket binding missing.");

    if (path.startsWith('/media/')) {
      const key = path.slice('/media/'.length).trim();
      if (!SAFE_KEY_REGEX.test(key) || key.includes('..') || key.includes('/')) return new Response('Invalid media key', { status: 400 });
      const object = await env.MEDIA_BUCKET.get(key, { onlyIf: request.headers });
      if (!object) return new Response('Not Found', { status: 404 });
      const headers = new Headers();
      object.writeHttpMetadata(headers); headers.set('ETag', object.httpEtag); headers.set('Cache-Control', 'public, max-age=31536000, immutable');
      if (!('body' in object) || !object.body) return new Response(null, { status: 304, headers });
      return new Response(object.body, { status: 200, headers });
    }

    if (path.startsWith('/api/')) {
      await ensureDatabase(env.DB);

      if (path === '/api/menu' && method === 'GET') {
        const [sRes, cRes, iRes] = await env.DB.batch([
          env.DB.prepare(`SELECT * FROM restaurant_settings WHERE id = 1`),
          env.DB.prepare(`SELECT * FROM categories WHERE is_active = 1 ORDER BY display_order ASC, id ASC`),
          env.DB.prepare(`SELECT m.* FROM menu_items m INNER JOIN categories c ON c.id = m.category_id WHERE c.is_active = 1 ORDER BY c.display_order ASC, m.display_order ASC, m.id ASC`)
        ]);
        const raw = sRes.results[0] || {};
        let services = ['Dine-in'], additional = {};
        try { services = JSON.parse(raw.services || '[]'); } catch {} try { additional = JSON.parse(raw.additional_settings || '{}'); } catch {}
        
        applyAutoStockReset(iRes.results); // Auto resets next-day items

        return json({ settings: { restaurant_name: raw.restaurant_name || '', address: raw.address || '', phone: raw.phone || '', opening_hours: raw.opening_hours || '', announcement: raw.announcement || '', logo_url: raw.logo_url || '', services, additional_settings: additional }, categories: cRes.results || [], items: iRes.results || [] });
      }

      const auth = await verifyFirebaseToken(request, env);
      if (!auth.ok) return json({ error: auth.error }, 401);

      if (path === '/api/bulk' && method === 'POST') {
        const b = await request.json();
        if (b.action === 'replace_price') {
          await env.DB.prepare(`UPDATE menu_items SET price_paise = ? WHERE price_paise = ?`).bind(Number(b.new_price_paise), Number(b.old_price_paise)).run(); return json({ ok: true });
        }
        if (b.action === 'stock') {
          const isAvail = Number(b.is_available) === 1 ? 1 : 0;
          const oosTime = isAvail === 0 ? Date.now() : 0;
          if (b.category_id === 'all') {
            await env.DB.prepare(`UPDATE menu_items SET is_available = ?, out_of_stock_at = ?`).bind(isAvail, oosTime).run();
          } else {
            await env.DB.prepare(`UPDATE menu_items SET is_available = ?, out_of_stock_at = ? WHERE category_id = ?`).bind(isAvail, oosTime, Number(b.category_id)).run();
          }
          return json({ ok: true });
        }
        if (b.action === 'start_sale') {
          const disc = Number(b.discount_percent), badge = String(b.badge || '');
          const q = `UPDATE menu_items SET original_price_paise = CASE WHEN original_price_paise > 0 THEN original_price_paise ELSE price_paise END, price_paise = CAST(ROUND((CASE WHEN original_price_paise > 0 THEN original_price_paise ELSE price_paise END) * ((100.0 - ?) / 100.0)) AS INTEGER), custom_badge = ? ${b.category_id !== 'all' ? 'WHERE category_id = ?' : ''}`;
          if (b.category_id !== 'all') { await env.DB.prepare(q).bind(disc, badge, Number(b.category_id)).run(); } else { await env.DB.prepare(q).bind(disc, badge).run(); }
          return json({ ok: true });
        }
        if (b.action === 'end_sale') {
          const q = `UPDATE menu_items SET price_paise = CASE WHEN original_price_paise > 0 THEN original_price_paise ELSE price_paise END, original_price_paise = 0, custom_badge = '' ${b.category_id !== 'all' ? 'WHERE category_id = ? AND original_price_paise > 0' : 'WHERE original_price_paise > 0'}`;
          if (b.category_id !== 'all') { await env.DB.prepare(q).bind(Number(b.category_id)).run(); } else { await env.DB.prepare(q).run(); }
          return json({ ok: true });
        }
        return json({ error: 'Unknown bulk action' }, 400);
      }

      if (path === '/api/admin-data' && method === 'GET') {
        const [cRes, iRes, sRes, aRes] = await env.DB.batch([
          env.DB.prepare(`SELECT c.*, COUNT(m.id) AS item_count FROM categories c LEFT JOIN menu_items m ON m.category_id = c.id GROUP BY c.id ORDER BY c.display_order ASC, c.id ASC`),
          env.DB.prepare(`SELECT m.*, c.name AS category_name FROM menu_items m LEFT JOIN categories c ON c.id = m.category_id ORDER BY c.display_order ASC, m.display_order ASC, m.id DESC`),
          env.DB.prepare(`SELECT * FROM restaurant_settings WHERE id = 1`),
          env.DB.prepare(`SELECT email, password_note, added_at FROM authorized_admins ORDER BY added_at ASC`)
        ]);
        const raw = sRes.results[0] || {}; let services = ['Dine-in'], additional = {}; try { services = JSON.parse(raw.services || '[]'); } catch {} try { additional = JSON.parse(raw.additional_settings || '{}'); } catch {}
        
        applyAutoStockReset(iRes.results);

        return json({ categories: cRes.results || [], items: iRes.results || [], settings: { ...raw, services, additional_settings: additional }, admins: aRes.results || [] });
      }

      if (path === '/api/admins') {
        if (method === 'POST') {
          const b = await request.json(); const email = String(b.email || '').trim().toLowerCase();
          await env.DB.prepare(`INSERT INTO authorized_admins (email, password_note, added_at) VALUES (?, ?, datetime('now')) ON CONFLICT(email) DO UPDATE SET password_note = excluded.password_note`).bind(email, String(b.password_note || '')).run(); return json({ ok: true });
        }
        if (method === 'DELETE') {
          const target = String(url.searchParams.get('email') || '').toLowerCase();
          if (target === auth.email) return json({ error: 'Cannot revoke your own account.' }, 400);
          await env.DB.prepare(`DELETE FROM authorized_admins WHERE email = ?`).bind(target).run(); return json({ ok: true });
        }
      }

      if (path === '/api/upload' && method === 'POST') {
        const formData = await request.formData(), file = formData.get('image'); if (!file) return json({ error: 'No image' }, 400);
        const rand = Array.from(crypto.getRandomValues(new Uint8Array(6))).map((b) => b.toString(16).padStart(2, '0')).join('');
        const imageKey = `media-${Date.now()}-${rand}.webp`;
        await env.MEDIA_BUCKET.put(imageKey, await file.arrayBuffer(), { httpMetadata: { contentType: 'image/webp', cacheControl: 'public, max-age=31536000, immutable' } });
        return json({ ok: true, image_key: imageKey, image_url: `/media/${imageKey}` }, 201);
      }

      if (path === '/api/items') {
        if (method === 'POST' || method === 'PUT') {
          const b = await request.json(), id = Number(b.id || 0), imageKey = String(b.image_key || '').trim(), imageUrl = imageKey ? `/media/${imageKey}` : '';
          const tag = String(b.item_tag || '').trim();
          if (method === 'POST') {
            await env.DB.prepare(`INSERT INTO menu_items (name, description, item_tag, price_paise, original_price_paise, custom_badge, category_id, image_key, image_url, is_vegetarian, is_available, is_featured) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
              b.name, b.description || '', tag, Number(b.price_paise || 0), Number(b.original_price_paise || 0), b.custom_badge || '', Number(b.category_id), imageKey, imageUrl, b.is_vegetarian ? 1 : 0, b.is_available ? 1 : 0, b.is_featured ? 1 : 0).run();
          } else {
            const old = await env.DB.prepare(`SELECT image_key FROM menu_items WHERE id = ?`).bind(id).first();
            await env.DB.prepare(`UPDATE menu_items SET name=?, description=?, item_tag=?, price_paise=?, original_price_paise=?, custom_badge=?, category_id=?, image_key=?, image_url=?, is_vegetarian=?, is_available=?, is_featured=? WHERE id=?`).bind(
              b.name, b.description || '', tag, Number(b.price_paise || 0), Number(b.original_price_paise || 0), b.custom_badge || '', Number(b.category_id), imageKey, imageUrl, b.is_vegetarian ? 1 : 0, b.is_available ? 1 : 0, b.is_featured ? 1 : 0, id).run();
            if (old?.image_key && old.image_key !== imageKey) await cleanupOrphanedR2Image(env, old.image_key);
          }
          return json({ ok: true });
        }
        if (method === 'PATCH') { 
          const b = await request.json(); 
          const isAvail = b.is_available ? 1 : 0;
          const oosTime = isAvail === 0 ? Date.now() : 0;
          await env.DB.prepare(`UPDATE menu_items SET is_available = ?, out_of_stock_at = ? WHERE id = ?`).bind(isAvail, oosTime, Number(b.id)).run(); 
          return json({ ok: true }); 
        }
        if (method === 'DELETE') { const id = Number(url.searchParams.get('id')), existing = await env.DB.prepare(`SELECT image_key FROM menu_items WHERE id = ?`).bind(id).first(); await env.DB.prepare(`DELETE FROM menu_items WHERE id = ?`).bind(id).run(); if (existing?.image_key) await cleanupOrphanedR2Image(env, existing.image_key); return json({ ok: true }); }
      }

      if (path === '/api/categories') {
        if (method === 'POST') { const b = await request.json(), max = await env.DB.prepare(`SELECT COALESCE(MAX(display_order), 0) AS m FROM categories`).first(); await env.DB.prepare(`INSERT INTO categories (name, description, display_order, is_active) VALUES (?, ?, ?, ?)`).bind(b.name, b.description || '', (max?.m || 0) + 1, b.is_active ? 1 : 0).run(); return json({ ok: true }); }
        if (method === 'PUT') { const b = await request.json(); await env.DB.prepare(`UPDATE categories SET name = ?, description = ?, is_active = ? WHERE id = ?`).bind(b.name, b.description || '', b.is_active ? 1 : 0, Number(b.id)).run(); return json({ ok: true }); }
        if (method === 'DELETE') { const id = Number(url.searchParams.get('id')), used = await env.DB.prepare(`SELECT COUNT(*) AS c FROM menu_items WHERE category_id = ?`).bind(id).first(); if (used && used.c > 0) return json({ error: `Cannot delete category with ${used.c} dishes inside it.` }, 400); await env.DB.prepare(`DELETE FROM categories WHERE id = ?`).bind(id).run(); return json({ ok: true }); }
      }

      if (path === '/api/settings' && method === 'PUT') {
        const b = await request.json();
        await env.DB.prepare(`INSERT INTO restaurant_settings (id, restaurant_name, address, phone, opening_hours, announcement, logo_url, services, additional_settings) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET restaurant_name = excluded.restaurant_name, address = excluded.address, phone = excluded.phone, opening_hours = excluded.opening_hours, announcement = excluded.announcement, logo_url = excluded.logo_url, services = excluded.services, additional_settings = excluded.additional_settings`).bind(
          b.restaurant_name || '', b.address || '', b.phone || '', b.opening_hours || '', b.announcement || '', b.logo_url || '', JSON.stringify(Array.isArray(b.services) ? b.services : []), JSON.stringify(b.additional_settings || {})
        ).run(); return json({ ok: true });
      }

      return json({ error: 'API route not found' }, 404);
    }
    return context.next();
  } catch (error) { return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { 'Content-Type': 'application/json' } }); }
}
