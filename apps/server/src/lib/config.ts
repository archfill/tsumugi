import process from "node:process";

export interface Config {
  databaseUrl: string;
  port: number;
  mode: "stdio" | "http";
  hfCache?: string;
}

export function loadConfig(argv: string[] = process.argv.slice(2)): Config {
  const mode = (
    argv.includes("--stdio")
      ? "stdio"
      : argv.includes("--http")
        ? "http"
        : process.env["TSUMUGI_MODE"] === "stdio"
          ? "stdio"
          : "http"
  ) as "stdio" | "http";

  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  return {
    databaseUrl,
    port: Number(process.env["PORT"] ?? 8000),
    mode,
    hfCache: process.env["HF_CACHE"],
  };
}
