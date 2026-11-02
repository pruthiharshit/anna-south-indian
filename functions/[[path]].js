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

// 1. Crash-Proof Database Initialization
// Instead of a strict batch, we run these one by one so a single conflict doesn't crash the server.
async function ensureDatabase(db) {
  if (dbInitialized) return;
  
  const setupQueries = [
    `CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, description TEXT DEFAULT '', display_order INTEGER NOT NULL DEFAULT 0, is_active INTEGER NOT NULL DEFAULT 1)`,
    `CREATE TABLE IF NOT EXISTS menu_items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT DEFAULT '', price_paise INTEGER NOT NULL DEFAULT 0, original_price_paise INTEGER NOT NULL DEFAULT 0, custom_badge TEXT DEFAULT '', category_id INTEGER NOT NULL, image_key TEXT DEFAULT '', image_url TEXT DEFAULT '', is_vegetarian INTEGER NOT NULL DEFAULT 1, is_available INTEGER NOT NULL DEFAULT 1, is_featured INTEGER NOT NULL DEFAULT 0, display_order INTEGER NOT NULL DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS restaurant_settings (id INTEGER PRIMARY KEY CHECK (id = 1), restaurant_name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', address TEXT NOT NULL, phone TEXT NOT NULL, opening_hours TEXT NOT NULL DEFAULT '', announcement TEXT DEFAULT '', logo_url TEXT DEFAULT '', services TEXT NOT NULL DEFAULT '["Dine-in","Drive-through","Delivery"]', additional_settings TEXT NOT NULL DEFAULT '{"hindi_name":"अन्ना साउथ इंडियन डोसा","established":"Since 2001"}')`,
    `CREATE TABLE IF NOT EXISTS authorized_admins (email TEXT PRIMARY KEY, password_note TEXT DEFAULT '', added_at TEXT)`,
    `INSERT OR IGNORE INTO restaurant_settings (id, restaurant_name, address, phone, opening_hours) VALUES (1, 'Anna South Indian Dosa', 'PNB St, near Geeta Bhawan, Rori Bazar, B Block, Subhash Chowk, Sirsa, Haryana 125055', '98135-01421 / 98219-14139', 'Closes 10:00 PM')`,
    `ALTER TABLE restaurant_settings ADD COLUMN logo_url TEXT DEFAULT ''`,
    `ALTER TABLE restaurant_settings ADD COLUMN announcement TEXT DEFAULT ''`,
    `ALTER TABLE menu_items ADD COLUMN original_price_paise INTEGER DEFAULT 0`,
    `ALTER TABLE menu_items ADD COLUMN custom_badge TEXT DEFAULT ''`,
    `ALTER TABLE authorized_admins ADD COLUMN password_note TEXT DEFAULT ''`
  ];

  for (const query of setupQueries) {
    try {
      await db.prepare(query).run();
    } catch (e) {
      // Gracefully ignore columns that already exist
    }
  }
  
  dbInitialized = true;
}

