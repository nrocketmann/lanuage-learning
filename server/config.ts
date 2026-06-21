import dotenv from "dotenv";
import path from "node:path";

dotenv.config({ path: path.resolve(process.cwd(), "vars.env"), quiet: true });
dotenv.config({ path: path.resolve(process.cwd(), ".env"), override: false, quiet: true });

export const serverConfig = {
  host: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 8787),
  openAIKey: process.env.OPENAI_API_KEY ?? process.env.OPENAI_KEY ?? "",
  geminiApiKey: process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? "",
  vertexKey: process.env.VERTEX_KEY ?? process.env.VERTEX_API_KEY ?? "",
  vertexAccessToken: process.env.VERTEX_ACCESS_TOKEN ?? "",
  vertexProjectId: process.env.VERTEX_PROJECT_ID ?? process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT ?? "",
  vertexLocation: process.env.VERTEX_LOCATION ?? "us-central1",
  vertexUseGcloudAuth: process.env.VERTEX_USE_GCLOUD_AUTH === "true",
  vertexGcloudAccount: process.env.VERTEX_GCLOUD_ACCOUNT ?? "",
  vertexUseGcloudADC: process.env.VERTEX_USE_GCLOUD_ADC === "true",
  databasePath: process.env.DATABASE_PATH ?? path.resolve(process.cwd(), "data", "app.db")
};

export function requireOpenAIKey() {
  if (!serverConfig.openAIKey) {
    throw new Error("Missing OPENAI_API_KEY or OPENAI_KEY in vars.env");
  }
  return serverConfig.openAIKey;
}
