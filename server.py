from flask import Flask, request, Response, render_template, abort
import json
import time
import secrets


# Leave empty for party
WEB_TOKEN = f"token_{secrets.token_urlsafe(16)}"



TABS = [] # list of tabs we want to control
SUBSCRIBERS = [] # subscribed background.js processes 
TAB_SUBSCRIBERS = [] # subscriptions to UI

app = Flask(__name__)

# ---------------- UI ----------------

@app.route("/")
def ui():
    return render_template('web-ui.html', token=WEB_TOKEN)


# --------------- SECURITY ----------------

def require_token():
    if WEB_TOKEN and request.headers.get("X-API-Token") != WEB_TOKEN:
        print('Err: invalid token requested', request.headers.get("X-API-Token"))
        abort(403)

def require_local():
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
    require_local()
    global TABS
    TABS = request.json

    msg = json.dumps({"type": "tabs", "tabs": TABS})
    for q in TAB_SUBSCRIBERS:
        q.append(msg)

    return "OK"

# --------------- COMMAND PUSH (SSE) - LAN ROUTES ----------------

@app.route("/cmd", methods=["POST"])
def cmd():
    require_token()
    data = request.json
    msg = json.dumps(data)
    for q in SUBSCRIBERS:
        q.append(msg)
    return "OK"

@app.route("/events")
def events():
    require_local()
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
    require_local()
    
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