'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  validateVenueItems, validateFloorPlanMetadata, validateSeatingTables,
  validateSeatingConstraints, generateSeatingDraft
} = require('../lib/seating');

test('hosted migration contains the complete advanced workflow schema', () => {
  const schema = fs.readFileSync(path.join(__dirname, '../migrations/001_initial.sql'), 'utf8');
  for (const table of ['seating_plans', 'seating_tables', 'seating_assignments', 'seating_constraints']) {
    assert.match(schema, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
  }
  for (const column of ['venue_items_json', 'floor_plan_json', 'initial_position_x', 'initial_position_y',
    'replacement_event_date', 'replacement_event_start_time', 'replacement_event_end_time',
    'replacement_event_timezone']) {
    assert.match(schema, new RegExp(`\\b${column}\\b`));
  }
  assert.match(schema, /check_ins_guest_active_idx/);
  assert.match(schema, /check_ins_attendee_active_idx/);
});

test('Neon seating validation and optimizer preserve organizer constraints', () => {
  const tables = validateSeatingTables([{ name: 'Main', capacity: 2, positionX: 20, positionY: 30 }]);
  const constraints = validateSeatingConstraints([{
    relationshipType: 'keep-together', attendeeIds: [1, 2], priority: 'required'
  }]);
  const attendees = [
    { id: 1, guestUnitId: 10, name: 'A' },
    { id: 2, guestUnitId: 10, name: 'B' }
  ];
  tables[0].id = 4;
  const result = generateSeatingDraft(attendees, tables, constraints, 7);
  assert.deepEqual(result.assignments, [{ attendeeId: 1, tableId: 4 }, { attendeeId: 2, tableId: 4 }]);
  assert.equal(result.payload.optimization.familiesKeptTogether, 1);
  assert.deepEqual(validateVenueItems([{ type: 'stage', positionX: 50, positionY: 50 }]), [{
    type: 'stage', label: 'stage', positionX: 50, positionY: 50
  }]);
  assert.deepEqual(validateFloorPlanMetadata({ name: 'Room A', type: 'local', candidateCount: 2 }), {
    name: 'Room A', type: 'local', availableLocally: true, candidateCount: 2
  });
});
