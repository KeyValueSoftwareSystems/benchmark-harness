import { Redis } from "ioredis";
import { REDIS_URL } from "./config.ts";

export const redis = new Redis(REDIS_URL);
