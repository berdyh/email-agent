import OpenAI from "openai";
import { loadSettings } from "../config/settings.js";
import {
  VECTOR_DIMENSION,
  createLocalEmbeddingVector,
  createLocalEmbeddingVectors,
} from "../shared/vector.js";

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
  const { provider, model } = settings.embedding;
  const dimensions = VECTOR_DIMENSION;

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

  return createLocalEmbeddingVector(text, dimensions);
}

export async function generateEmbeddings(
  texts: string[],
): Promise<number[][]> {
  if (texts.length === 0) return [];

  const settings = await loadSettings();
  const { provider, model } = settings.embedding;
  const dimensions = VECTOR_DIMENSION;

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

  return createLocalEmbeddingVectors(texts, dimensions);
}
