'use strict';

const crypto = require('node:crypto');

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const invalid = (message) => Object.assign(new Error(message), { status: 400 });

function validateVenueItems(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) throw invalid('Venue items are invalid.');
  return value.map((item) => {
    const type = typeof item?.type === 'string' ? item.type.trim() : '';
    const label = typeof item?.label === 'string' ? item.label.trim() : type;
    const x = Number(item?.positionX), y = Number(item?.positionY);
    const width = item?.width === undefined ? null : Number(item.width);
    const height = item?.height === undefined ? null : Number(item.height);
    if (!type || type.length > 50 || !label || label.length > 100 ||
      !Number.isFinite(x) || x < 3 || x > 97 || !Number.isFinite(y) || y < 3 || y > 97 ||
      (width !== null && (!Number.isFinite(width) || width <= 0 || width > 100)) ||
      (height !== null && (!Number.isFinite(height) || height <= 0 || height > 100))) {
      throw invalid('Venue items must have a label and valid map position.');
    }
    return { type, label, positionX: x, positionY: y,
      ...(width === null ? {} : { width }), ...(height === null ? {} : { height }) };
  });
}

function validateFloorPlanMetadata(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('Floor plan metadata is invalid.');
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  const type = typeof value.type === 'string' ? value.type.trim() : '';
  if (name.length > 255 || type.length > 100) throw invalid('Floor plan metadata is invalid.');
  return { name, type, availableLocally: value.availableLocally !== false,
    candidateCount: Number.isSafeInteger(Number(value.candidateCount)) ? Number(value.candidateCount) : 0 };
}

function validateSeatingTables(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 40) {
    throw invalid('Add between 1 and 40 seating tables.');
  }
  const names = new Set();
  return value.map((table, index) => {
    const name = typeof table?.name === 'string' ? table.name.trim() : `Table ${index + 1}`;
    const capacity = Number(table?.capacity);
    const shape = ['round', 'rectangle', 'square', 'banquet'].includes(table?.shape) ? table.shape : 'round';
    const positionX = Number.isFinite(Number(table?.positionX)) ? Number(table.positionX) : 18 + (index % 4) * 21;
    const positionY = Number.isFinite(Number(table?.positionY)) ? Number(table.positionY) : 24 + (Math.floor(index / 4) % 3) * 28;
    if (!name || name.length > 100 || names.has(name.toLowerCase())) throw invalid('Table names must be unique and 1–100 characters.');
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 100) throw invalid('Table capacity must be a whole number between 1 and 100.');
    if (!Number.isFinite(positionX) || positionX < 5 || positionX > 95 || !Number.isFinite(positionY) || positionY < 8 || positionY > 92) {
      throw invalid('Table positions must stay within the seating map.');
    }
    names.add(name.toLowerCase());
    return { name, capacity, shape, positionX, positionY };
  });
}

function validateSeatingConstraints(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 200) throw invalid('Seating constraints are invalid.');
  return value.map((constraint) => {
    const relationshipType = constraint?.relationshipType ||
      (constraint?.type === 'together' ? 'keep-together' : constraint?.type === 'apart' ? 'keep-apart' : constraint?.type);
    if (!['keep-together', 'keep-apart'].includes(relationshipType) || !Array.isArray(constraint.attendeeIds) ||
      constraint.attendeeIds.length < 2 || constraint.attendeeIds.length > 20 ||
      constraint.attendeeIds.some((id) => !Number.isSafeInteger(Number(id)) || Number(id) < 1)) {
      throw invalid('Each seating constraint needs a type and at least two attendee IDs.');
    }
    if (constraint.priority !== undefined && !['required', 'preferred'].includes(constraint.priority)) {
      throw invalid('Seating constraint priority must be required or preferred.');
    }
    const attendeeIds = [...new Set(constraint.attendeeIds.map(Number))];
    if (attendeeIds.length < 2) throw invalid('Each seating constraint needs two distinct attendee IDs.');
    return { type: relationshipType === 'keep-together' ? 'together' : 'apart', relationshipType,
      relationship: typeof constraint.relationship === 'string' ? constraint.relationship.trim().slice(0, 60) : '',
      attendeeIds, priority: constraint.priority === 'required' ? 'required' : 'preferred' };
  });
}

