# OPTIM LeadFlow CRM — Netlify + Firebase real-time starter

This version replaces browser-only localStorage with Firebase Authentication and Cloud Firestore live snapshot syncing. Updates saved by one signed-in session can appear on other open sessions in real time.

## 1. Create Firebase project
1. Visit https://console.firebase.google.com/ and create a project.
2. Build → Authentication → Sign-in method → enable Email/Password.
3. Build → Firestore Database → create a database.
4. Project settings → General → Your apps → register a Web app. Copy its config into `firebase-config.js`.

## 2. Create the first admin account
The login ID is mapped to a Firebase email address:
- `admin` → `admin@optimcrm.app`
- `staff01` → `staff01@optimcrm.app`

In Firebase Authentication → Users → Add user, create `admin@optimcrm.app` with a strong password of your choice. Copy its UID. In Firestore create `profiles/{UID}` with fields:
- `id` (string): `admin`
- `name` (string): `Administrator`
- `role` (string): `Admin`

Sign in once as admin to initialize the shared CRM document. Do not use the old demo passwords.

## 3. Add staff accounts
For each staff member, add a Firebase Authentication user with email such as `staff01@optimcrm.app` and a unique password. Create `profiles/{UID}` with `id` (e.g. `staff01`), `name` (staff member name), and `role` (`Telecaller` or `Manager`). Also add that staff member to the CRM's shared `users` list so assignment/reporting can display them. The current Add Staff UI does not provision Firebase Auth accounts; create accounts through Firebase Console.

## 4. Firestore rules and security warning
Open Firestore → Rules, paste `firestore.rules`, and publish. **Important:** this is a functional real-time starter, not a hardened production security model. Because the current UI stores the dataset in one shared document, any authenticated staff user can technically modify more shared data than the UI exposes. Before importing real student personal data or using this with a live team, move writes to a trusted backend (e.g. Cloud Functions) and enforce per-role/per-lead authorization. Never put admin credentials in website code.

## 5. Deploy on Netlify
1. Keep `index.html`, `style.css`, `script.js`, `firebase-config.js`, and `firestore.rules` in the same folder.
2. Replace every placeholder in `firebase-config.js` with your real Firebase web-app config.
3. Go to https://app.netlify.com/drop and drag the folder or ZIP into the deploy area.
4. Test in two separate browsers/devices: make an update in one session and verify it appears in the other.

## Notes
- CSV import is supported; export Excel files as CSV first.
- Firebase web config is client-side config, not a secret. Security rules and account setup protect the data.
- I cannot publish it inside your Netlify account without your project/account access. This package gives you the site and setup files.
