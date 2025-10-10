#!/usr/bin/env node
import OpenAI from "openai";
import ical from "ical-generator";
import { file } from "tmp-promise";
import { execFile } from "child_process";
import { z } from "zod";

// Retrieve and validate input text
const input = process.argv[2]?.trim();

if (!input) {
  console.error("No text provided to process");
  process.exit(1);
}

// Check if input is a URL
const urlPattern = /^https?:\/\//i;
const isUrl = urlPattern.test(input);

// Check for the OpenAI API key
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  console.error(
    "OpenAI API key not found. Please set it in the workflow configuration."
  );
  process.exit(1);
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Pricing (per 1M tokens)
const PRICING = {
  "gpt-5": {
    input: 2.5,
    output: 10.0,
  },
  "gpt-5-mini": {
    input: 0.25,
    cached_input: 0.025,
    output: 2.0,
  },
};

// Define the event schema
const CalendarEventSchema = z.object({
  events: z
    .array(
      z.object({
        title: z.string(),
        startDate: z.string(),
        endDate: z.string(),
        location: z.string().nullable(),
        description: z.string().nullable(),
        allDay: z.boolean().optional(),
        recurring: z
          .object({
            freq: z.enum(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]),
            interval: z.number().optional(),
            count: z.number().optional(),
            until: z.string().optional(),
            byDay: z.array(z.string()).optional(),
            byMonth: z.array(z.number()).optional(),
            byMonthDay: z.array(z.number()).optional(),
          })
          .optional(),
      })
    )
    .optional(),
  error: z.string().optional(),
});

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
  const tmpFile = await file({ postfix: ".ics" });
  const calendar = ical({ name: "Calendar Events" });

  for (const eventData of events) {
    const start = parseDate(eventData.startDate);
    const end = parseDate(eventData.endDate);

    const eventConfig = {
      start,
      end,
      summary: eventData.title,
      location: eventData.location || undefined,
      description: eventData.description || undefined,
      allDay: eventData.allDay || false,
    };

    // Add recurring properties only if freq is specified
    if (eventData.recurring?.freq) {
      eventConfig.repeating = {
        freq: eventData.recurring.freq,
        interval: eventData.recurring.interval,
        count: eventData.recurring.count,
        until: eventData.recurring.until
          ? parseDate(eventData.recurring.until)
          : undefined,
        byDay: eventData.recurring.byDay,
        byMonth: eventData.recurring.byMonth,
        byMonthDay: eventData.recurring.byMonthDay,
      };
    }

    calendar.createEvent(eventConfig);
  }

  await calendar.save(tmpFile.path);

  return execFile("open", ["-a", "Calendar", tmpFile.path]);
}

