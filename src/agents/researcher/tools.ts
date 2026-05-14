import type { Tool } from "@core/types";

// Produces a Markdown outline from a topic + subtopics list.
// Useful when the model wants to organise its research before writing prose.
export const structureOutlineTool: Tool = {
  name: "structure_outline",
  description:
    "Given a topic and an array of subtopics, returns a Markdown outline skeleton the agent can fill in.",
  inputSchema: {
    type: "object",
    properties: {
      topic:     { type: "string", description: "The main research topic" },
      subtopics: {
        type: "array",
        items: { type: "string" },
        description: "List of subtopics or sections to include in the outline",
      },
    },
    required: ["topic", "subtopics"],
  },
  async execute(input: unknown): Promise<string> {
    const { topic, subtopics } = input as { topic: string; subtopics: string[] };

    const sections = subtopics
      .map((s, i) => `${i + 1}. **${s}**\n   - \n   - `)
      .join("\n\n");

    return `# Research Outline: ${topic}\n\n${sections}`;
  },
};
