import { mkdirSync } from "node:fs";
import path from "node:path";
import { DB_PATH } from "../config.ts";
import { openDb } from "./runs.ts";

mkdirSync(path.dirname(DB_PATH), { recursive: true });
/** The api's single runs database. */
export const db = openDb(DB_PATH);
