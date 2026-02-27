import OpenAI from "openai";
import { loadSettings } from "../config/settings.js";

let openaiClient: OpenAI | null = null;
let openrouterClient: OpenAI | null = null;

function getOpenAI(): OpenAI {
  if (!openaiClient) {
    openaiClient = new OpenAI();
  }
  return openaiClient;
}

function getOpenRouter(): OpenAI {
  if (!openrouterClient) {
    openrouterClient = new OpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: process.env["OPENROUTER_API_KEY"],
    });
  }
  return openrouterClient;
}

export async function generateEmbedding(text: string): Promise<number[]> {
  const settings = await loadSettings();
  const { provider, model, dimensions } = settings.embedding;

  if (provider === "openai") {
    const openai = getOpenAI();
    const response = await openai.embeddings.create({
      model,
      input: text,
      dimensions,
    });
    return response.data[0]!.embedding;
  }

  if (provider === "openrouter") {
    const openrouter = getOpenRouter();
    const response = await openrouter.embeddings.create({
      model,
      input: text,
      dimensions,
    });
    return response.data[0]!.embedding;
  }

  // Local fallback: zero vector (to be replaced with local embedding model)
  return Array(dimensions).fill(0);
}

export async function generateEmbeddings(
  texts: string[],
): Promise<number[][]> {
  if (texts.length === 0) return [];

  const settings = await loadSettings();
  const { provider, model, dimensions } = settings.embedding;

  if (provider === "openai") {
    const openai = getOpenAI();
    const response = await openai.embeddings.create({
      model,
      input: texts,
      dimensions,
    });
    return response.data.map((d) => d.embedding);
  }

  if (provider === "openrouter") {
    const openrouter = getOpenRouter();
    const response = await openrouter.embeddings.create({
      model,
      input: texts,
      dimensions,
    });
    return response.data.map((d) => d.embedding);
  }

  return texts.map(() => Array(dimensions).fill(0));
}
