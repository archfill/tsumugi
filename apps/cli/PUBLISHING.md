# Publishing `@archfill/tsumugi-cli`

Maintainer notes for publishing this package to npm. Users do not need to read this.

## One-time setup

### 1. npm account

Sign up at <https://www.npmjs.com/signup> with the username `archfill` (matches the scope `@archfill`).

Verify your email; npm requires it before publishing.

### 2. Enable 2FA (strongly recommended)

```bash
npm profile enable-2fa auth-and-writes
```

Without 2FA, leaked credentials are an immediate compromise. With 2FA, publishing requires an OTP each time.

### 3. Verify scope ownership

The `@archfill` scope is automatically yours if your npm username is `archfill`. No org creation needed.

If you ever want to publish under `@archfill` as an organization (so multiple maintainers can publish):

```bash
npm org create archfill
```

## Publishing

### 1. Bump the version

Edit `apps/cli/package.json`:

```jsonc
{
  "version": "0.1.0", // → "0.1.1" for patch, "0.2.0" for minor, etc.
}
```

Follow [semver](https://semver.org/):

- patch (`x.y.Z`): bugfix only
- minor (`x.Y.0`): new feature, backwards-compatible
- major (`X.0.0`): breaking change

### 2. Verify the tarball contents

```bash
cd apps/cli
npm pack --dry-run
```

You should see only `bin/cli.mjs`, `package.json`, `README.md`. Anything else means `files` in `package.json` is too loose.

### 3. Log in

```bash
npm login
# opens browser for OAuth
```

### 4. Publish

```bash
cd apps/cli
npm publish
# 2FA OTP prompt if enabled
```

The `publishConfig.access: "public"` in `package.json` makes this work without `--access public` each time.

### 5. Verify

```bash
npm view @archfill/tsumugi-cli
npx @archfill/tsumugi-cli --help
```

### 6. Tag the release in git

```bash
git tag cli-v0.1.0
git push origin cli-v0.1.0
```

(The tag prefix `cli-` distinguishes CLI releases from tsumugi server / plugin releases in the same monorepo.)

## After publishing

- A published version **cannot be modified**. Yank only as a last resort.
- `npm unpublish @archfill/tsumugi-cli@0.1.0` is only allowed within 72h and if no other package depends on it.
- For security issues, prefer publishing a fixed patch version (`0.1.1`) over unpublishing the broken one.

## Future automation

When ready, set up `.github/workflows/publish-cli.yml` triggered on `cli-v*` tag push. Steps:

1. Checkout
2. `pnpm install --filter @archfill/tsumugi-cli...`
3. `node --check apps/cli/bin/cli.mjs`
4. `npm publish` from `apps/cli/` with `NODE_AUTH_TOKEN` (use an automation token from npm, scoped to publish only)

This avoids needing to keep `npm login` state on a laptop and lets release happen from CI deterministically.