try {
  const today = new Date().toISOString().split("T")[0];

  const jsonSchema = `
Return your response as valid JSON matching this exact schema:
{
  "events": [
    {
      "title": "string",
      "startDate": "string (ISO 8601)",
      "endDate": "string (ISO 8601)",
      "location": "string or null",
      "description": "string or null",
      "allDay": "boolean (optional)",
      "recurring": {
        "freq": "DAILY | WEEKLY | MONTHLY | YEARLY",
        "interval": "number (optional)",
        "count": "number (optional)",
        "until": "string (ISO 8601, optional)",
        "byDay": "array of strings (optional)",
        "byMonth": "array of numbers (optional)",
        "byMonthDay": "array of numbers (optional)"
      } (optional - only include if event is recurring)
    }
  ],
  "error": "string (optional - only if no valid events found)"
}
`;

  const baseInstructions = `
- Date and Time Format:
  - Convert all date and time values into ISO 8601 format.
  - If no time zone is mentioned but a location is provided, deduce the correct time zone based on the location.
  - If no time zone or location is available, leave out the time zone.
  - For flights, infer time zones based on departure and arrival airport codes.
  - For relative dates (e.g., "tomorrow", "next week"), calculate them relative to today's date (${today}).

- Event Classification:
  - All-Day Events: If the text specifies a date without a specific time, set "allDay": true.
  - Flights: Follow the special format detailed below.
  - Recurring Events: ONLY include recurrence rules if the text EXPLICITLY indicates the event repeats (e.g., "every Monday", "weekly", "monthly", "daily"). DO NOT add recurrence to one-time events. When in doubt, treat it as a one-time event.

- Recurrence Rules (ONLY use when explicitly stated):
  - IMPORTANT: Do not include the "recurring" field at all unless the event is clearly recurring.
  - freq: DAILY, WEEKLY, MONTHLY, or YEARLY
  - interval: Number of intervals between occurrences (e.g., 2 for every two weeks)
  - count: Number of times the event should occur
  - until: End date for recurrence (in ISO 8601)
  - byDay: Days of the week [MO, TU, WE, TH, FR, SA, SU]
  - byMonth: Months of the year [1-12]
  - byMonthDay: Days of the month [1-31]

- Output Format:
  - Return an array of structured event objects.
  - If no valid events are found, return an object: { "error": "Description of the issue" }.

Flight Formatting Rules:
For flights, structure the output as follows:
- Summary: "✈️ [Arrival City] (Flight Number)"
- Location: Departing Airport Name, Full Address
- Description: Include additional relevant details such as terminal and gate information in a multi-line format.

Title formatting for different types of events:
- Gym: [Class] ([Instructor])
- Hangout: Hang w/[Name]
`;

  const systemPrompt = isUrl
    ? `Extract all event details from the webpage at the provided URL with strict adherence to the following rules.
Today's date is: ${today}

${jsonSchema}

Instructions:${baseInstructions}`
    : `Extract all event details from the provided content with strict adherence to the following rules.
Today's date is: ${today}

${jsonSchema}

Instructions:${baseInstructions}`;

  const apiConfig = {
    model: "gpt-5-mini",
    input: `${systemPrompt}\n\nUser input: ${input}`,
  };

  // Enable web search if input is a URL
  if (isUrl) {
    console.error("Using web search mode (URL detected)");
    apiConfig.tools = [{ type: "web_search_preview" }];
  } else {
    console.error("Using text processing mode");
  }

  const response = await openai.responses.create(apiConfig);

  // Extract the actual content from the response structure
  let parsedOutput;
  if (Array.isArray(response.output)) {
    // Find the message item in the output array
    const messageItem = response.output.find(item => item.type === "message");
    if (messageItem?.content?.[0]?.text) {
      parsedOutput = JSON.parse(messageItem.content[0].text);
    } else {
      throw new Error("Could not find message content in response");
    }
  } else if (typeof response.output === "string") {
    parsedOutput = JSON.parse(response.output);
  } else {
    parsedOutput = response.output;
  }

  const result = CalendarEventSchema.parse(parsedOutput);

  // If the model returns an error, exit quietly
  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }

  await createCalendarEvents(result.events);

  // Log token usage and cost
  if (response.usage) {
    const { input_tokens, output_tokens, input_tokens_details } =
      response.usage;
    const model = response.model || "gpt-5";
    const pricing = PRICING[model] || PRICING["gpt-5"];

    // Calculate input cost (with cache consideration for mini)
    let inputCost;
    if (model === "gpt-5-mini" && input_tokens_details?.cached_tokens) {
      const regularInputTokens =
        input_tokens - input_tokens_details.cached_tokens;
      inputCost =
        (regularInputTokens / 1_000_000) * pricing.input +
        (input_tokens_details.cached_tokens / 1_000_000) * pricing.cached_input;
    } else {
      inputCost = (input_tokens / 1_000_000) * pricing.input;
    }

    const outputCost = (output_tokens / 1_000_000) * pricing.output;
    const totalCost = inputCost + outputCost;
    const totalTokens = input_tokens + output_tokens;

    console.error(
      `\nTokens used: ${totalTokens.toLocaleString()} (${input_tokens.toLocaleString()} input + ${output_tokens.toLocaleString()} output)`
    );
    if (model === "gpt-5-mini" && input_tokens_details?.cached_tokens) {
      console.error(
        `  - ${input_tokens_details.cached_tokens.toLocaleString()} cached input tokens`
      );
    }
    console.error(
      `Cost: $${totalCost.toFixed(4)} ($${inputCost.toFixed(
        4
      )} input + $${outputCost.toFixed(4)} output)`
    );
  }
} catch (error) {
  if (error.status === 401) {
    console.error(
      "Invalid OpenAI API key. Please check your API key in the workflow configuration."
    );
    process.exit(1);
  }
  console.error("Error details:", error.message || error);
  if (error.stack) {
    console.error("Stack trace:", error.stack);
  }
  process.exit(1);
}
