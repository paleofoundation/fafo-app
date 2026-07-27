# FAFO Drive Proxy — Cloud Run Setup Guide
Paleo Certified, Inc. dba The Paleo Foundation

## What you need on your end (one-time, ~20 minutes)

### Step 1 — Google Cloud Project
1. Go to https://console.cloud.google.com
2. Create a new project (or use an existing one) — name it `fafo-proxy` or similar
3. Note your **Project ID** (shown in the top bar)

### Step 2 — Enable APIs
In your project, enable these two APIs (search in the API Library):
- **Cloud Run API**
- **Google Drive API**
- **Cloud Build API** (needed for deployment)

### Step 3 — Create a Service Account
1. Go to IAM & Admin → Service Accounts
2. Click "Create Service Account"
   - Name: `fafo-drive-proxy`
   - Description: FAFO App Drive access
3. Click "Create and Continue"
4. Skip role assignment for now → Done

### Step 4 — Give the Service Account Drive access
This is the key step — the service account needs access to your Drive folder.

1. Copy the service account's email address (looks like `fafo-drive-proxy@your-project.iam.gserviceaccount.com`)
2. Open Google Drive → find the **"1 - FAFO App"** folder
3. Right-click → Share → paste the service account email → set to **Editor** → Share

That's it. The proxy will now be able to create folders and upload files inside your FAFO App folder.

### Step 5 — Deploy to Cloud Run

Install the Google Cloud CLI if you haven't: https://cloud.google.com/sdk/docs/install

Then run these commands from the folder containing the 3 files (fafo-drive-proxy.js, package.json, Dockerfile):

```bash
# Authenticate
gcloud auth login

# Set your project
gcloud config set project YOUR_PROJECT_ID

# Deploy (replace YOUR_PROJECT_ID below)
gcloud run deploy fafo-drive-proxy \
  --source . \
  --region us-central1 \
  --service-account fafo-drive-proxy@YOUR_PROJECT_ID.iam.gserviceaccount.com \
  --set-env-vars CASES_FOLDER_ID=1IiHLmNCNjk0e8LZTF_1LaSxDaIiuf-PZ \
  --set-env-vars ALLOWED_ORIGIN=* \
  --allow-unauthenticated \
  --memory 256Mi \
  --min-instances 0 \
  --max-instances 2
```

**CASES_FOLDER_ID** is already set above — that's your existing "Cases" folder ID.

### Step 6 — Get your proxy URL
After deployment, Cloud Run will give you a URL like:
`https://fafo-drive-proxy-xxxxxxxxxx-uc.a.run.app`

Send that URL to me and I'll update the FAFO App to use it. That's the only thing I need from you.

### Step 7 — Test it
```bash
curl https://YOUR-PROXY-URL/health
# Should return: {"ok":true}
```

---

## Cost
Cloud Run has a generous free tier:
- 2 million requests/month free
- 360,000 vCPU-seconds free
- 180,000 GB-seconds free

For FAFO usage (a few file uploads per week), this will cost **$0/month** indefinitely.

---

## Files in this package
- `fafo-drive-proxy.js` — the proxy server
- `package.json` — Node.js dependencies
- `Dockerfile` — container config for Cloud Run
