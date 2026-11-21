import { z } from "zod";

// One card = one glance. The M6 display module is a 640x480 waveguide (some units are single-colour
// green), so cards are short text on black. Black pixels are transparent on a waveguide.
// Length limits live in descriptions (structured outputs don't enforce string length); the HUD clamps too.
export const CardSchema = z.object({
  title: z.string().describe("Headline, at most 18 characters. The one thing to notice."),
  lines: z
    .array(z.string())
    .describe("0 to 3 lines, each at most 26 characters. Plain words, no markdown, no emoji."),
  speak: z
    .string()
    .describe("Optional single short sentence to read aloud through the glasses speaker. Empty string if none."),
  phone_detail: z
    .string()
    .describe("Fuller explanation shown on the phone only (2-5 sentences). This is the handoff: glasses glance, phone depth."),
});

const HUD_RULES = `You write for a heads-up display on smart glasses.
The wearer reads it in under two seconds while doing something else, so the glasses card carries one idea.
Title: at most 18 characters. Lines: at most 3, each at most 26 characters. No markdown, no emoji.
Put anything longer in phone_detail, which shows on the phone when the wearer wants depth.`;

export const MODES = {
  // General heads-up assistant: what the camera sees + what the wearer said.
  assist: {
    system: `${HUD_RULES}

You are a quiet assistant that sees what the wearer sees. Answer what they asked, or, if they asked nothing,
surface the single most useful fact about what is in front of them. If the image is unclear, say what you need.`,
    userText: ({ text, context, hasImage }) =>
      [
        hasImage ? "The image is the wearer's first-person view right now." : "No image this time.",
        context ? `What we know about the wearer: ${JSON.stringify(context)}` : "",
        text ? `The wearer said: "${text}"` : "The wearer said nothing; offer the most useful glance.",
      ]
        .filter(Boolean)
        .join("\n"),
  }
};
