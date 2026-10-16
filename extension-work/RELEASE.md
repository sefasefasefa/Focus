# Chrome Web Store releases

Chrome updates extensions installed from the Chrome Web Store automatically
after a published update passes store review. The source must remain on its
existing Chrome Web Store item so its extension ID stays the same.

## One-time migration

The current `kur.bat` installs an unpacked folder. Chrome cannot silently
convert those installations to a Web Store installation. Existing users must
remove the unpacked copy and install the store listing once. Their local
extension data may not carry over to the store-installed copy; tell users to
export or save anything they need before switching. Native companion
installations may also need to be registered again with the Web Store extension
ID. After this migration, Chrome fetches approved releases automatically.

The initial store listing, privacy disclosures, and first submission must be
completed in the Chrome Web Store Developer Dashboard. Once the item is
published, later releases can use the API command below. The store may review
each update before distributing it.

## Create a release package

Set the extension's public, production HTTPS API origin in the environment:

```sh
EXTENSION_LICENSE_API_BASE_URL=https://your-license-api.example
```

Then build a ZIP suitable for the Chrome Web Store:

```sh
pnpm run extension:package
```

The archive is written to `generated-artifacts/extension-releases/`. The
packager substitutes the production API origin into the archive's `env.js`;
the development source remains unchanged. It excludes the native companion,
local metadata, documentation, and key/environment files.

## Automate later uploads

Enable the Chrome Web Store API in Google Cloud, create a service account, and
add its email under the Chrome Web Store Developer Dashboard account settings.
Keep its private key in Replit Secrets, never in the extension or repository.
Set these environment variables:

- `CWS_SERVICE_ACCOUNT_EMAIL` — service account email.
- `CWS_PUBLISHER_ID` — publisher ID from the Developer Dashboard.
- `CWS_EXTENSION_ID` — the published item's 32-character extension ID.
- `EXTENSION_LICENSE_API_BASE_URL` — public HTTPS API origin.
- `CWS_SERVICE_ACCOUNT_PRIVATE_KEY` — service-account private key, stored as a
  secret.

Increase `manifest.json`'s version for every release, then run:

```sh
pnpm run extension:publish
```

This packages the current extension, checks that its version is newer than the
published item, uploads it, and submits it for review. It does not bypass store
review or install the first version for existing users. Do not retry while an
upload or submission is pending; check the Developer Dashboard first.

See Google's current setup instructions:

- https://developer.chrome.com/docs/webstore/service-accounts
- https://developer.chrome.com/docs/webstore/using-api
