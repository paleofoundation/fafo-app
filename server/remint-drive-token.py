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

import errno
import http.server
import json
import pathlib
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

# Must match an Authorized redirect URI on the OAuth client BYTE FOR BYTE.
# "http://localhost:8085/" and "http://localhost:8085" are different URIs to
# Google, and a mismatch fails as redirect_uri_mismatch with no hint as to
# which end is wrong. The trailing slash here matches what the client is
# actually registered with — do not "tidy" it without changing the Console to
# match, or the flow breaks.
#
# Note the neighbouring Console field, "Authorized JavaScript origins", rejects
# any path or trailing slash. That field is not used by this flow; pasting this
# value there produces a misleading "Invalid Origin" error.
PORT = 8085
REDIRECT_URI = f"http://localhost:{PORT}/"


def parse_redirect_override(argv: list[str]) -> tuple[str, int]:
    """
    Let the caller point the flow at a redirect URI that is ALREADY registered,
    instead of registering a new one. Google can take minutes to hours to
    propagate a newly added URI, so matching what the client already has is
    often the faster route than waiting.
    """
    if "--redirect-uri" not in argv:
        return REDIRECT_URI, PORT
    try:
        uri = argv[argv.index("--redirect-uri") + 1].strip()
    except IndexError:
        sys.exit("--redirect-uri needs a value, e.g. --redirect-uri http://localhost:9000")

    parsed = urllib.parse.urlparse(uri)
    try:
        given_port = parsed.port  # raises if the port is not an integer
    except ValueError:
        sys.exit(
            f"--redirect-uri has a non-numeric port: {uri}\n"
            "Substitute a real port number, e.g. --redirect-uri http://localhost:8085"
        )
    if parsed.scheme != "http" or parsed.hostname not in ("localhost", "127.0.0.1"):
        sys.exit(
            f"--redirect-uri must be an http loopback URI this script can listen on.\n"
            f"Got: {uri}"
        )
    if not given_port:
        sys.exit(f"--redirect-uri needs an explicit port, e.g. http://localhost:9000\nGot: {uri}")
    return uri, given_port

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
        code = (params.get("code") or [None])[0]
        error = (params.get("error") or [None])[0]

        # Ignore anything that is not the OAuth redirect. Browsers fetch
        # /favicon.ico straight after rendering the success page, and that
        # request carries no query string — capturing it unconditionally
        # overwrote the authorization code with None microseconds after
        # receiving it, so the exchange then ran with no code at all.
        if code is None and error is None:
            self.send_response(204)
            self.end_headers()
            return

        # First real redirect wins; a reload must not clobber a captured code.
        if CodeCatcher.code is None and CodeCatcher.error is None:
            CodeCatcher.code = code
            CodeCatcher.error = error

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
    redirect_uri, port = parse_redirect_override(sys.argv)
    env = service_env()
    client_id = env.get("GOOGLE_OAUTH_CLIENT_ID")
    client_secret = env.get("GOOGLE_OAUTH_CLIENT_SECRET")
    if not client_id or not client_secret:
        sys.exit("The service is missing GOOGLE_OAUTH_CLIENT_ID / _SECRET.")
    print(f"Using OAuth client {client_id[:28]}… (secret read from Cloud Run, not shown)")

    auth_url = "https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode(
        {
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": SCOPES,
            # offline + consent is what makes Google return a refresh token at all.
            "access_type": "offline",
            "prompt": "consent",
        }
    )

    # A previous run that never received its redirect keeps waiting, and keeps
    # the port. Bare EADDRINUSE traceback reads like a broken script rather than
    # "your last attempt is still open", so name the holder and offer the fix.
    try:
        server = http.server.HTTPServer(("127.0.0.1", port), CodeCatcher)
    except OSError as e:
        if e.errno != errno.EADDRINUSE:
            raise
        holder = subprocess.run(
            ["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-t"],
            capture_output=True,
            text=True,
        ).stdout.split()
        pids = " ".join(holder) or "(unknown)"
        sys.exit(
            f"\nPort {port} is already in use by PID {pids}.\n"
            "That is almost certainly an earlier run of this script still waiting for a\n"
            "redirect it never got. Stop it and try again:\n\n"
            f"    kill {pids}\n\n"
            "Nothing was changed."
        )
    threading.Thread(target=server.serve_forever, daemon=True).start()

    print("\nThis OAuth client must have this URI under **Authorized redirect URIs**:")
    print(f"    {redirect_uri}")
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
            f"\nadd {redirect_uri} under Authorized redirect URIs (not JavaScript"
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

    if not CodeCatcher.code:
        sys.exit(
            "\nThe redirect arrived but carried no authorization code. Nothing was changed."
        )
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
                        "redirect_uri": redirect_uri,
                        "grant_type": "authorization_code",
                    }
                ).encode(),
                method="POST",
            )
        ) as resp:
            tokens = json.load(resp)
    except urllib.error.HTTPError as e:
        sys.exit(
            f"Token exchange failed ({e.code}): {e.read().decode()[:400]}\n"
            "Nothing was changed — the service still has its old token."
        )

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

    verify()

