# App database credential storage

## Overview

Saved AI-provider OAuth credentials and MCP OAuth tokens/client secrets live in mouaif's app SQLite database, alongside the API keys already stored in app settings. New sign-ins no longer require an OS keychain or desktop Secret Service.

## Usage

Sign in as usual through **Settings → Providers** or **Settings → MCP**. Credentials survive server restarts and token refreshes. If a previous sign-in failed while saving to the keychain, start a new attempt; failed sign-ins did not save a usable credential.

The database is normally `~/.mouaif/store.sqlite`; `MOUAIF_HOME` selects another app home. **Credentials are not encrypted by mouaif.** Protect the database, its WAL/SHM sidecars, and backups like password files. On POSIX systems the app opens these database files with owner-only permissions (`0600`). Windows protection depends on the account's filesystem ACLs.

Existing API keys and provider settings are unchanged. This change concerns credential storage, not moving project files or MCP server configuration into the app DB.

## Migration and sign-out

Accessible legacy keychain credentials are copied into SQLite the first time they are used. Original keychain entries are preserved. If the old keychain is unavailable, sign in again; it is no longer needed to save new credentials.

Disconnect/sign-out clears the DB credential and records a tombstone so an old keychain entry cannot be imported again automatically. Signing in again replaces that tombstone. MCP client secrets retain their existing lifecycle: Disconnect preserves them, while clearing the secret, disabling OAuth, or deleting the server removes them from active storage.

## Behavior

- Credentials are isolated by provider/account or MCP project/server identity. They are not part of settings JSON returned by REST or native settings tools.
- Authorization and token-refresh behavior are unchanged. API keys remain in app settings; AI OAuth credentials and MCP OAuth secrets use a separate table in the same DB.
- AI credential writes and account-list changes are transactional. Database credential failures use the fixed `ECREDENTIALS` error category without including secrets in the message.
- The old keychain is used only to copy accessible legacy credentials; no new credential writes use it.
