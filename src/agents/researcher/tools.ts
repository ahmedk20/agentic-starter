import { z } from "zod";
import { defineTool } from "@framework/tool";

// Produces a Markdown outline from a topic + subtopics list.
// Useful when the model wants to organise its research before writing prose.
export const structureOutlineTool = defineTool({
  name: "structure_outline",
  description:
    "Given a topic and an array of subtopics, returns a Markdown outline skeleton the agent can fill in.",
  schema: z
    .object({
      topic: z.string().min(1).describe("The main research topic"),
      subtopics: z
        .array(z.string().min(1))
        .min(1)
        .describe("List of subtopics or sections to include in the outline"),
    })
    .strict(),
  async execute({ topic, subtopics }) {
    const sections = subtopics
      .map((s, i) => `${i + 1}. **${s}**\n   - \n   - `)
      .join("\n\n");
    return `# Research Outline: ${topic}\n\n${sections}`;
  },
});
