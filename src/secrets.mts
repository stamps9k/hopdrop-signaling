import { readFileSync } from "node:fs";

export function load_secret_from_file(env_var_name: string): string {
  const secret_path = process.env[env_var_name];
  if (!secret_path) {
    throw new Error(`${env_var_name} is required`);
  }
  return readFileSync(secret_path, "utf-8").trim();
}
