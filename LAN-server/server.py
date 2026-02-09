from flask import Flask, request, Response, render_template, abort
import json
import time
import secrets

# leave empty/static to make session persistent
WEB_TOKEN = f"token_{secrets.token_urlsafe(16)}"

TABS = []  # list of tabs we want to control
SUBSCRIBERS = []  # subscribed background.js processes
TAB_SUBSCRIBERS = []  # subscriptions to UI

app = Flask(__name__)

ALLOWED_ACTIONS = {"play", "pause"}

# ---------------- UI ----------------

@app.route("/")
def ui():
    return render_template('web-ui.html', token=WEB_TOKEN)


# --------------- SECURITY ----------------

def require_token():
    if WEB_TOKEN and request.headers.get("X-API-Token") != WEB_TOKEN:
        print("Err: invalid token requested", request.headers.get("X-API-Token"))
        abort(403)
    return 'OK'


# --------------- TAB UPDATES ----------------

@app.route("/tabs", methods=["POST"])
def update_tabs():
    # todo: validate tabs response
    global TABS
    TABS = request.json

    msg = json.dumps({"type": "tabs", "tabs": TABS})
    for q in TAB_SUBSCRIBERS:
        q.append(msg)

    return "OK"


# --------------- COMMAND PUSH (SSE) - LAN ROUTES ----------------

def validate_cmd(data):
    try:
        if not isinstance(data, dict):
            return None

        action = data.get("action")
        tab_id = int(data.get("tabId"))

        if action in ("play", "pause"):
            return {"action": action, "tabId": tab_id}
        
    except (TypeError, ValueError):
        return None


@app.route("/cmd", methods=["POST"])
def cmd():
    require_token()
    data = request.json
    sanitized = validate_cmd(data)

    if not sanitized:
        print("Error: /cmd request not sanitized", data)
        abort(400)

    msg = json.dumps(sanitized)
    for q in SUBSCRIBERS:
        q.append(msg)
    return "OK"


@app.route("/events")
def events():
    def stream():
        q = []
        SUBSCRIBERS.append(q)
        try:
            while True:
                if q:
                    yield f"data: {q.pop(0)}\n\n"
                time.sleep(0.05)
        finally:
            SUBSCRIBERS.remove(q)

    return Response(stream(), mimetype="text/event-stream")


# --------------- TABS PUSH (SSE) - LOCAL ROUTES ----------------


@app.route("/tab-events")
def tab_events():
    def stream():
        q = []
        TAB_SUBSCRIBERS.append(q)
        try:
            # send initial state
            yield f"data: {json.dumps({'type':'tabs','tabs':TABS})}\n\n"

            while True:
                if q:
                    yield f"data: {q.pop(0)}\n\n"
                time.sleep(0.05)
        finally:
            TAB_SUBSCRIBERS.remove(q)

    return Response(stream(), mimetype="text/event-stream")


# ---------------- START ----------------

if __name__ == "__main__":
    # note: changing port requires update in the extension as well.
    app.run(host="0.0.0.0", port=5055, threaded=True)
