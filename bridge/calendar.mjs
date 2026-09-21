import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { execFile } from 'node:child_process'
import { z } from 'zod'

/**
 * Apple Calendar, in-process — read events and add new ones via Calendar.app's
 * own scripting bridge (JXA), the same automation channel `osascript` already
 * uses on this machine.
 *
 * Third-party MCP packages for this exist, but the ones that shell out to a
 * standalone compiled EventKit helper never trigger macOS's permission prompt
 * at all — a bare Mach-O binary has no bundle identity for TCC to attach
 * consent to, so the request just comes back denied, silently, forever. JXA
 * talking to Calendar.app is a normal Apple Events request, which is what
 * already works here, so this stays in that channel rather than reaching for
 * EventKit directly.
 *
 * The tool surface is deliberately small: list and create, nothing else. That
 * is not a restriction bolted on top — it is the entire feature the user
 * asked for ("read my calendar, and let it add things I say"), so there is no
 * update or delete tool to gate in the first place.
 */

function runJXA(script, args) {
  return new Promise((resolve, reject) => {
    execFile(
      'osascript',
      ['-l', 'JavaScript', '-e', script, ...args],
      { timeout: 15_000 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message))
        resolve(stdout.trim())
      },
    )
  })
}

const LIST_SCRIPT = `
function run(argv) {
  var app = Application('Calendar')
  var from = new Date(argv[0])
  var to = new Date(argv[1])
  var results = []
  var cals = app.calendars()
  for (var i = 0; i < cals.length; i++) {
    var cal = cals[i]
    var evts
    try {
      evts = cal.events.whose({ _and: [
        { startDate: { _greaterThanEquals: from } },
        { startDate: { _lessThan: to } },
      ]})()
    } catch (e) { continue }
    for (var j = 0; j < evts.length; j++) {
      var e = evts[j]
      var loc = ''
      try { loc = e.location() || '' } catch (x) {}
      results.push({
        summary: e.summary(),
        start: e.startDate().toISOString(),
        end: e.endDate().toISOString(),
        calendar: cal.name(),
        location: loc,
      })
    }
  }
  results.sort(function (a, b) { return a.start < b.start ? -1 : 1 })
  return JSON.stringify(results)
}
`

const CREATE_SCRIPT = `
function run(argv) {
  var app = Application('Calendar')
  var calName = argv[0]
  var summary = argv[1]
  var start = new Date(argv[2])
  var end = new Date(argv[3])
  var location = argv[4] || ''
  var notes = argv[5] || ''
  var matches = app.calendars.whose({ name: calName })()
  if (matches.length === 0) {
    return JSON.stringify({ error: 'no calendar named "' + calName + '"' })
  }
  var props = { summary: summary, startDate: start, endDate: end }
  if (location) props.location = location
  if (notes) props.description = notes
  var newEvent = app.Event(props)
  matches[0].events.push(newEvent)
  return JSON.stringify({ ok: true })
}
`

const err = (text) => ({ isError: true, content: [{ type: 'text', text }] })
const ok = (text) => ({ content: [{ type: 'text', text }] })

export function calendarServer() {
  return createSdkMcpServer({
    name: 'jarvis_calendar',
    version: '1.0.0',
    instructions:
      'Apple Calendar, read and add only. list_events reads a date range; ' +
      'create_event adds one event to a named calendar. There is no update ' +
      'or delete tool — those are not available.',
    tools: [
      tool(
        'list_events',
        'List calendar events between two dates (ISO 8601, e.g. ' +
          '2026-09-21T00:00:00). Use this for "what is on my calendar today / ' +
          'this week / tomorrow" — pass the day boundaries the user means.',
        {
          from: z.string().describe('Range start, ISO 8601 date-time.'),
          to: z.string().describe('Range end, ISO 8601 date-time.'),
        },
        async (args) => {
          try {
            const raw = await runJXA(LIST_SCRIPT, [args.from, args.to])
            const events = JSON.parse(raw)
            if (!events.length) return ok('No events in that range.')
            return ok(JSON.stringify(events))
          } catch (e) {
            return err(`Could not read the calendar: ${e.message}`)
          }
        },
      ),
      tool(
        'create_event',
        'Add one event to a named Apple Calendar (e.g. "Ev", "İş"). Ask which ' +
          'calendar if the user has several and did not say.',
        {
          calendar: z.string().describe('Exact name of the target calendar.'),
          summary: z.string().describe('Event title.'),
          start: z.string().describe('Start date-time, ISO 8601.'),
          end: z.string().describe('End date-time, ISO 8601.'),
          location: z.string().optional().describe('Optional location.'),
          notes: z.string().optional().describe('Optional notes.'),
        },
        async (args) => {
          try {
            const raw = await runJXA(CREATE_SCRIPT, [
              args.calendar,
              args.summary,
              args.start,
              args.end,
              args.location ?? '',
              args.notes ?? '',
            ])
            const result = JSON.parse(raw)
            if (result.error) return err(result.error)
            return ok(`Added "${args.summary}" to ${args.calendar}.`)
          } catch (e) {
            return err(`Could not create the event: ${e.message}`)
          }
        },
      ),
    ],
  })
}
