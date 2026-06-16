import dotenv from "dotenv";
import path from "node:path";

dotenv.config({ path: path.resolve(process.cwd(), "vars.env") });
dotenv.config({ path: path.resolve(process.cwd(), ".env"), override: false });

export const serverConfig = {
  host: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 8787),
  openAIKey: process.env.OPENAI_API_KEY ?? process.env.OPENAI_KEY ?? "",
  databasePath: process.env.DATABASE_PATH ?? path.resolve(process.cwd(), "data", "app.db")
};

export function requireOpenAIKey() {
  if (!serverConfig.openAIKey) {
    throw new Error("Missing OPENAI_API_KEY or OPENAI_KEY in vars.env");
  }
  return serverConfig.openAIKey;
}
