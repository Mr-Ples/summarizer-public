# WARNGING: THIS IS VIBE CODED

the repo is almost entirely vibe coded so use at own risk


Install the dependencies:

```bash
pnpm install
```

Copy the example creds/wrangler config files:
```bash
cp .dev.vars.example .dev.vars
cp wrangler.jsonc.example wrangler.jsonc
```

And fill in the missing env vars in both, all obtainable for free:

Blackblaze: https://www.backblaze.com/ for the B2 bucket credentials
Cloudflare for the rest



### Development

Run an initial database migration:

```bash
pnpm run db:generate
pnpm run db:migrate
```

Start the development server with HMR:

```bash
pnpm dev
```

## Building for Production

## Deployment

Deployment is done using the Wrangler CLI.

First, you need to create a d1 database in Cloudflare.

```sh
pnpm dlx wrangler d1 create <name-of-your-database>
```

You will also need to [update the `drizzle.config.ts` file](https://orm.drizzle.team/docs/guides/d1-http-with-drizzle-kit), and then run the production migration:

```sh
pnpm run db:migrate-production
```

To build and deploy directly to production:

```sh
pnpm run deploy
```

To deploy a preview URL:

```sh
pnpm run create-version
```
