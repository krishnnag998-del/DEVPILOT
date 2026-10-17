# DEVPILOT

## Authentication

Repository analysis has two required gates:

1. A DevPilot account through Firebase Email/Password or Google authentication.
2. A separate GitHub authorization that grants repository access to the server.

Configure Firebase with `VITE_FIREBASE_API_KEY`,
`VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`,
`VITE_FIREBASE_STORAGE_BUCKET`, `VITE_FIREBASE_MESSAGING_SENDER_ID`, and
`VITE_FIREBASE_APP_ID`. `VITE_FIREBASE_MEASUREMENT_ID` is optional. Enable the
Email/Password, Google, and GitHub providers in Firebase Authentication. For
Firebase GitHub sign-in, create a GitHub OAuth App and configure its Client ID
and Client Secret in the Firebase GitHub provider settings. Set that OAuth
App's callback URL to
`https://YOUR_FIREBASE_AUTH_DOMAIN/__/auth/handler`.

Repository access uses a separate GitHub OAuth App because it has a different
callback URL. Set that app's callback URL to
`https://YOUR_APP_ORIGIN/api/auth/callback`. For local development this is
usually `http://localhost:8443/api/auth/callback`. Configure its credentials as
server-only `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` environment values.

The GitHub access token is stored only in an HTTP-only, same-site server
session. Repository API and source requests pass through the authenticated
server proxy, preventing anonymous GitHub rate-limit exhaustion and enabling
authorized private repository access.

Groq explanations additionally require the server-only `GROQ_API_KEY`.