function base64UrlToUint8Array(str) {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function verifyFirebaseToken(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  if (!authHeader.startsWith('Bearer ')) return { ok: false, error: 'Missing authentication token.' };

  const parts = authHeader.slice(7).trim().split('.');
  if (parts.length !== 3) return { ok: false, error: 'Invalid token format.' };

  try {
    const header = JSON.parse(new TextDecoder().decode(base64UrlToUint8Array(parts[0])));
    const payload = JSON.parse(new TextDecoder().decode(base64UrlToUint8Array(parts[1])));
    const signature = base64UrlToUint8Array(parts[2]);
    const pid = (env.FIREBASE_PROJECT_ID || DEFAULT_FIREBASE_PROJECT_ID).trim();

    if (payload.exp <= Math.floor(Date.now() / 1000)) return { ok: false, error: 'Session expired. Please sign in again.' };
    if (pid && payload.aud !== pid) return { ok: false, error: 'Firebase project ID mismatch.' };

    const jwksRes = await fetch('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com');
    const { keys } = await jwksRes.json();
    const jwk = (keys || []).find((k) => k.kid === header.kid);
    if (!jwk) return { ok: false, error: 'Signing key not found.' };

    const cryptoKey = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const isValid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', cryptoKey, signature, new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    if (!isValid) return { ok: false, error: 'Invalid token signature.' };

    const email = (payload.email || '').toLowerCase();
    const countRow = await env.DB.prepare(`SELECT COUNT(*) AS c FROM authorized_admins`).first();
    if (!countRow || countRow.c === 0) {
      await env.DB.prepare(`INSERT INTO authorized_admins (email, added_at) VALUES (?, datetime('now'))`).bind(email).run();
    } else {
      const check = await env.DB.prepare(`SELECT email FROM authorized_admins WHERE email = ?`).bind(email).first();
      if (!check) return { ok: false, error: `Email (${email}) is not authorized for dashboard access.` };
    }
    return { ok: true, email };
  } catch (err) {
    return { ok: false, error: 'Token verification failed.' };
  }
}

async function cleanupOrphanedR2Image(env, imageKey) {
  if (!imageKey || !SAFE_KEY_REGEX.test(imageKey)) return;
  try {
    const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM menu_items WHERE image_key = ?`).bind(imageKey).first();
    if (!row || row.count === 0) await env.MEDIA_BUCKET.delete(imageKey);
  } catch {}
}

// 2. Global Error Catcher
// If ANYTHING fails, it will now return the exact error reason instead of a blank 500 error
export async function onRequest(context) {
  try {
    const { request, env } = context;
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();

    // Check if bindings exist
    if (!env.DB) throw new Error("Cloudflare D1 Database binding is missing. Please check Settings -> Bindings.");
    if (!env.MEDIA_BUCKET) throw new Error("Cloudflare R2 Bucket binding is missing. Please check Settings -> Bindings.");

    if (path.startsWith('/media/')) {
      const key = path.slice('/media/'.length).trim();
      if (!SAFE_KEY_REGEX.test(key) || key.includes('..') || key.includes('/')) {
        return new Response('Invalid media key', { status: 400 });
      }
      const object = await env.MEDIA_BUCKET.get(key, { onlyIf: request.headers });
      if (!object) return new Response('Not Found', { status: 404 });
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set('ETag', object.httpEtag);
      headers.set('Cache-Control', 'public, max-age=31536000, immutable');
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
        let services = ['Dine-in', 'Drive-through', 'Delivery'];
        let additional = {};
        try { services = JSON.parse(raw.services || '[]'); } catch {}
        try { additional = JSON.parse(raw.additional_settings || '{}'); } catch {}

        return json({
          settings: {
            restaurant_name: raw.restaurant_name || 'Anna South Indian Dosa',
            address: raw.address || '',
            phone: raw.phone || '',
            opening_hours: raw.opening_hours || '',
            announcement: raw.announcement || '',
            logo_url: raw.logo_url || '',
            services,
            additional_settings: additional
          },
          categories: cRes.results || [],
          items: iRes.results || []
        });
      }

      const auth = await verifyFirebaseToken(request, env);
      if (!auth.ok) return json({ error: auth.error }, 401);

      if (path === '/api/admin-data' && method === 'GET') {
        const [cRes, iRes, sRes, aRes] = await env.DB.batch([
          env.DB.prepare(`SELECT c.*, COUNT(m.id) AS item_count FROM categories c LEFT JOIN menu_items m ON m.category_id = c.id GROUP BY c.id ORDER BY c.display_order ASC, c.id ASC`),
          env.DB.prepare(`SELECT m.*, c.name AS category_name FROM menu_items m LEFT JOIN categories c ON c.id = m.category_id ORDER BY c.display_order ASC, m.display_order ASC, m.id DESC`),
          env.DB.prepare(`SELECT * FROM restaurant_settings WHERE id = 1`),
          env.DB.prepare(`SELECT email, password_note, added_at FROM authorized_admins ORDER BY added_at ASC`)
        ]);
        const raw = sRes.results[0] || {};
        let services = ['Dine-in', 'Drive-through', 'Delivery'];
        let additional = {};
        try { services = JSON.parse(raw.services || '[]'); } catch {}
        try { additional = JSON.parse(raw.additional_settings || '{}'); } catch {}

        return json({
          categories: cRes.results || [],
          items: iRes.results || [],
          settings: { ...raw, services, additional_settings: additional },
          admins: aRes.results || []
        });
      }

      if (path === '/api/admins') {
        if (method === 'POST') {
          const b = await request.json();
          const email = String(b.email || '').trim().toLowerCase();
          const passNote = String(b.password_note || '');
          if (!email) return json({ error: 'Email is required.' }, 400);
          await env.DB.prepare(`
            INSERT INTO authorized_admins (email, password_note, added_at)
            VALUES (?, ?, datetime('now'))
            ON CONFLICT(email) DO UPDATE SET password_note = excluded.password_note
          `).bind(email, passNote).run();
          return json({ ok: true });
        }
        if (method === 'DELETE') {
          const target = String(url.searchParams.get('email') || '').toLowerCase();
          if (target === auth.email) return json({ error: 'You cannot revoke your own active account.' }, 400);
          await env.DB.prepare(`DELETE FROM authorized_admins WHERE email = ?`).bind(target).run();
          return json({ ok: true });
        }
      }

      if (path === '/api/upload' && method === 'POST') {
        const formData = await request.formData();
        const file = formData.get('image');
        if (!file) return json({ error: 'No image file received.' }, 400);
        const buffer = await file.arrayBuffer();
        const rand = Array.from(crypto.getRandomValues(new Uint8Array(6))).map((b) => b.toString(16).padStart(2, '0')).join('');
        const imageKey = `media-${Date.now()}-${rand}.webp`;
        await env.MEDIA_BUCKET.put(imageKey, buffer, {
          httpMetadata: { contentType: 'image/webp', cacheControl: 'public, max-age=31536000, immutable' }
        });
        return json({ ok: true, image_key: imageKey, image_url: `/media/${imageKey}` }, 201);
      }

      if (path === '/api/items') {
        if (method === 'POST' || method === 'PUT') {
          const b = await request.json();
          const id = Number(b.id || 0);
          const imageKey = String(b.image_key || '').trim();
          const imageUrl = imageKey ? `/media/${imageKey}` : '';

          if (method === 'POST') {
            await env.DB.prepare(`
              INSERT INTO menu_items (name, description, price_paise, original_price_paise, custom_badge, category_id, image_key, image_url, is_vegetarian, is_available, is_featured)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).bind(
              b.name, b.description || '', Number(b.price_paise || 0), Number(b.original_price_paise || 0),
              b.custom_badge || '', Number(b.category_id), imageKey, imageUrl,
              b.is_vegetarian ? 1 : 0, b.is_available ? 1 : 0, b.is_featured ? 1 : 0
            ).run();
          } else {
            const old = await env.DB.prepare(`SELECT image_key FROM menu_items WHERE id = ?`).bind(id).first();
            await env.DB.prepare(`
              UPDATE menu_items
              SET name=?, description=?, price_paise=?, original_price_paise=?, custom_badge=?, category_id=?, image_key=?, image_url=?, is_vegetarian=?, is_available=?, is_featured=?
              WHERE id=?
            `).bind(
              b.name, b.description || '', Number(b.price_paise || 0), Number(b.original_price_paise || 0),
              b.custom_badge || '', Number(b.category_id), imageKey, imageUrl,
              b.is_vegetarian ? 1 : 0, b.is_available ? 1 : 0, b.is_featured ? 1 : 0, id
            ).run();
            if (old?.image_key && old.image_key !== imageKey) await cleanupOrphanedR2Image(env, old.image_key);
          }
          return json({ ok: true });
        }
        if (method === 'PATCH') {
          const b = await request.json();
          await env.DB.prepare(`UPDATE menu_items SET is_available = ? WHERE id = ?`).bind(b.is_available ? 1 : 0, Number(b.id)).run();
          return json({ ok: true });
        }
        if (method === 'DELETE') {
          const id = Number(url.searchParams.get('id'));
          const existing = await env.DB.prepare(`SELECT image_key FROM menu_items WHERE id = ?`).bind(id).first();
          await env.DB.prepare(`DELETE FROM menu_items WHERE id = ?`).bind(id).run();
          if (existing?.image_key) await cleanupOrphanedR2Image(env, existing.image_key);
          return json({ ok: true });
        }
      }

      if (path === '/api/categories') {
        if (method === 'POST') {
          const b = await request.json();
          const max = await env.DB.prepare(`SELECT COALESCE(MAX(display_order), 0) AS m FROM categories`).first();
          await env.DB.prepare(`INSERT INTO categories (name, description, display_order, is_active) VALUES (?, ?, ?, ?)`)
            .bind(b.name, b.description || '', (max?.m || 0) + 1, b.is_active ? 1 : 0).run();
          return json({ ok: true });
        }
        if (method === 'PUT') {
          const b = await request.json();
          await env.DB.prepare(`UPDATE categories SET name = ?, description = ?, is_active = ? WHERE id = ?`)
            .bind(b.name, b.description || '', b.is_active ? 1 : 0, Number(b.id)).run();
          return json({ ok: true });
        }
        if (method === 'DELETE') {
          const id = Number(url.searchParams.get('id'));
          const used = await env.DB.prepare(`SELECT COUNT(*) AS c FROM menu_items WHERE category_id = ?`).bind(id).first();
          if (used && used.c > 0) return json({ error: `Cannot delete category with ${used.c} dishes inside it.` }, 400);
          await env.DB.prepare(`DELETE FROM categories WHERE id = ?`).bind(id).run();
          return json({ ok: true });
        }
      }

      if (path === '/api/settings' && method === 'PUT') {
        const b = await request.json();
        await env.DB.prepare(`
          INSERT INTO restaurant_settings (
            id, restaurant_name, address, phone, opening_hours, announcement, logo_url, services, additional_settings
          ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            restaurant_name = excluded.restaurant_name,
            address = excluded.address,
            phone = excluded.phone,
            opening_hours = excluded.opening_hours,
            announcement = excluded.announcement,
            logo_url = excluded.logo_url,
            services = excluded.services,
            additional_settings = excluded.additional_settings
        `).bind(
          b.restaurant_name || 'Anna South Indian Dosa',
          b.address || '',
          b.phone || '',
          b.opening_hours || '',
          b.announcement || '',
          b.logo_url || '',
          JSON.stringify(Array.isArray(b.services) ? b.services : ['Dine-in', 'Drive-through', 'Delivery']),
          JSON.stringify(b.additional_settings || {})
        ).run();
        return json({ ok: true });
      }

      return json({ error: 'API route not found' }, 404);
    }

    return context.next();
  } catch (error) {
    // If the database crashes, this will catch it and print the exact reason to your browser!
    return new Response(JSON.stringify({ error: error.message, stack: error.stack }), { 
      status: 500, 
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
