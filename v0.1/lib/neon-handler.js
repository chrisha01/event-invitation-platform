'use strict';

/*
 * The local application deliberately uses a synchronous SQLite store.  Netlify
 * Functions cannot use that store: the function filesystem is ephemeral and
 * node:sqlite is not available on all Netlify runtimes.  This module is the
 * hosted API implementation.  It keeps the same request/response shapes as
 * the local vertical slice, while using the injected Neon tagged SQL client
 * for every read and write.
 */
const crypto = require('node:crypto');
const {
  validateVenueItems, validateFloorPlanMetadata, validateSeatingTables,
  validateSeatingConstraints, generateSeatingDraft
} = require('./seating');

const COOKIE = 'gatherly_session';
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RESERVED_EMAIL_DOMAIN_RE = /^(?:[a-z0-9-]+\.)*(?:test|example|invalid|localhost)$/i;

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();

function passwordHash(password) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}

function passwordMatches(password, encoded) {
  const match = /^scrypt\$([a-f0-9]{32})\$([a-f0-9]{128})$/i.exec(String(encoded));
  if (!match) return false;
  const expected = Buffer.from(match[2], 'hex');
  const supplied = crypto.scryptSync(password, Buffer.from(match[1], 'hex'), expected.length);
  return crypto.timingSafeEqual(supplied, expected);
}

function error(message, status = 400, code) {
  return Object.assign(new Error(message), { status, code });
}

function parseCookies(value = '') {
  return Object.fromEntries(value.split(';').map((part) => {
    const index = part.indexOf('=');
    return index > 0 ? [part.slice(0, index).trim(), part.slice(index + 1).trim()] : [];
  }).filter((entry) => entry.length));
}

function body(event) {
  if (!event.body) return {};
  try {
    const source = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    const parsed = JSON.parse(source);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error();
    return parsed;
  } catch {
    throw error('Request body must be a JSON object.');
  }
}

function response(statusCode, data, headers = {}) {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers
    },
    body: JSON.stringify(data)
  };
}

function validEmail(value) {
  return typeof value === 'string' && value.length <= 254 &&
    EMAIL_RE.test(value) && RESERVED_EMAIL_DOMAIN_RE.test(value.slice(value.lastIndexOf('@') + 1));
}

function eventView(row) {
  if (!row) return null;
  const jsonValue = (value, fallback) => {
    if (value && typeof value === 'string') {
      try { return JSON.parse(value); } catch { return fallback; }
    }
    return value || fallback;
  };
  return {
    id: Number(row.id), title: row.title, eventDate: String(row.event_date).slice(0, 10),
    eventStartTime: row.event_start_time || null, eventEndTime: row.event_end_time || null,
    timezone: row.event_timezone || null, location: row.location, guestMode: row.guest_mode,
    rsvpDeadline: row.rsvp_deadline || null, responsesOpen: Boolean(row.responses_open),
    invitedUnits: Number(row.invited_units || 0), revokedUnits: Number(row.revoked_units || 0),
    yesUnits: Number(row.yes_units || 0), noUnits: Number(row.no_units || 0),
    maybeUnits: Number(row.maybe_units || 0), attendingPeople: Number(row.attending_people || 0),
    capacity: row.capacity === null ? null : Number(row.capacity),
    remainingCapacity: row.capacity === null ? null :
      Math.max(0, Number(row.capacity) - Number(row.attending_people || 0)),
    published: Boolean(row.published), status: row.status || 'active',
    statusNote: row.status_note || null,
    replacement: row.replacement_event_date ? {
      eventDate: String(row.replacement_event_date).slice(0, 10),
      startTime: row.replacement_event_start_time || null,
      endTime: row.replacement_event_end_time || null,
      timezone: row.replacement_event_timezone || null
    } : null,
    theme: jsonValue(row.theme_json, {}), invitationSettings: jsonValue(row.invitation_settings_json, {}),
    invitationCopy: jsonValue(row.invitation_copy_json, {})
  };
}

function guestView(row) {
  if (!row) return null;
  return {
    id: Number(row.id), eventId: Number(row.event_id), name: row.name, email: row.email,
    groupName: row.group_name || null, partyLimit: Number(row.party_limit),
    revokedAt: row.revoked_at || null, walkIn: Boolean(row.walk_in),
    answer: row.answer || null, partySize: row.party_size === null ? null : Number(row.party_size),
    updatedAt: row.updated_at || null, inviteUrl: row.invite_url || null,
    attendees: row.attendees || []
  };
}