function generateSeatingDraft(attendees, tables, constraints, seed = 1) {
  const byId = new Map(attendees.map((a) => [Number(a.id), a]));
  const parent = new Map(attendees.map((a) => [Number(a.id), Number(a.id)]));
  const find = (id) => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root);
    while (parent.get(id) !== id) { const next = parent.get(id); parent.set(id, root); id = next; }
    return root;
  };
  const union = (a, b) => { const left = find(a), right = find(b); if (left !== right) parent.set(right, left); };
  const violations = [];
  for (const constraint of constraints) {
    const ids = constraint.attendeeIds.filter((id) => byId.has(id));
    if (ids.length !== constraint.attendeeIds.length) violations.push({ type: 'invalid', message: 'A constraint references an attendee who is not eligible.' });
    if (constraint.relationshipType === 'keep-together') for (let i = 1; i < ids.length; i += 1) union(ids[0], ids[i]);
  }
  const maxCapacity = Math.max(...tables.map((table) => Number(table.capacity)), 0);
  const households = new Map();
  attendees.forEach((a) => { const id = Number(a.guestUnitId); if (Number.isSafeInteger(id)) households.set(id, [...(households.get(id) || []), Number(a.id)]); });
  for (const ids of households.values()) if (ids.length <= maxCapacity) for (let i = 1; i < ids.length; i += 1) union(ids[0], ids[i]);
  const groups = new Map();
  attendees.forEach((a) => { const key = find(Number(a.id)); groups.set(key, [...(groups.get(key) || []), a]); });
  const remaining = new Map(tables.map((t) => [Number(t.id), Number(t.capacity)]));
  const assigned = new Map();
  for (const group of [...groups.values()].sort((a, b) => b.length - a.length || Number(a[0].id) - Number(b[0].id))) {
    const options = tables.filter((t) => (remaining.get(Number(t.id)) || 0) >= group.length)
      .sort((a, b) => remaining.get(Number(b.id)) - remaining.get(Number(a.id)) || Number(a.id) - Number(b.id));
    if (!options.length) {
      group.forEach((a) => violations.push({ type: 'capacity', attendeeId: Number(a.id), message: `${a.name} could not be assigned within table capacity.` }));
      continue;
    }
    const tableId = Number(options[0].id);
    group.forEach((a) => assigned.set(Number(a.id), tableId));
    remaining.set(tableId, remaining.get(tableId) - group.length);
  }
  for (const constraint of constraints) {
    const ids = constraint.attendeeIds.map((id) => assigned.get(id)).filter(Boolean);
    const violated = constraint.relationshipType === 'keep-apart'
      ? ids.length > 1 && new Set(ids).size !== ids.length : ids.length > 1 && new Set(ids).size > 1;
    if (violated) violations.push({ type: 'preference', relationshipType: constraint.relationshipType, priority: constraint.priority,
      attendeeIds: constraint.attendeeIds, message: constraint.relationshipType === 'keep-apart'
        ? 'Some guests marked “keep apart” share a table.' : 'Some guests marked “keep together” are split across tables.' });
  }
  const assignments = [...assigned.entries()].sort(([a], [b]) => a - b).map(([attendeeId, tableId]) => ({ attendeeId, tableId }));
  const unassigned = attendees.filter((a) => !assigned.has(Number(a.id))).map((a) => ({ attendeeId: Number(a.id), name: a.name }));
  const householdGroups = [...households.values()];
  const kept = householdGroups.filter((group) => {
    const ids = new Set(group.map((id) => assigned.get(id)).filter(Boolean));
    return ids.size === 1 && group.every((id) => assigned.has(id));
  }).length;
  const familiesSplit = householdGroups.length - kept;
  const normalized = JSON.stringify({ attendees: attendees.map(({ id, name, guestUnitId }) => [Number(id), name, Number(guestUnitId)]),
    tables: tables.map(({ id, capacity }) => [Number(id), Number(capacity)]), constraints, seed });
  return { assignments, unassigned, score: Math.max(0, 100 - violations.reduce((n, v) => n + (v.priority === 'required' ? 40 : 10), 0) - unassigned.length * 20 - familiesSplit * 15),
    inputHash: sha256(normalized), payload: { constraints, violations, unassigned, attendeeCount: attendees.length,
      assignedCount: assignments.length, remainingCapacity: [...remaining.values()].reduce((a, b) => a + b, 0),
      optimization: { householdGroups: householdGroups.length, familiesKeptTogether: kept, familiesSplit,
        familyOptimizationScore: householdGroups.length ? Math.round((kept / householdGroups.length) * 100) : 100 } } };
}

module.exports = { validateVenueItems, validateFloorPlanMetadata, validateSeatingTables, validateSeatingConstraints, generateSeatingDraft };