ADC_PATH = pathlib.Path.home() / ".config" / "gcloud" / "application_default_credentials.json"


def via_gcloud() -> None:
    """
    Mint the refresh token through `gcloud auth application-default login`
    instead of this project's own OAuth client.

    Why this exists: the project's client is a Web-application client whose
    redirect URIs are editable only in the Cloud Console, and a newly added URI
    can take hours to propagate — so the normal flow can stay blocked on
    redirect_uri_mismatch through no fault of the operator. gcloud authorizes
    against Google's own client, which already trusts its loopback redirect,
    so there is nothing to register.

    Trade-off, stated plainly: this repoints the service at the gcloud CLI's
    OAuth client id/secret. Google's client is published rather than in Testing
    mode, so the refresh token stops expiring weekly — that is the upside. The
    downside is that the service no longer runs on a client you control. Prefer
    the default flow once the Console registration is sorted.
    """
    print("Minting a refresh token via gcloud's OAuth client (no Console work needed).")
    print("A browser will open — sign in as the Drive owner and click Allow.\n")
    result = subprocess.run(
        [
            "gcloud",
            "auth",
            "application-default",
            "login",
            f"--scopes={SCOPES.replace(' ', ',')}",
        ]
    )
    if result.returncode != 0:
        sys.exit("\ngcloud login did not complete. Nothing was changed.")

    if not ADC_PATH.exists():
        sys.exit(f"\nExpected credentials at {ADC_PATH}, but it is not there. Nothing was changed.")
    adc = json.loads(ADC_PATH.read_text())
    client_id = adc.get("client_id")
    client_secret = adc.get("client_secret")
    refresh_token = adc.get("refresh_token")
    if not (client_id and client_secret and refresh_token):
        sys.exit(
            "\nThose credentials have no refresh token — gcloud may have written a "
            "service-account or external-account file. Nothing was changed."
        )

    print("\nPushing the token AND gcloud's client id/secret to Cloud Run…")
    print("  (all three must move together — the token is only valid for its own client)")
    run(
        "gcloud",
        "run",
        "services",
        "update",
        SERVICE,
        f"--region={REGION}",
        f"--project={PROJECT}",
        "--update-env-vars="
        f"GOOGLE_REFRESH_TOKEN={refresh_token},"
        f"GOOGLE_OAUTH_CLIENT_ID={client_id},"
        f"GOOGLE_OAUTH_CLIENT_SECRET={client_secret}",
    )
    verify()


def verify() -> None:
    """Prove the service can actually write to Drive, rather than trusting the update."""
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
        print(f"\n✅ Drive export is working again.\n   Test doc: {url}\n   Delete it when you have confirmed.")
    except urllib.error.HTTPError as e:
        sys.exit(
            f"\n⚠️  Env vars updated, but the test write failed ({e.code}):\n"
            f"{e.read().decode()[:300]}\n"
            "Cloud Run may still be rolling out the new revision — wait a minute and retry."
        )


USAGE = """Re-mint the fafo-docs-mcp Google refresh token and push it to Cloud Run.

  python3 server/remint-drive-token.py --run     actually do it
  python3 server/remint-drive-token.py --help    this message

  --via-gcloud
        Skip this project's OAuth client entirely and mint the token through
        `gcloud auth application-default login`. Needs no Console changes and
        no redirect-URI registration. Repoints the service at gcloud's OAuth
        client id/secret, which is published rather than in Testing mode — so
        the weekly expiry stops too. See the docstring for the trade-off.

  --redirect-uri http://localhost:PORT
        Use a loopback URI the OAuth client ALREADY has registered, instead of
        the default http://localhost:8085. Faster than adding a new one, since
        Google can take minutes to hours to propagate a change.

Opens a browser for you to sign in as the Drive owner and click Allow.
Requires gcloud authenticated as an account with access to the Cloud Run service.
"""


def _cli() -> None:
    try:
        via_gcloud() if "--via-gcloud" in sys.argv else main()
    except KeyboardInterrupt:
        sys.exit("\nAborted. Nothing was changed.")


if __name__ == "__main__":
    # Explicit --run only. This script opens a browser and rewrites a production
    # env var; it must never fire from an accidental or exploratory invocation.
    if "--run" not in sys.argv:
        print(USAGE)
        sys.exit(0)
    _cli()
