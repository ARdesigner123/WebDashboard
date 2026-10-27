# Operations Dashboard

A Django-based dashboard app with a local login page and demo data flow.

## Features
- Local username/password authentication
- Demo work-order data without external MES/BizLink dependency
- Django REST API endpoints for dashboard operations
- Browser login page served from the app root

## Quick start

1. Create and activate a virtual environment
2. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```
3. Start the app:
   ```bash
   python app.py
   ```
4. Open:
   ```text
   http://localhost:8080
   ```

## Deploy frontend to GitHub Pages and backend to Render

GitHub Pages publishes the static files in `public/`; the Pages artifact has
`public/index.html` at its website root. Django runs separately on Render and
uses Render PostgreSQL for persistent data.

1. Push this project to a GitHub repository. The Pages workflow publishes on
   pushes to `main` or `master`. If your default branch has another name, add it
   to `.github/workflows/pages.yml`.
2. In Render, choose **New → Blueprint**, connect the repository, and apply the
   configuration in `render.yaml`. This creates the web service and PostgreSQL
   database. Render generates `DJANGO_SECRET_KEY` for the service.
3. In the Render service's environment settings, set both `CORS_ALLOWED_ORIGINS`
   and `CSRF_TRUSTED_ORIGINS` to your GitHub Pages **origin**. For a project
   site such as `https://owner.github.io/repository/`, the origin is
   `https://owner.github.io` (no repository path). Save the changes and wait
   for Render to redeploy.
4. In `public/static/backend-config.js`, set
   `window.DASHBOARD_API_BASE_URL` to the Render service's HTTPS URL, for
   example `https://your-service.onrender.com`. This is a public URL, not a
   secret.
5. In GitHub, open **Settings → Pages**, select **GitHub Actions** as the build
   and deployment source, then push the change to the deployment branch. The
   Pages workflow will publish the site; open the Pages URL shown in the
   repository settings.

The Render blueprint currently uses its free service/database plans; check
Render's current limits and persistence/expiry policies before relying on it
for business data. The local SQLite database is not copied to Render. Existing
records need a separate, planned export/import if they should be retained.

### Important login and access-control limitation

The login flow creates a local user the first time a username and password are
entered. Usernames and passwords must each be at least 5 characters; passwords
must also contain a number and a special character. When the account service is
available, passwords are stored as Django password hashes. If it is unavailable,
the demo can fall back to an account saved in that browser's local storage; the
password is stored as a SHA-256 hash and will not sync to another browser or
device. Guest login is also browser-local. This demo flow is not an
invitation-only or company identity system, and several dashboard API endpoints
allow anonymous requests. Do not put confidential or production operational
data on this public deployment.

## Environment variables
Copy `.env.example` to `.env` and adjust values as needed.

## Login behavior
The login screen accepts a local username and password. The app creates or
reuses the Django user and logs them in through the app’s own authentication
flow when the service is available. If it is unavailable, the account is saved
in the current browser and will not sync to another device. The **Login as a
guest** button opens a browser-local demo session without requiring the
authentication service.

The WH WO Status list supports adding demo work orders and part numbers
directly. Demo records include generated quantities, customers, dates,
traveler cards, and work across WH, BB, and SI lines so the summary, category
pivots, and chart work without a connected MES database.
