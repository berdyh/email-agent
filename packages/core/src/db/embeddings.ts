import OpenAI from "openai";
import { loadSettings } from "../config/settings.js";
import {
  VECTOR_DIMENSION,
  createLocalEmbeddingVector,
  createLocalEmbeddingVectors,
} from "../shared/vector.js";

let openaiClient: OpenAI | null = null;
let openrouterClient: OpenAI | null = null;

function requireEnvVar(name: string, provider: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Embedding provider "${provider}" requires the ${name} environment variable to be set`,
    );
  }
  return value;
}

function getOpenAI(): OpenAI {
  if (!openaiClient) {
    requireEnvVar("OPENAI_API_KEY", "openai");
    openaiClient = new OpenAI();
  }
  return openaiClient;
}

function getOpenRouter(): OpenAI {
  if (!openrouterClient) {
    const apiKey = requireEnvVar("OPENROUTER_API_KEY", "openrouter");
    openrouterClient = new OpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey,
    });
  }
  return openrouterClient;
}

export async function generateEmbedding(text: string): Promise<number[]> {
  const [vector] = await generateEmbeddings([text]);
  return vector ?? createLocalEmbeddingVector(text, VECTOR_DIMENSION);
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
