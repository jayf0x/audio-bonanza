from flask import Flask, request, Response, render_template, abort
import json
import time
import secrets



HOST = "0.0.0.0"
PORT = 5055
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

def require_web_token():
    if WEB_TOKEN:
      token = request.headers.get("X-API-Token")
      if token != WEB_TOKEN:
          abort(403)


# --------------- TAB UPDATES ----------------

@app.route("/tabs", methods=["POST"])
def update_tabs():
    global TABS
    TABS = request.json

    msg = json.dumps({"type": "tabs", "tabs": TABS})
    for q in TAB_SUBSCRIBERS:
        q.append(msg)

    return "OK"

# --------------- COMMAND PUSH (SSE) ----------------

@app.route("/cmd", methods=["POST"])
def cmd():
    require_web_token()
    data = request.json
    msg = json.dumps(data)
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


# --------------- TABS PUSH (SSE) ----------------

@app.route("/tab-events")
def tab_events():
    require_web_token()
    
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
    app.run(host="0.0.0.0", port=5055, threaded=True)