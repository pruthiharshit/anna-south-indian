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
