import type { Config } from "drizzle-kit";
import { config } from 'dotenv';

// Load environment variables from .dev.vars
config({ path: '.dev.vars' });

export default {
  out: "./drizzle",
  schema: "./database/schema.ts",
  dialect: "sqlite",
  driver: "d1-http",
  dbCredentials: {
    databaseId: process.env.DATABASE_ID!,
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID!,
    token: process.env.CLOUDFLARE_API_KEY_DRIZZLE!,
  },
} satisfies Config;
