#!/usr/bin/env python3
"""
Re-mint the Google refresh token that fafo-docs-mcp uses to write to Drive,
and push it to Cloud Run.

Why this exists: while the OAuth consent screen sits in Testing mode, Google
expires the service's refresh token about every 7 days. Drive exports then fail
with `invalid_grant` until a new token is minted. Publishing the consent screen
to Production is the real fix (see README below); this script is what you run
either way — publishing does not revive an already-dead token.

You never paste a secret. The OAuth client id and secret are read from the
deployed service with your own gcloud credentials, and neither the secret nor
the new refresh token is printed.

Usage:  python3 server/remint-drive-token.py --run
"""

from __future__ import annotations

import http.server
import json
import subprocess
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
import webbrowser

PROJECT = "project-b0292460-be69-4b2e-b3c"
REGION = "us-central1"
SERVICE = "fafo-docs-mcp"
SERVICE_URL = "https://fafo-docs-mcp-134533637471.us-central1.run.app"

# Must exactly match an Authorized redirect URI on the OAuth client.
#
# No trailing slash, deliberately. Google's Console rejects a path or trailing
# slash in the *Authorized JavaScript origins* field, so a slashed value fails
# confusingly when pasted into the wrong box — and the two fields sit next to
# each other. This form is accepted by both, and Google still routes the
# redirect to "/", which the handler answers regardless of path.
PORT = 8085
REDIRECT_URI = f"http://localhost:{PORT}"

SCOPES = " ".join(
    [
        "https://www.googleapis.com/auth/drive",
        "https://www.googleapis.com/auth/documents",
    ]
)


def run(*args: str) -> str:
    result = subprocess.run(args, capture_output=True, text=True)
    if result.returncode != 0:
        sys.exit(f"command failed: {' '.join(args)}\n{result.stderr.strip()}")
    return result.stdout.strip()


def service_env() -> dict[str, str]:
    """Read the deployed service's env vars via gcloud, so no secret is pasted."""
    raw = run(
        "gcloud",
        "run",
        "services",
        "describe",
        SERVICE,
        f"--region={REGION}",
        f"--project={PROJECT}",
        "--format=json",
    )
    containers = json.loads(raw)["spec"]["template"]["spec"]["containers"]
    return {e["name"]: e.get("value", "") for e in containers[0].get("env", [])}


# Signalled by the handler the moment Google redirects back, so the main thread
# blocks on an event instead of spinning a core in a bare `while: pass` loop.
GOT_REDIRECT = threading.Event()


class CodeCatcher(http.server.BaseHTTPRequestHandler):
    """Single-shot listener that captures the ?code= Google redirects back with."""

    code: str | None = None
    error: str | None = None

    def do_GET(self) -> None:  # noqa: N802 (stdlib signature)
        params = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        CodeCatcher.code = (params.get("code") or [None])[0]
        CodeCatcher.error = (params.get("error") or [None])[0]
        body = (
            b"<h2>FAFO: authorization received.</h2><p>You can close this tab.</p>"
            if CodeCatcher.code
            else b"<h2>FAFO: authorization failed.</h2><p>Check the terminal.</p>"
        )
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        GOT_REDIRECT.set()

    def log_message(self, *_args) -> None:
        pass  # keep the terminal clean


