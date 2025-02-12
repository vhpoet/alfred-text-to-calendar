#!/usr/bin/env node
import OpenAI from 'openai';
import ical from 'ical-generator';
import { file } from 'tmp-promise';
import { execFile } from 'child_process';
import { z } from 'zod';
import { zodResponseFormat } from 'openai/helpers/zod';

// Retrieve and validate input text
const input = process.argv[2]?.trim();

if (!input) {
  console.error("No text provided to process");
  process.exit(1);
}

// Check for the OpenAI API key
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4';

if (!OPENAI_API_KEY) {
  console.error("OpenAI API key not found. Please set it in the workflow configuration.");
  process.exit(1);
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Define the event schema
const CalendarEventSchema = z.object({
  events: z.array(z.object({
    title: z.string(),
    startDate: z.string(),
    endDate: z.string(),
    location: z.string().nullable(),
    description: z.string().nullable(),
    allDay: z.boolean().optional()
  })).optional(),
  error: z.string().optional()
}).refine(
  data => data.error || (data.events && data.events.length > 0),
  { message: "Must provide either an error or at least one event" }
);

// Helper function to parse dates; expects ISO 8601 format.
function parseDate(dateString) {
  const date = new Date(dateString);
  if (isNaN(date.getTime())) {
    throw new Error(`Invalid date format: ${dateString}`);
  }
  return date;
}

// Create Apple Calendar events via an ICS file.
async function createCalendarEvents(events) {
  const tmpFile = await file({ postfix: '.ics' });
  const calendar = ical({ name: 'Calendar Events' });

  for (const eventData of events) {
    const start = parseDate(eventData.startDate);
    const end = parseDate(eventData.endDate);

    calendar.createEvent({
      start,
      end,
      summary: eventData.title,
      location: eventData.location || undefined,
      description: eventData.description || undefined,
      allDay: eventData.allDay || false
    });
  }

  await calendar.save(tmpFile.path);
  
  return execFile('open', ['-a', 'Calendar', tmpFile.path]);
}

try {
  const today = new Date().toISOString().split('T')[0];
  const systemPrompt = `Extract all event details from the provided content with strict adherence to the following rules.
Today's date is: ${today}

Instructions:
- Date and Time Format:
  - Convert all date and time values into ISO 8601 format.
  - If no time zone is mentioned but a location is provided, deduce the correct time zone based on the location.
  - If no time zone or location is available, leave out the time zone.
  - For flights, infer time zones based on departure and arrival airport codes.
  - For relative dates (e.g., "tomorrow", "next week"), calculate them relative to today's date (${today}).

- Event Classification:
  - All-Day Events: If the text specifies a date without a specific time, set "allDay": true.
  - Flights: Follow the special format detailed below.

- Output Format:
  - Return an array of structured event objects.
  - If no valid events are found, return an object: { "error": "Description of the issue" }.

Flight Formatting Rules:
For flights, structure the output as follows:
- Summary: "✈️ [Arrival City] (Flight Number)"
- Location: Departing Airport Name, Full Address
- Description: Include additional relevant details such as terminal and gate information in a multi-line format.

Hangout Formatting rules:
- Summary: "Hang w/[Name]"
`;

  const response = await openai.beta.chat.completions.parse({
    model: OPENAI_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: input }
    ],
    response_format: zodResponseFormat(CalendarEventSchema, "calendar_events")
  });

  const result = response.choices[0].message.parsed;

  // If the model returns an error, exit quietly
  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }

  await createCalendarEvents(result.events);
} catch (error) {
  if (error.status === 401) {
    console.error("Invalid OpenAI API key. Please check your API key in the workflow configuration.");
    process.exit(1);
  }
  console.error(error);
  process.exit(1);
}