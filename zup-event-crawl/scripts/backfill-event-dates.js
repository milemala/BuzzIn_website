#!/usr/bin/env node

const path = require("path");
const { resolveEventDates } = require("../lib/event-dates");
const { eventUidFor, openDatabase } = require("../lib/review-db");

const dbPath = process.argv[2] || path.join(__dirname, "..", "data", "review.db");
const db = openDatabase(dbPath);

const rows = db.prepare(`
  SELECT event_uid, start_date, end_date
  FROM events
`).all();

const deleteEventDates = db.prepare("DELETE FROM event_dates WHERE event_uid = ?");
const insertEventDate = db.prepare("INSERT OR IGNORE INTO event_dates (event_uid, event_date) VALUES (?, ?)");

let updated = 0;
for (const row of rows) {
  const dates = resolveEventDates({
    startDate: row.start_date,
    endDate: row.end_date,
    eventDates: [],
  });
  deleteEventDates.run(row.event_uid);
  for (const eventDate of dates) {
    insertEventDate.run(row.event_uid, eventDate);
  }
  updated += 1;
}

db.close();
console.log(`Backfilled event_dates for ${updated} events in ${dbPath}`);
