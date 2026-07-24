import { createOpenAI } from "@ai-sdk/openai";

export const fireworks = createOpenAI({
  apiKey: process.env.FIREWORKS_API_KEY,
  baseURL: "https://api.fireworks.ai/inference/v1",
});

export const FIREWORKS_MODEL =
  process.env.FIREWORKS_MODEL ?? "accounts/fireworks/models/minimax-m3";