def main() -> None:
    env = service_env()
    client_id = env.get("GOOGLE_OAUTH_CLIENT_ID")
    client_secret = env.get("GOOGLE_OAUTH_CLIENT_SECRET")
    if not client_id or not client_secret:
        sys.exit("The service is missing GOOGLE_OAUTH_CLIENT_ID / _SECRET.")
    print(f"Using OAuth client {client_id[:28]}… (secret read from Cloud Run, not shown)")

    auth_url = "https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode(
        {
            "client_id": client_id,
            "redirect_uri": REDIRECT_URI,
            "response_type": "code",
            "scope": SCOPES,
            # offline + consent is what makes Google return a refresh token at all.
            "access_type": "offline",
            "prompt": "consent",
        }
    )

    server = http.server.HTTPServer(("127.0.0.1", PORT), CodeCatcher)
    threading.Thread(target=server.serve_forever, daemon=True).start()

    print("\nThis OAuth client must have this URI under **Authorized redirect URIs**:")
    print(f"    {REDIRECT_URI}")
    print("  Not the 'Authorized JavaScript origins' box above it — that is a")
    print("  different field and will not authorize this flow.")
    print(f"  https://console.cloud.google.com/apis/credentials?project={PROJECT}\n")
    print("Opening your browser. Sign in as the Drive owner and click Allow.")
    print(f"If it doesn't open, paste this URL:\n\n{auth_url}\n")
    webbrowser.open(auth_url)

    # On a redirect_uri_mismatch Google renders its own error page and never
    # redirects back, so nothing reaches the listener. Silence past this point
    # almost always means the URI above isn't registered — say so rather than
    # sitting for the full timeout looking like a hang.
    print("Waiting for the redirect… (Ctrl-C to abort)")
    if not GOT_REDIRECT.wait(timeout=45):
        print(
            "\nStill nothing after 45s. If the browser shows"
            ' "Error 400: redirect_uri_mismatch", that URI is not registered yet —'
            f"\nadd {REDIRECT_URI} under Authorized redirect URIs (not JavaScript"
            "\norigins), wait a minute for Google to propagate it, then re-run."
            "\n\nStill waiting in case you are mid sign-in…"
        )
        if not GOT_REDIRECT.wait(timeout=255):
            server.shutdown()
            sys.exit("\nTimed out with no redirect. Nothing was changed.")
    server.shutdown()

    if CodeCatcher.error:
        if CodeCatcher.error == "redirect_uri_mismatch":
            sys.exit(
                f"\nGoogle rejected the redirect URI.\n"
                f"Add exactly this to the OAuth client's Authorized redirect URIs:\n"
                f"  {REDIRECT_URI}\n"
                f"https://console.cloud.google.com/apis/credentials?project={PROJECT}"
            )
        sys.exit(f"\nAuthorization failed: {CodeCatcher.error}")

    print("Exchanging the code for a refresh token…")
    try:
        with urllib.request.urlopen(
            urllib.request.Request(
                "https://oauth2.googleapis.com/token",
                data=urllib.parse.urlencode(
                    {
                        "code": CodeCatcher.code,
                        "client_id": client_id,
                        "client_secret": client_secret,
                        "redirect_uri": REDIRECT_URI,
                        "grant_type": "authorization_code",
                    }
                ).encode(),
                method="POST",
            )
        ) as resp:
            tokens = json.load(resp)
    except urllib.error.HTTPError as e:
        sys.exit(f"Token exchange failed ({e.code}): {e.read().decode()[:300]}")

    refresh_token = tokens.get("refresh_token")
    if not refresh_token:
        sys.exit(
            "Google returned no refresh_token. That happens when the app was already\n"
            "authorized and prompt=consent was dropped. Revoke FAFO's access at\n"
            "https://myaccount.google.com/permissions and run this again."
        )

    print("Pushing the new token to Cloud Run (no rebuild)…")
    run(
        "gcloud",
        "run",
        "services",
        "update",
        SERVICE,
        f"--region={REGION}",
        f"--project={PROJECT}",
        f"--update-env-vars=GOOGLE_REFRESH_TOKEN={refresh_token}",
    )

    print("Verifying with a real document write…")
    try:
        with urllib.request.urlopen(
            urllib.request.Request(
                f"{SERVICE_URL}/create-doc",
                data=json.dumps(
                    {
                        "title": "FAFO token check — safe to delete",
                        "html": "<p>Token re-mint verification.</p>",
                    }
                ).encode(),
                headers={"Content-Type": "application/json"},
                method="POST",
            ),
            timeout=60,
        ) as resp:
            doc = json.load(resp)
        url = doc.get("editUrl") or doc.get("docUrl") or doc.get("url") or "(no url returned)"
        print(f"\n✅ Drive export is working again.\n   Test doc: {url}\n   Delete it when you've confirmed.")
    except urllib.error.HTTPError as e:
        sys.exit(
            f"\n⚠️  Token updated, but the test write failed ({e.code}):\n"
            f"{e.read().decode()[:300]}\n"
            "Cloud Run may still be rolling out the new revision — wait a minute and retry the export in FAFO."
        )


USAGE = """Re-mint the fafo-docs-mcp Google refresh token and push it to Cloud Run.

  python3 server/remint-drive-token.py --run     actually do it
  python3 server/remint-drive-token.py --help    this message

Opens a browser for you to sign in as the Drive owner and click Allow.
Requires gcloud authenticated as an account with access to the Cloud Run service.
"""

if __name__ == "__main__":
    # Explicit --run only. This script opens a browser and rewrites a production
    # env var; it must never fire from an accidental or exploratory invocation.
    if "--run" not in sys.argv:
        print(USAGE)
        sys.exit(0)
    main()