async function createHandler({ sql, env = process.env }) {
  if (typeof sql !== 'function') throw new TypeError('createHandler requires a Neon SQL function.');

  const query = (strings, ...values) => sql(strings, ...values);
  const sessionHash = (token) => env.SESSION_SECRET
    ? crypto.createHmac('sha256', env.SESSION_SECRET).update(token).digest('hex')
    : sha256(token);
  async function host(event) {
    const token = parseCookies(event.headers?.cookie || event.headers?.Cookie || '')[COOKIE];
    if (!token) return null;
    const rows = await query`SELECT h.id, h.email FROM hosts h
      JOIN sessions s ON s.host_id = h.id
      WHERE s.token_hash = ${sessionHash(token)} AND s.expires_at > ${now()}`;
    return rows[0] || null;
  }

  // Keep the projection in one helper so the local contract and hosted
  // contract return the same event fields.
  async function eventRows(hostId, eventId = null) {
    if (eventId === null) return query`SELECT e.id,e.host_id,e.title,e.event_date,e.event_start_time,
      e.event_end_time,e.event_timezone,e.location,e.guest_mode,e.rsvp_deadline,e.responses_open,
      e.published,e.status,e.status_note,e.capacity,e.replacement_event_date,e.replacement_event_start_time,
      e.replacement_event_end_time,e.replacement_event_timezone,e.theme_json,e.invitation_settings_json,
      e.invitation_copy_json,COUNT(g.id) FILTER (WHERE g.revoked_at IS NULL) invited_units,
      COUNT(g.id) FILTER (WHERE g.revoked_at IS NOT NULL) revoked_units,
      COUNT(g.id) FILTER (WHERE g.revoked_at IS NULL AND r.answer='yes') yes_units,
      COUNT(g.id) FILTER (WHERE g.revoked_at IS NULL AND r.answer='no') no_units,
      COUNT(g.id) FILTER (WHERE g.revoked_at IS NULL AND r.answer='maybe') maybe_units,
      COALESCE(SUM(r.party_size) FILTER (WHERE g.revoked_at IS NULL AND r.answer='yes'),0) attending_people
      FROM events e LEFT JOIN guest_units g ON g.event_id=e.id LEFT JOIN rsvps r ON r.guest_unit_id=g.id
      WHERE e.host_id=${hostId} GROUP BY e.id ORDER BY e.id`;
    return query`SELECT e.id,e.host_id,e.title,e.event_date,e.event_start_time,e.event_end_time,
      e.event_timezone,e.location,e.guest_mode,e.rsvp_deadline,e.responses_open,e.published,e.status,
      e.status_note,e.capacity,e.replacement_event_date,e.replacement_event_start_time,e.replacement_event_end_time,
      e.replacement_event_timezone,e.theme_json,e.invitation_settings_json,e.invitation_copy_json,
      COUNT(g.id) FILTER (WHERE g.revoked_at IS NULL) invited_units,
      COUNT(g.id) FILTER (WHERE g.revoked_at IS NOT NULL) revoked_units,
      COUNT(g.id) FILTER (WHERE g.revoked_at IS NULL AND r.answer='yes') yes_units,
      COUNT(g.id) FILTER (WHERE g.revoked_at IS NULL AND r.answer='no') no_units,
      COUNT(g.id) FILTER (WHERE g.revoked_at IS NULL AND r.answer='maybe') maybe_units,
      COALESCE(SUM(r.party_size) FILTER (WHERE g.revoked_at IS NULL AND r.answer='yes'),0) attending_people
      FROM events e LEFT JOIN guest_units g ON g.event_id=e.id LEFT JOIN rsvps r ON r.guest_unit_id=g.id
      WHERE e.host_id=${hostId} AND e.id=${eventId} GROUP BY e.id`;
  }

  async function guestsFor(eventId, hostId) {
    const rows = await query`SELECT g.id,g.event_id,g.name,g.email,g.party_limit,g.revoked_at,g.walk_in,
      r.answer,r.party_size,r.updated_at,
      COALESCE(jsonb_agg(jsonb_build_object('id',a.id,'name',a.name)
        ORDER BY a.id) FILTER (WHERE a.id IS NOT NULL),'[]'::jsonb) attendees
      FROM guest_units g JOIN events e ON e.id=g.event_id LEFT JOIN rsvps r ON r.guest_unit_id=g.id
      LEFT JOIN rsvp_attendees a ON a.guest_unit_id=g.id
      WHERE g.event_id=${eventId} AND e.host_id=${hostId}
      GROUP BY g.id,r.id ORDER BY g.id`;
    const checked = await query`SELECT guest_unit_id,attendee_id,checked_in_at FROM check_ins
      WHERE event_id=${eventId} AND reversed_at IS NULL`;
    const unitTimes = new Map(checked.filter((c) => c.guest_unit_id).map((c) => [Number(c.guest_unit_id), c.checked_in_at]));
    const attendeeTimes = new Map(checked.filter((c) => c.attendee_id).map((c) => [Number(c.attendee_id), c.checked_in_at]));
    return rows.map((row) => {
      const guest = guestView(row);
      guest.checkedInAt = unitTimes.get(guest.id) || null;
      guest.attendees = guest.attendees.map((attendee) => ({
        ...attendee, checkedInAt: attendeeTimes.get(Number(attendee.id)) || null
      }));
      return guest;
    });
  }

  const jsonValue = (value, fallback) => {
    if (value && typeof value === 'string') {
      try { return JSON.parse(value); } catch { return fallback; }
    }
    return value ?? fallback;
  };
  async function seatingAttendees(eventId, hostId) {
    const rows = await query`SELECT a.id,a.guest_unit_id,a.name,a.dietary,a.accessibility,
      a.age_band,g.name AS group_name FROM rsvp_attendees a
      JOIN guest_units g ON g.id=a.guest_unit_id JOIN events e ON e.id=g.event_id
      JOIN rsvps r ON r.guest_unit_id=g.id
      WHERE g.event_id=${eventId} AND e.host_id=${hostId} AND r.answer='yes'
        AND g.revoked_at IS NULL AND a.name <> '' ORDER BY a.id`;
    return rows.map((row) => ({ id: Number(row.id), guestUnitId: Number(row.guest_unit_id),
      name: row.name, dietary: row.dietary || '', accessibility: row.accessibility || '',
      ageBand: row.age_band || 'adult', groupName: row.group_name || null }));
  }
  async function planView(planId, eventId, hostId) {
    const rows = await query`SELECT p.id,p.event_id,p.name,p.status,p.algorithm_version,p.seed,
      p.input_hash,p.score,p.payload_json,p.venue_items_json,p.floor_plan_json,p.created_at,
      p.updated_at,p.published_at FROM seating_plans p JOIN events e ON e.id=p.event_id
      WHERE p.id=${planId} AND p.event_id=${eventId} AND e.host_id=${hostId}`;
    if (!rows[0]) return null;
    const tables = await query`SELECT id,name,capacity,shape,position_x,position_y,sort_order
      FROM seating_tables WHERE plan_id=${planId} ORDER BY sort_order,id`;
    const assignments = await query`SELECT attendee_id,table_id FROM seating_assignments
      WHERE plan_id=${planId} ORDER BY attendee_id`;
    const constraints = await query`SELECT relationship_type,relationship,priority,attendee_ids_json
      FROM seating_constraints WHERE plan_id=${planId} ORDER BY id`;
    const row = rows[0], payload = jsonValue(row.payload_json, {});
    return { id: Number(row.id), eventId: Number(row.event_id), name: row.name, status: row.status,
      algorithmVersion: row.algorithm_version, seed: Number(row.seed), inputHash: row.input_hash,
      score: Number(row.score), createdAt: row.created_at, updatedAt: row.updated_at,
      publishedAt: row.published_at, tables: tables.map((t) => ({ id: Number(t.id), name: t.name,
        capacity: Number(t.capacity), shape: t.shape, positionX: Number(t.position_x),
        positionY: Number(t.position_y), sortOrder: Number(t.sort_order) })),
      assignments: assignments.map((a) => ({ attendeeId: Number(a.attendee_id), tableId: Number(a.table_id) })),
      venueItems: jsonValue(row.venue_items_json, []), floorPlan: jsonValue(row.floor_plan_json, {}),
      payload, ...payload, constraints: constraints.length ? constraints.map((c) => ({
        relationship: c.relationship || '', relationshipType: c.relationship_type,
        type: c.relationship_type === 'keep-together' ? 'together' : 'apart',
        priority: c.priority, attendeeIds: jsonValue(c.attendee_ids_json, []).map(Number)
      })) : (Array.isArray(payload.constraints) ? payload.constraints : []) };
  }
  async function seatingPlans(eventId, hostId) {
    const rows = await query`SELECT p.id,p.name,p.status,p.algorithm_version,p.seed,p.input_hash,
      p.score,p.created_at,p.updated_at,p.published_at FROM seating_plans p JOIN events e ON e.id=p.event_id
      WHERE p.event_id=${eventId} AND e.host_id=${hostId} ORDER BY p.updated_at DESC,p.id DESC`;
    return rows.map((p) => ({ id: Number(p.id), name: p.name, status: p.status,
      algorithmVersion: p.algorithm_version, seed: Number(p.seed), inputHash: p.input_hash,
      score: Number(p.score), createdAt: p.created_at, updatedAt: p.updated_at, publishedAt: p.published_at }));
  }

  async function dispatch(event) {
    const rawPath = event.path || event.rawUrl || '/';
    const path = rawPath.replace(/^https?:\/\/[^/]+/, '')
      .replace(/^\/\.netlify\/functions\/api/, '') || '/';
    const method = (event.httpMethod || 'GET').toUpperCase();
    const input = body(event);

    if (method === 'GET' && path === '/api/status') {
      const current = await host(event);
      const count = await query`SELECT COUNT(*)::int AS count FROM hosts`;
      return response(200, { setupRequired: Number(count[0]?.count || 0) === 0,
        host: current ? { email: current.email } : null });
    }
    if (path === '/api/auth/register' && method === 'POST') {
      if (!validEmail(input.email) || typeof input.password !== 'string' || input.password.length < 12) {
        throw error('Use a reserved-domain email and a password of at least 12 characters.');
      }
      const email = input.email.trim().toLowerCase();
      const existing = await query`SELECT id FROM hosts WHERE email=${email}`;
      if (existing.length) throw error('An account with that email already exists.', 409);
      const count = await query`SELECT COUNT(*)::int AS count FROM hosts`;
      if (Number(count[0].count) > 0) throw error('A host account is already configured.', 409);
      const created = await query`INSERT INTO hosts(email,password_hash,created_at)
        VALUES(${email},${passwordHash(input.password)},${now()}) RETURNING id,email`;
      return loginResponse(created[0], query);
    }
    if (path === '/api/auth/login' && method === 'POST') {
      const rows = await query`SELECT id,email,password_hash FROM hosts WHERE email=${String(input.email || '').trim().toLowerCase()}`;
      if (!rows[0] || !passwordMatches(input.password, rows[0].password_hash)) {
        throw error('Email or password is incorrect.', 401);
      }
      return loginResponse(rows[0], query);
    }
    if (path === '/api/auth/logout' && method === 'POST') {
      const token = parseCookies(event.headers?.cookie || event.headers?.Cookie || '')[COOKIE];
      if (token) await query`DELETE FROM sessions WHERE token_hash=${sessionHash(token)}`;
      return response(200, { ok: true }, { 'set-cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` });
    }
    if (path === '/api/auth/me' && method === 'GET') {
      const current = await host(event);
      if (!current) throw error('Sign in as the host to continue.', 401);
      return response(200, { host: { email: current.email } });
    }

    const current = await host(event);
    if (!current) throw error('Sign in as the host to continue.', 401);
    if (path === '/api/events' && method === 'GET') {
      return response(200, { events: (await eventRows(current.id)).map(eventView) });
    }
    if (path === '/api/events' && method === 'POST') {
      const title = typeof input.title === 'string' ? input.title.trim() : '';
      if (!title || title.length > 100 || !/^\d{4}-\d{2}-\d{2}$/.test(input.eventDate) ||
          !['individual', 'household'].includes(input.guestMode)) throw error('Event details are invalid.');
      const inserted = await query`INSERT INTO events(host_id,title,event_date,event_start_time,event_end_time,
        event_timezone,location,guest_mode,rsvp_deadline,capacity,created_at,theme_json,
        invitation_settings_json,invitation_copy_json)
        VALUES(${current.id},${title},${input.eventDate},${input.eventStartTime || null},${input.eventEndTime || null},
        ${input.timezone || null},${String(input.location || '')},${input.guestMode},${input.rsvpDeadline || null},
        ${input.capacity === null || input.capacity === undefined ? null : Number(input.capacity)},${now()},
        ${input.theme || {}},${input.invitationSettings || {}},${input.invitationCopy || {}})
        RETURNING id`;
      const rows = await eventRows(current.id, inserted[0].id);
      return response(201, { event: eventView(rows[0]) });
    }
    if (path === '/api/outbox' && method === 'GET') {
      const messages = await query`SELECT m.id,m.recipient,m.subject,m.body,m.created_at
        FROM email_outbox m JOIN guest_units g ON g.id=m.guest_unit_id
        JOIN events e ON e.id=g.event_id WHERE e.host_id=${current.id} ORDER BY m.id`;
      return response(200, { messages });
    }
    const match = path.match(/^\/api\/events\/(\d+)(?:\/(dashboard|publish|responses|guests|guests\/bulk|theme|invitation|invitation-copy|export|status|messages|seating|seating\/seed|seating\/plans(?:\/\d+(?:\/(?:run|assignments|positions|venue-items|constraints|publish))?)?|check-in|check-in\/reverse|check-in\/walk-in))?$/);
    if (match) {
      const eventId = Number(match[1]);
      const rows = await eventRows(current.id, eventId);
      if (!rows[0]) throw error('Event not found.', 404);
      if (!match[2] && method === 'GET') {
        return response(200, { event: eventView(rows[0]), guests: await guestsFor(eventId, current.id) });
      }
      if (!match[2] && method === 'PUT') {
        const title = typeof input.title === 'string' ? input.title.trim() : rows[0].title;
        const location = typeof input.location === 'string' ? input.location.trim() : rows[0].location;
        if (!title || title.length > 100) throw error('Event details are invalid.');
        await query`UPDATE events SET title=${title}, location=${location},
          event_date=${input.eventDate || rows[0].event_date},
          event_start_time=${input.eventStartTime ?? rows[0].event_start_time},
          event_end_time=${input.eventEndTime ?? rows[0].event_end_time},
          event_timezone=${input.timezone ?? rows[0].event_timezone},
          rsvp_deadline=${input.rsvpDeadline ?? rows[0].rsvp_deadline},
          capacity=${input.capacity === undefined ? rows[0].capacity : input.capacity}
          WHERE id=${eventId} AND host_id=${current.id}`;
        return response(200, { event: eventView((await eventRows(current.id, eventId))[0]) });
      }
      if (match[2] === 'dashboard' && method === 'GET') {
        const guests = await guestsFor(eventId, current.id);
        const checkIns = await query`SELECT guest_unit_id,attendee_id,checked_in_at FROM check_ins
          WHERE event_id=${eventId} AND reversed_at IS NULL`;
        const seating = await seatingPlans(eventId, current.id);
        return response(200, { event: eventView(rows[0]), guests,
          totals: guests.reduce((t, g) => {
            t.invitedPeople += g.walkIn ? 0 : g.partyLimit;
            t.confirmedPeople += g.answer === 'yes' ? Number(g.partySize || 0) : 0;
            t.walkIns += g.walkIn ? 1 : 0;
            t.walkInPeople += g.walkIn && g.answer === 'yes' ? Number(g.partySize || 0) : 0;
            return t;
          }, { invitedPeople: 0, confirmedPeople: 0, checkedInPeople: checkIns.length,
            walkIns: 0, walkInPeople: 0 }), seating: seating[0] || null,
          seatingPublished: seating.some((plan) => plan.status === 'published') });
      }
      if (match[2] === 'publish' && method === 'POST') {
        await query`UPDATE events SET published=TRUE WHERE id=${eventId} AND host_id=${current.id}`;
        return response(200, { event: eventView((await eventRows(current.id, eventId))[0]) });
      }
      if (match[2] === 'responses' && method === 'POST') {
        if (typeof input.open !== 'boolean') throw error('Set open to true or false.');
        await query`UPDATE events SET responses_open=${input.open} WHERE id=${eventId} AND host_id=${current.id}`;
        return response(200, { ok: true, responsesOpen: input.open });
      }
      if (match[2] === 'status' && method === 'POST') {
        if (!['active', 'postponed', 'cancelled'].includes(input.status)) {
          throw error('Event status is invalid.');
        }
        const replacement = input.replacement || {};
        await query`UPDATE events SET status=${input.status}, status_note=${input.note || null},
          replacement_event_date=${input.status === 'postponed' ? replacement.eventDate || null : null},
          replacement_event_start_time=${input.status === 'postponed' ? replacement.startTime || null : null},
          replacement_event_end_time=${input.status === 'postponed' ? replacement.endTime || null : null},
          replacement_event_timezone=${input.status === 'postponed' ? replacement.timezone || null : null}
          WHERE id=${eventId} AND host_id=${current.id}`;
        return response(200, { event: eventView((await eventRows(current.id, eventId))[0]),
          updateMessage: input.status === 'postponed'
            ? `Hello,\n\n${rows[0].title} has been postponed. The new schedule is ${replacement.eventDate} at ${replacement.startTime} (${replacement.timezone}).\n\nLocal message preview only. No email was sent.`
            : null });
      }
      if (match[2] === 'theme' && method === 'PUT') {
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw error('Theme is invalid.');
        await query`UPDATE events SET theme_json=${input} WHERE id=${eventId} AND host_id=${current.id}`;
        return response(200, { theme: (await eventRows(current.id, eventId))[0].theme_json || {} });
      }
      if (match[2] === 'invitation' && method === 'PUT') {
        if (!['envelope', 'direct'].includes(input.revealMode) || typeof input.chimeEnabled !== 'boolean') {
          throw error('Invitation settings are invalid.');
        }
        await query`UPDATE events SET invitation_settings_json=${input}
          WHERE id=${eventId} AND host_id=${current.id}`;
        return response(200, { invitationSettings: input });
      }
      if (match[2] === 'invitation-copy' && method === 'PUT') {
        const copy = { ...input };
        for (const key of ['greeting', 'title', 'intro', 'rsvpHeading', 'rsvpHelper', 'footerNote']) {
          if (typeof copy[key] !== 'string' || copy[key].length > 10000) throw error('Invitation copy is invalid.');
        }
        await query`UPDATE events SET invitation_copy_json=${copy}
          WHERE id=${eventId} AND host_id=${current.id}`;
        return response(200, { invitationCopy: copy });
      }
      if (match[2] === 'guests' && method === 'POST') {
        const name = typeof input.name === 'string' ? input.name.trim() : '';
        const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
        const partyLimit = rows[0].guest_mode === 'individual' ? 1 : Number(input.partyLimit);
        if (!name || !validEmail(email) || !Number.isInteger(partyLimit) || partyLimit < 1 || partyLimit > 20) {
          throw error('Guest details are invalid.');
        }
        const token = crypto.randomBytes(32).toString('base64url');
        const inviteUrl = `/rsvp/${token}`;
        const inserted = await query`INSERT INTO guest_units(event_id,name,email,party_limit,token_hash,invite_url,created_at)
          VALUES(${eventId},${name},${email},${partyLimit},${sha256(token)},${inviteUrl},${now()}) RETURNING id`;
        await query`INSERT INTO email_outbox(guest_unit_id,recipient,subject,body,created_at)
          VALUES(${inserted[0].id},${email},${`Your invitation: ${rows[0].title}`},
          ${`Hello ${name}\n\nYou are invited to ${rows[0].title} on ${String(rows[0].event_date).slice(0,10)}.\nRSVP using your private local link: ${inviteUrl}\n\nLocal email capture only. No email was sent.`},${now()})`;
        return response(201, { guest: { id: Number(inserted[0].id), name, email, partyLimit }, inviteUrl });
      }
      if (match[2] === 'guests/bulk' && method === 'POST') {
        if (!Array.isArray(input.guests) || input.guests.length < 1 || input.guests.length > 100) {
          throw error('Provide between 1 and 100 guest rows.');
        }
        const normalized = [];
        const seenEmails = new Set();
        for (const row of input.guests) {
          const name = typeof row?.name === 'string' ? row.name.trim() : '';
          const email = typeof row?.email === 'string' ? row.email.trim().toLowerCase() : '';
          const partyLimit = rows[0].guest_mode === 'individual' ? 1 : Number(row?.partyLimit);
          if (!name || !validEmail(email) || !Number.isInteger(partyLimit) || partyLimit < 1 || partyLimit > 20) {
            throw error('Guest details are invalid.');
          }
          if (seenEmails.has(email)) throw error(`Duplicate email in guest list: ${email}.`);
          const existing = await query`SELECT id FROM guest_units WHERE event_id=${eventId} AND lower(email)=${email} AND revoked_at IS NULL`;
          if (existing.length) throw error('A guest unit with that email is already invited to this event.');
          seenEmails.add(email);
          normalized.push({ name, email, partyLimit });
        }
        const created = [];
        for (const row of normalized) {
          const { name, email, partyLimit } = row;
          const token = crypto.randomBytes(32).toString('base64url');
          const inviteUrl = `/rsvp/${token}`;
          const inserted = await query`INSERT INTO guest_units(event_id,name,email,party_limit,token_hash,invite_url,created_at)
            VALUES(${eventId},${name},${email},${partyLimit},${sha256(token)},${inviteUrl},${now()}) RETURNING id`;
          await query`INSERT INTO email_outbox(guest_unit_id,recipient,subject,body,created_at)
            VALUES(${inserted[0].id},${email},${`Your invitation: ${rows[0].title}`},
            ${`Hello ${name}\n\nYou are invited to ${rows[0].title} on ${String(rows[0].event_date).slice(0,10)}.\nRSVP using your private local link: ${inviteUrl}\n\nLocal email capture only. No email was sent.`},${now()})`;
          created.push({ id: Number(inserted[0].id), name, email, partyLimit, inviteUrl });
        }
        return response(201, { guests: created });
      }
      if (match[2] === 'export' && method === 'GET') {
        const guests = await guestsFor(eventId, current.id);
        const checkIns = await query`SELECT guest_unit_id,attendee_id,checked_in_at FROM check_ins
          WHERE event_id=${eventId} AND reversed_at IS NULL`;
        const unitTimes = new Map(checkIns.filter((c) => c.guest_unit_id).map((c) => [Number(c.guest_unit_id), c.checked_in_at]));
        const attendeeTimes = new Map(checkIns.filter((c) => c.attendee_id).map((c) => [Number(c.attendee_id), c.checked_in_at]));
        const csvCell = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
        const csv = [
          ['Guest unit name', 'Email', 'RSVP answer', 'Party size', 'Attendee names',
            'Dietary needs', 'Accessibility needs', 'Age bands', 'Revoked state', 'Update time',
            'Walk-in', 'Checked-in time', 'Attendee check-in times'].map(csvCell).join(','),
          ...guests.map((guest) => [guest.name, guest.email || '', guest.answer || '', guest.partySize ?? '',
            (guest.attendees || []).map((a) => a.name).join('; '),
            (guest.attendees || []).map((a) => a.dietary || '').filter(Boolean).join('; '),
            (guest.attendees || []).map((a) => a.accessibility || '').filter(Boolean).join('; '),
            (guest.attendees || []).map((a) => a.ageBand || 'adult').join('; '), guest.revokedAt ? 'yes' : 'no',
            guest.updatedAt || '', guest.walkIn ? 'yes' : 'no', unitTimes.get(guest.id) || '',
            (guest.attendees || []).map((a) => attendeeTimes.get(Number(a.id)) || '').join('; ')].map(csvCell).join(','))
        ].join('\r\n') + '\r\n';
        return { statusCode: 200, headers: {
          'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="gatherly-event-${eventId}-guests.csv"`, 'cache-control': 'no-store'
        }, body: csv };
      }
      if (match[2] === 'messages' && method === 'POST') {
        const subject = typeof input.subject === 'string' ? input.subject.trim() : '';
        const message = typeof input.body === 'string' ? input.body.trim() : '';
        if (!subject || !message || subject.length > 255 || message.length > 20000) {
          throw error('Message details are invalid.');
        }
        const guests = await guestsFor(eventId, current.id);
        const selected = input.filter === 'confirmed'
          ? guests.filter((guest) => guest.answer === 'yes')
          : input.filter === 'declined'
            ? guests.filter((guest) => guest.answer === 'no')
            : guests.filter((guest) => !guest.revokedAt);
        for (const guest of selected) {
          if (!guest.email) continue;
          await query`INSERT INTO local_messages(event_id,guest_unit_id,recipient,subject,body,created_at)
            VALUES(${eventId},${guest.id},${guest.email},${subject},${message},${now()})`;
        }
        return response(201, { sent: selected.filter((guest) => guest.email).length });
      }
      if (match[2] === 'seating' && method === 'GET') {
        return response(200, { attendees: await seatingAttendees(eventId, current.id),
          plans: await seatingPlans(eventId, current.id) });
      }
      if (match[2] === 'seating/seed' && method === 'POST') {
        const names = ['Alex Morgan', 'Jordan Lee', 'Taylor Smith', 'Riley Chen', 'Casey Rivera',
          'Avery Patel', 'Morgan Brooks', 'Jamie Nguyen', 'Cameron Davis', 'Quinn Wilson',
          'Harper Kim', 'Drew Martin', 'Emerson Clark', 'Rowan Garcia', 'Sage Thompson',
          'Parker Lewis', 'Reese Walker', 'Skyler Adams', 'Finley Moore', 'Blair Cooper'];
        const count = Number(input.count ?? 12);
        if (!Number.isSafeInteger(count) || count < 1 || count > names.length) {
          throw error(`Choose between 1 and ${names.length} synthetic attendees.`);
        }
        const existing = new Set((await seatingAttendees(eventId, current.id)).map((a) => a.name));
        const selected = names.filter((name) => !existing.has(name)).slice(0, count);
        if (selected.length < count) throw error('There are not enough unused synthetic names for this event.', 409);
        for (const [index, name] of selected.entries()) {
          const token = crypto.randomBytes(32).toString('base64url');
          const inserted = await query`INSERT INTO guest_units(event_id,name,email,party_limit,token_hash,invite_url,created_at)
            VALUES(${eventId},${name},${`synthetic-${Date.now()}-${index}@example.test`},1,${sha256(token)},
              ${`/rsvp/${token}`},${now()}) RETURNING id`;
          const guestId = inserted[0].id;
          await query`INSERT INTO rsvps(guest_unit_id,answer,party_size,updated_at) VALUES(${guestId},'yes',1,${now()})`;
          await query`INSERT INTO rsvp_attendees(guest_unit_id,name,dietary,accessibility,age_band,created_at)
            VALUES(${guestId},${name},'','', 'adult',${now()})`;
        }
        return response(201, { created: selected.length, names: selected });
      }
      const seatingMatch = match[2]?.match(/^seating\/plans(?:\/(\d+)(?:\/(run|assignments|positions|venue-items|constraints|publish))?)?$/);
      if (seatingMatch) {
        const planId = seatingMatch[1] ? Number(seatingMatch[1]) : null;
        const planAction = seatingMatch[2] || null;
        if (planId === null && method === 'POST') {
          const name = typeof input.name === 'string' ? input.name.trim() : 'Draft seating plan';
          if (!name || name.length > 100) throw error('Seating plan name must be 1–100 characters.');
          const tables = validateSeatingTables(input.tables);
          const constraints = validateSeatingConstraints(input.constraints);
          const venueItems = validateVenueItems(input.venueItems);
          const floorPlan = validateFloorPlanMetadata(input.floorPlan);
          const seed = Number.isSafeInteger(Number(input.seed)) ? Number(input.seed) : 1;
          const attendees = await seatingAttendees(eventId, current.id);
          const inputHash = sha256(JSON.stringify({ attendees, tables, constraints, seed }));
          const created = await query`INSERT INTO seating_plans(event_id,name,algorithm_version,seed,input_hash,
            payload_json,venue_items_json,floor_plan_json,created_at,updated_at)
            VALUES(${eventId},${name},'heuristic-1',${seed},${inputHash},
              ${JSON.stringify({ constraints, violations: [], unassigned: [] })},${JSON.stringify(venueItems)},
              ${JSON.stringify(floorPlan)},${now()},${now()}) RETURNING id`;
          const newPlanId = Number(created[0].id);
          for (const [index, table] of tables.entries()) {
            await query`INSERT INTO seating_tables(plan_id,name,capacity,shape,position_x,position_y,
              initial_position_x,initial_position_y,sort_order) VALUES(${newPlanId},${table.name},${table.capacity},
              ${table.shape},${table.positionX},${table.positionY},${table.positionX},${table.positionY},${index})`;
          }
          for (const constraint of constraints) {
            await query`INSERT INTO seating_constraints(plan_id,relationship_type,relationship,priority,
              attendee_ids_json,created_at,updated_at) VALUES(${newPlanId},${constraint.relationshipType},
              ${constraint.relationship},${constraint.priority},${JSON.stringify(constraint.attendeeIds)},${now()},${now()})`;
          }
          return response(201, { plan: await planView(newPlanId, eventId, current.id) });
        }
        if (planId === null) throw error('Seating plan not found.', 404);
        const plan = await planView(planId, eventId, current.id);
        if (!plan) throw error('Seating plan not found.', 404);
        if (!planAction && method === 'GET') return response(200, { plan });
        if (planAction === 'run' && method === 'POST') {
          const attendees = await seatingAttendees(eventId, current.id);
          const generated = generateSeatingDraft(attendees, plan.tables, plan.constraints || [], plan.seed);
          const result = input.reset === true ? { ...generated, assignments: [], score: 0,
            payload: { ...generated.payload, assignedCount: 0,
              unassigned: attendees.map((a) => ({ attendeeId: Number(a.id), name: a.name })) } } : generated;
          await query`DELETE FROM seating_assignments WHERE plan_id=${planId}`;
          for (const assignment of result.assignments) {
            await query`INSERT INTO seating_assignments(plan_id,attendee_id,table_id)
              VALUES(${planId},${assignment.attendeeId},${assignment.tableId})`;
          }
          await query`UPDATE seating_plans SET status='saved',score=${result.score},input_hash=${result.inputHash},
            payload_json=${JSON.stringify(result.payload)},updated_at=${now()} WHERE id=${planId} AND event_id=${eventId}`;
          return response(200, { plan: await planView(planId, eventId, current.id) });
        }
        if (planAction === 'positions' && method === 'PUT') {
          if (!Array.isArray(input.positions) || !input.positions.length) throw error('Positions must be an array.');
          const positions = input.positions.map((p) => ({ tableId: Number(p?.tableId), positionX: Number(p?.positionX), positionY: Number(p?.positionY) }));
          const ids = new Set(plan.tables.map((t) => t.id));
          if (positions.some((p) => !Number.isSafeInteger(p.tableId) || !ids.has(p.tableId) ||
            !Number.isFinite(p.positionX) || p.positionX < 3 || p.positionX > 97 ||
            !Number.isFinite(p.positionY) || p.positionY < 3 || p.positionY > 97) ||
            new Set(positions.map((p) => p.tableId)).size !== positions.length) {
            throw error('Table positions must stay within the seating map.');
          }
          for (const p of positions) await query`UPDATE seating_tables SET position_x=${p.positionX},
            position_y=${p.positionY} WHERE id=${p.tableId} AND plan_id=${planId}`;
          await query`UPDATE seating_plans SET updated_at=${now()} WHERE id=${planId}`;
          return response(200, { plan: await planView(planId, eventId, current.id) });
        }
        if (planAction === 'venue-items' && method === 'PUT') {
          const venueItems = validateVenueItems(input.venueItems);
          await query`UPDATE seating_plans SET venue_items_json=${JSON.stringify(venueItems)},updated_at=${now()}
            WHERE id=${planId} AND event_id=${eventId}`;
          return response(200, { plan: await planView(planId, eventId, current.id) });
        }
        if (planAction === 'constraints' && method === 'PUT') {
          const constraints = validateSeatingConstraints(input.constraints);
          const attendees = await seatingAttendees(eventId, current.id);
          const generated = generateSeatingDraft(attendees, plan.tables, constraints, plan.seed);
          await query`DELETE FROM seating_constraints WHERE plan_id=${planId}`;
          for (const constraint of constraints) await query`INSERT INTO seating_constraints(plan_id,relationship_type,
            relationship,priority,attendee_ids_json,created_at,updated_at) VALUES(${planId},${constraint.relationshipType},
            ${constraint.relationship},${constraint.priority},${JSON.stringify(constraint.attendeeIds)},${now()},${now()})`;
          await query`DELETE FROM seating_assignments WHERE plan_id=${planId}`;
          await query`UPDATE seating_plans SET status='draft',input_hash=${generated.inputHash},
            payload_json=${JSON.stringify({ ...plan.payload, constraints, violations: [] })},updated_at=${now()} WHERE id=${planId}`;
          return response(200, { plan: await planView(planId, eventId, current.id) });
        }
        if (planAction === 'assignments' && method === 'PUT') {
          if (!Array.isArray(input.assignments)) throw error('Assignments must be an array.');
          const attendees = await seatingAttendees(eventId, current.id);
          const attendeeIds = new Set(attendees.map((a) => a.id)), tableMap = new Map(plan.tables.map((t) => [t.id, t.capacity]));
          const seen = new Set(), counts = new Map();
          for (const item of input.assignments) {
            const attendeeId = Number(item?.attendeeId), tableId = Number(item?.tableId);
            if (!attendeeIds.has(attendeeId) || !tableMap.has(tableId) || seen.has(attendeeId)) throw error('Assignments must reference each attendee at most once.');
            seen.add(attendeeId); counts.set(tableId, (counts.get(tableId) || 0) + 1);
          }
          for (const [tableId, count] of counts) if (count > tableMap.get(tableId)) throw error('A table cannot hold more attendees than its capacity.');
          await query`DELETE FROM seating_assignments WHERE plan_id=${planId}`;
          for (const item of input.assignments) await query`INSERT INTO seating_assignments(plan_id,attendee_id,table_id)
            VALUES(${planId},${Number(item.attendeeId)},${Number(item.tableId)})`;
          await query`UPDATE seating_plans SET status='saved',updated_at=${now()} WHERE id=${planId}`;
          return response(200, { plan: await planView(planId, eventId, current.id) });
        }
        if (planAction === 'publish' && method === 'POST') {
          if (plan.status === 'stale') throw error('Refresh this stale seating plan before publishing.', 409);
          await query`UPDATE seating_plans SET status='published',published_at=${now()},updated_at=${now()}
            WHERE id=${planId} AND event_id=${eventId}`;
          return response(200, { plan: await planView(planId, eventId, current.id) });
        }
      }
      if (match[2] === 'check-in' && method === 'GET') {
        const checked = await query`SELECT id,guest_unit_id,attendee_id,checked_in_at
          FROM check_ins WHERE event_id=${eventId} AND reversed_at IS NULL ORDER BY id`;
        const guests = await guestsFor(eventId, current.id);
        const unitIds = new Set(checked.filter((c) => c.guest_unit_id).map((c) => Number(c.guest_unit_id)));
        const attendeeIds = new Set(checked.filter((c) => c.attendee_id).map((c) => Number(c.attendee_id)));
        guests.forEach((g) => {
          g.checkedIn = unitIds.has(g.id);
          (g.attendees || []).forEach((a) => { a.checkedIn = attendeeIds.has(Number(a.id)); });
        });
        return response(200, { checkIns: checked, guests,
          totals: { checkedInPeople: checked.length, checkedInUnits: unitIds.size,
            checkedInAttendees: attendeeIds.size } });
      }
      if (match[2] === 'check-in' && method === 'POST') {
        if (rows[0].status === 'cancelled') throw error('Cancelled events cannot record attendance changes.', 409);
        if ((!input.guestId && !input.attendeeId) || (input.guestId && input.attendeeId)) throw error('Guest or attendee is required.');
        const value = Number(input.guestId || input.attendeeId);
        const target = input.guestId
          ? await query`SELECT g.id FROM guest_units g WHERE g.id=${value} AND g.event_id=${eventId} AND g.revoked_at IS NULL`
          : await query`SELECT a.id FROM rsvp_attendees a JOIN guest_units g ON g.id=a.guest_unit_id
              WHERE a.id=${value} AND g.event_id=${eventId} AND g.revoked_at IS NULL`;
        if (!target[0]) throw error('Guest or attendee not found.', 404);
        const existing = input.guestId
          ? await query`SELECT id FROM check_ins WHERE event_id=${eventId} AND guest_unit_id=${value} AND reversed_at IS NULL`
          : await query`SELECT id FROM check_ins WHERE event_id=${eventId} AND attendee_id=${value} AND reversed_at IS NULL`;
        if (existing.length) throw error('Already checked in.', 409);
        if (input.attendeeId) {
          const household = await query`SELECT id FROM check_ins WHERE event_id=${eventId}
            AND guest_unit_id=(SELECT guest_unit_id FROM rsvp_attendees WHERE id=${value})
            AND reversed_at IS NULL`;
          if (household.length) throw error('Reverse the existing household check-in before checking in individuals.', 409);
        }
        if (input.guestId) {
          await query`INSERT INTO check_ins(event_id,guest_unit_id,checked_in_at) VALUES(${eventId},${value},${now()})`;
        } else {
          await query`INSERT INTO check_ins(event_id,attendee_id,checked_in_at) VALUES(${eventId},${value},${now()})`;
        }
        return response(200, { guests: await guestsFor(eventId, current.id),
          totals: { checkedInPeople: 1 } });
      }
      if (match[2] === 'check-in/reverse' && method === 'POST') {
        if (rows[0].status === 'cancelled') throw error('Cancelled events cannot record attendance changes.', 409);
        if ((!input.guestId && !input.attendeeId) || (input.guestId && input.attendeeId)) throw error('Guest or attendee is required.');
        const value = Number(input.guestId || input.attendeeId);
        const updated = input.guestId
          ? await query`UPDATE check_ins SET reversed_at=${now()}
            WHERE event_id=${eventId} AND guest_unit_id=${value} AND reversed_at IS NULL RETURNING id`
          : await query`UPDATE check_ins SET reversed_at=${now()}
            WHERE event_id=${eventId} AND attendee_id=${value} AND reversed_at IS NULL RETURNING id`;
        if (!updated.length) throw error('Active check-in not found.', 404);
        return response(200, { ok: true, guests: await guestsFor(eventId, current.id) });
      }
      if (match[2] === 'check-in/walk-in' && method === 'POST') {
        if (rows[0].status === 'cancelled') throw error('Cancelled events cannot record attendance changes.', 409);
        const name = typeof input.name === 'string' ? input.name.trim() : '';
        const attendeeName = typeof input.attendeeName === 'string' ? input.attendeeName.trim() : name;
        if (!name || name.length > 100 || !attendeeName || attendeeName.length > 100) throw error('Walk-in details are invalid.');
        const override = input.override === true, reason = typeof input.reason === 'string' ? input.reason.trim() : '';
        if (override && reason.length < 3) throw error('A capacity override needs a reason.');
        if (!override && reason) throw error('A walk-in reason requires an explicit capacity override.');
        if (rows[0].capacity !== null) {
          const currentPeople = Number(rows[0].attending_people || 0);
          const walkIns = await query`SELECT COUNT(*)::int AS count FROM check_ins c JOIN guest_units g ON g.id=c.guest_unit_id
            WHERE c.event_id=${eventId} AND c.reversed_at IS NULL AND g.walk_in=TRUE`;
          if (currentPeople + Number(walkIns[0]?.count || 0) >= Number(rows[0].capacity) && !override) {
            throw error(`Event capacity is ${rows[0].capacity}; no walk-in place remains. Confirm a host override with a reason to continue.`, 409);
          }
        }
        const email = `walkin-${Date.now()}-${crypto.randomBytes(4).toString('hex')}@example.test`;
        const token = crypto.randomBytes(32).toString('base64url');
        const created = await query`INSERT INTO guest_units(event_id,name,email,party_limit,token_hash,invite_url,walk_in,created_at)
          VALUES(${eventId},${name},${email},1,${sha256(token)},${`/rsvp/${token}`},TRUE,${now()}) RETURNING id`;
        const guestId = Number(created[0].id);
        const attendee = await query`INSERT INTO rsvp_attendees(guest_unit_id,name,dietary,accessibility,age_band,created_at)
          VALUES(${guestId},${attendeeName},'','', 'adult',${now()}) RETURNING id`;
        await query`INSERT INTO rsvps(guest_unit_id,answer,party_size,updated_at) VALUES(${guestId},'yes',1,${now()})`;
        await query`INSERT INTO check_ins(event_id,attendee_id,checked_in_at) VALUES(${eventId},${attendee[0].id},${now()})`;
        return response(201, { guestId, attendeeId: Number(attendee[0].id),
          totals: { checkedInPeople: 1, walkIns: 1, walkInPeople: 1 } });
      }
    }
    const inviteLinkMatch = path.match(/^\/api\/guests\/(\d+)\/invite-link$/);
    if (method === 'GET' && inviteLinkMatch) {
      const rows = await query`SELECT g.invite_url,g.revoked_at FROM guest_units g
        JOIN events e ON e.id=g.event_id WHERE g.id=${Number(inviteLinkMatch[1])} AND e.host_id=${current.id}`;
      if (!rows[0]) throw error('Guest not found.', 404);
      if (rows[0].revoked_at) throw error('Invite link has been revoked.', 410, 'INVITE_REVOKED');
      if (!rows[0].invite_url) throw error('Invite link is unavailable.', 404, 'INVITE_LINK_MISSING');
      return response(200, { inviteUrl: rows[0].invite_url });
    }
    const revokeMatch = path.match(/^\/api\/guests\/(\d+)\/revoke$/);
    if (method === 'POST' && revokeMatch) {
      const changed = await query`UPDATE guest_units g SET revoked_at=${now()}
        FROM events e WHERE g.event_id=e.id AND g.id=${Number(revokeMatch[1])}
        AND e.host_id=${current.id} AND g.revoked_at IS NULL RETURNING g.id`;
      if (!changed.length) throw error('Guest not found or already revoked.', 404);
      return response(200, { ok: true });
    }
    const guestMatch = path.match(/^\/api\/guest\/([^/]+)(?:\/rsvp)?$/);
    if (guestMatch) {
      const tokenHash = sha256(guestMatch[1]);
      const rows = await query`SELECT g.*,e.title,e.event_date,e.event_start_time,e.event_end_time,e.event_timezone,
        e.location,e.guest_mode,e.rsvp_deadline,e.responses_open,e.reopened_at,e.capacity,
        e.published,e.status,e.status_note,e.theme_json,e.invitation_settings_json,e.invitation_copy_json,
        r.answer,r.party_size,r.updated_at,
        COALESCE(jsonb_agg(jsonb_build_object('id',a.id,'name',a.name)
          ORDER BY a.id) FILTER (WHERE a.id IS NOT NULL),'[]'::jsonb) attendees
        FROM guest_units g JOIN events e ON e.id=g.event_id LEFT JOIN rsvps r ON r.guest_unit_id=g.id
        LEFT JOIN rsvp_attendees a ON a.guest_unit_id=g.id
        WHERE g.token_hash=${tokenHash} GROUP BY g.id,e.id,r.id`;
      const guest = rows[0];
      if (!guest || guest.revoked_at || !guest.published) throw error('This invitation link is invalid or has been revoked.', 404);
      const deadlinePassed = guest.rsvp_deadline && new Date(guest.rsvp_deadline).getTime() <= Date.now();
      const canRespond = guest.status !== 'cancelled' && Boolean(guest.responses_open) &&
        (!deadlinePassed || Boolean(guest.reopened_at));
      if (method === 'GET') return response(200, { event: {
        title: guest.title, eventDate: String(guest.event_date).slice(0,10), location: guest.location,
        status: guest.status || 'active', statusNote: guest.status_note || null,
        eventStartTime: guest.event_start_time || null, eventEndTime: guest.event_end_time || null,
        timezone: guest.event_timezone || null, rsvpDeadline: guest.rsvp_deadline || null,
        theme: guest.theme_json || {}, invitationSettings: guest.invitation_settings_json || {},
        invitationCopy: guest.invitation_copy_json || {}
      }, guest: { name: guest.name, partyLimit: Number(guest.party_limit), answer: guest.answer || null,
        partySize: guest.party_size === null ? null : Number(guest.party_size), attendees: guest.attendees || [] },
      canRespond });
      if (method === 'PUT') {
        if (guest.status === 'cancelled') throw error('Cancelled events cannot accept RSVP changes.', 409);
        if (!guest.responses_open) throw error('RSVP responses are currently closed.', 409);
        if (deadlinePassed && !guest.reopened_at) {
          throw error('The RSVP deadline has passed.', 409);
        }
        if (guest.guest_mode === 'individual' && input.partySize > 1) throw error('Individual invitations can only have one attendee.');
        const capacityRows = await query`SELECT COALESCE(SUM(r.party_size),0)::int AS attending FROM rsvps r
          JOIN guest_units g ON g.id=r.guest_unit_id WHERE g.event_id=${guest.event_id}
          AND g.revoked_at IS NULL AND r.answer='yes' AND g.id <> ${guest.id}`;
        if (input.answer === 'yes' && guest.capacity !== null &&
          Number(capacityRows[0]?.attending || 0) + input.partySize > Number(guest.capacity)) {
          throw error('This RSVP would exceed the event capacity.', 409);
        }
        if (!['yes', 'no', 'maybe'].includes(input.answer) || !Number.isInteger(input.partySize) ||
            input.partySize < 0 || input.partySize > Number(guest.party_limit)) throw error('RSVP details are invalid.');
        if (input.answer === 'yes' && input.partySize < 1) throw error('A yes RSVP needs at least one attendee.');
        const rsvp = await query`INSERT INTO rsvps(guest_unit_id,answer,party_size,updated_at)
          VALUES(${guest.id},${input.answer},${input.partySize},${now()})
          ON CONFLICT(guest_unit_id) DO UPDATE SET answer=EXCLUDED.answer,
          party_size=EXCLUDED.party_size,updated_at=EXCLUDED.updated_at RETURNING id`;
        await query`DELETE FROM rsvp_attendees WHERE guest_unit_id=${guest.id}`;
        for (const attendee of Array.isArray(input.attendees) ? input.attendees.slice(0, 20) : []) {
          if (attendee && typeof attendee.name === 'string') {
            await query`INSERT INTO rsvp_attendees(guest_unit_id,name,dietary,accessibility,age_band,created_at)
              VALUES(${guest.id},${attendee.name.trim()},
                ${typeof attendee.dietary === 'string' ? attendee.dietary.trim().slice(0, 500) : ''},
                ${typeof attendee.accessibility === 'string' ? attendee.accessibility.trim().slice(0, 500) : ''},
                ${attendee.ageBand === 'child' ? 'child' : 'adult'},${now()})`;
          }
        }
        await query`UPDATE seating_plans SET status='stale',updated_at=${now()}
          WHERE event_id=${guest.event_id} AND status IN ('draft','saved','published')`;
        return response(200, { ok: true });
      }
    }
    throw error('API route not found.', 404);
  }

  async function loginResponse(record, run) {
    const token = crypto.randomBytes(32).toString('base64url');
    await run`INSERT INTO sessions(token_hash,host_id,expires_at)
      VALUES(${sessionHash(token)},${record.id},${new Date(Date.now() + SESSION_MS).toISOString()})`;
    return response(200, { host: { email: record.email } }, {
      'set-cookie': `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}`
    });
  }

  return async (event) => {
    try { return await dispatch(event); }
    catch (caught) {
      const status = Number.isInteger(caught.status) ? caught.status : 500;
      if (status >= 500) console.error('Hosted API request failed:', caught);
      return response(status, { error: status >= 500 ? 'Unexpected server error.' : caught.message, ...(caught.code ? { code: caught.code } : {}) });
    }
  };
}

module.exports = { createHandler };
