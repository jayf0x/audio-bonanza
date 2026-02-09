from flask import Flask, request, Response, render_template, abort
import json
import time
import secrets

WEB_TOKEN = f"token_{secrets.token_urlsafe(16)}"

TABS = []  # list of tabs we want to control
SUBSCRIBERS = []  # subscribed background.js processes
TAB_SUBSCRIBERS = []  # subscriptions to UI

app = Flask(__name__)

ALLOWED_ACTIONS = {"play", "pause", "setAudio"}
ALLOWED_STATE_KEYS = {"playbackRate", "reverbWetMix", "lowBandDecibels", "preservesPitch"}

# ---------------- UI ----------------

@app.route("/")
def ui():
    return render_template('web-ui.html', token=WEB_TOKEN)


# --------------- SECURITY ----------------

def require_token():
    if WEB_TOKEN and request.headers.get("X-API-Token") != WEB_TOKEN:
        print('Err: invalid token requested', request.headers.get("X-API-Token"))
        abort(403)

    # TODO: Want to verify extension and want to
    # we could store the local extension ID and then use it to verify the extension
    # host = request.environ.get('HTTP_HOST', None)
    # host = request.environ.get('HTTP_ORIGIN', None)

    # origin = request.environ.get('HTTP_ORIGIN', 'default value')
    # chrome-extension://

    # print(request.environ.get('HTTP_ORIGIN', 'default value'))
    # could use a cookie.. ubt that's overkill
    # if request.remote_addr not in ("127.0.0.1", "::1"):
    #     print('Err: denied remote:', request.remote_addr)
    #     abort(403)
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

def sanitize_state(state):
    if not isinstance(state, dict):
        return None

    sanitized = {}
    for key in ALLOWED_STATE_KEYS:
        if key not in state:
            continue
        value = state[key]
        if key == "preservesPitch":
            if isinstance(value, bool):
                sanitized[key] = value
        elif isinstance(value, (int, float)):
            sanitized[key] = float(value)

    return sanitized


def validate_cmd(data):
    if not isinstance(data, dict):
        return None

    action = data.get("action")
    if action not in ALLOWED_ACTIONS:
        return None

    tab_id = data.get("tabId")
    try:
        tab_id = int(tab_id)
    except (TypeError, ValueError):
        return None

    if action in ("play", "pause"):
        return {"action": action, "tabId": tab_id}

    if action == "setAudio":
        sanitized = sanitize_state(data.get("state", {}))
        if not sanitized:
            return None
        return {"action": action, "tabId": tab_id, "state": sanitized}

    return None


@app.route("/cmd", methods=["POST"])
def cmd():
    require_token()
    data = request.json
    sanitized = validate_cmd(data)

    print('/cmn', data)
    if not sanitized:
        print('Error: /cmn request not sanitized', data)
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
