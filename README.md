# Jinendra Vani Backend Dashboard

Mobile-first HTML/CSS/Vanilla JS Firebase Realtime Database administration dashboard.

## Files

- `index.html` — application shell and accessible UI markup.
- `styles.css` — responsive design system, dark/light/system themes, cards, tables, mobile views and dialogs.
- `app.js` — Firebase Auth + Realtime Database service layer, API client, CRUD modules, settings, validation, listeners and UI logic.

## Run

Use a static web server. Do not open the file with `file://` because browser module imports and Firebase authentication require a normal web origin.

Examples:

```bash
python3 -m http.server 8080
```

Then open `http://localhost:8080`.

## First-time setup

1. Open **Firebase setup**.
2. Paste the Firebase Web App configuration object from your Firebase project.
3. Set the Realtime Database paths to match the existing Jinendra Vani schema.
4. Keep **Require Firebase admin claim** enabled for production.
5. Save and sign in with an approved Firebase Authentication account.
6. Open Settings → Backend Configuration and enter the worker/API URL manually if the dashboard needs the backend API.

Firebase's current browser-module documentation uses the modular SDK and the `12.16.0` CDN release used here. Firebase web configuration is not a service-account private key; real access control must be enforced by Firebase Authentication and Realtime Database Security Rules.

## Important security notes

- No production Worker URL is hardcoded.
- No service-account private key or Firebase Admin credential is included.
- LocalStorage is used only for local configuration persistence; it is **not** treated as a secure secret vault.
- Frontend admin checks are only an additional UX/authorization layer. Your Firebase Realtime Database Rules must enforce the real authorization boundary.
- The recommended production configuration is an authenticated admin account with a server-issued Firebase custom claim such as `admin: true`, plus matching Realtime Database Rules.
- Deleting a user record from Realtime Database does not delete the Firebase Authentication account. Authentication-account deletion requires a privileged server-side/Admin SDK operation.
- Activity timestamps use Firebase `serverTimestamp()` where activity logging is enabled, rather than trusting the browser clock for the audit timestamp.

## Expected Realtime Database shape

The exact paths are configurable. A typical setup is:

```text
users/{uid}
questions/{questionId}
reports/{reportId}
activity/{activityId}
```

The dashboard intentionally does not require every record to contain every field. Unknown Firebase fields are rendered as escaped JSON in the user/report detail views.

## Backend API

The API client is centralized in `APIClient.request()` and reads the URL from LocalStorage. It validates the URL, uses `fetch`, enforces a timeout, handles non-2xx responses and safely handles malformed JSON. CRUD in this foundation uses Firebase Realtime Database directly because the actual Worker endpoint contract was not supplied; the backend URL is therefore a configurable service connection/test surface rather than a fake CRUD API.

## Firebase rules

Do not weaken production rules to make the UI work. If an operation is denied, fix the database rules and admin authorization instead of disabling security in the dashboard.

## Production hardening

For a deployed internal admin panel, serve over HTTPS, restrict Firebase Authentication methods to the intended admins, use strong Realtime Database Rules, consider App Check where appropriate, and deploy the Worker with server-side secrets only. The browser should never receive service-account credentials.


## Jinendra Vani Firebase Project

The dashboard is preconfigured for the Jinendra Vani Firebase Web app:

- Project ID: `jinendravani-main`
- Realtime Database: `jinendravani-main-default-rtdb.asia-southeast1.firebasedatabase.app`
- Web App ID: `1:243718724548:web:0aad8ffdc056b107eca291`

The Firebase Web configuration is not a service-account secret. Never add Firebase Admin SDK credentials, service-account private keys, or Worker/API secrets to the frontend.

The Worker/API URL is intentionally **not** bundled. Configure it under **Settings → Backend Configuration**; it is stored in `localStorage` under `jinendra_vani_dashboard_config`.

### Admin access

The default configuration requires a Firebase custom claim:

```json
{
  "admin": true
}
```

This claim must be assigned server-side using a trusted environment. Do not attempt to create or modify custom claims from browser JavaScript. Firebase Realtime Database Security Rules must independently enforce the same authorization boundary.


## Firebase configuration policy

The dashboard source does not contain the Firebase Web API key or any production Firebase configuration. On first launch, enter the Firebase Web config JSON in the setup screen. The complete config is stored locally under `jinendra_vani_dashboard_config` in the current browser. This is a local configuration mechanism, not a security boundary. Never put Firebase Admin service-account credentials, private keys, or backend secrets in the frontend.
