"""
AirBridge - Local Wi-Fi file sharing between Android and Mac devices.
Run: python app.py
"""

import json
import os
import socket
import uuid
from datetime import datetime, timezone
from pathlib import Path

from flask import Flask, jsonify, render_template, request, send_file
from flask_socketio import SocketIO, emit, join_room, leave_room
import qrcode

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

BASE_DIR = Path(__file__).resolve().parent
UPLOADS_DIR = BASE_DIR / "uploads"
METADATA_FILE = UPLOADS_DIR / "metadata.json"
HISTORY_FILE = UPLOADS_DIR / "history.json"
MAX_FILE_SIZE = 100 * 1024 * 1024  # 100 MB per file
ALLOWED_EXTENSIONS = None  # Allow all file types

UPLOADS_DIR.mkdir(exist_ok=True)

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_FILE_SIZE * 10  # Allow batch uploads
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")

# In-memory registry of connected devices (device_id -> info)
connected_devices: dict[str, dict] = {}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def get_local_ip() -> str:
    """Return the machine's LAN IP address for QR codes and sharing."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"


def get_server_url() -> str:
    port = int(os.environ.get("PORT", 8765))
    return f"http://{get_local_ip()}:{port}"


def load_json(path: Path, default: dict | list) -> dict | list:
    if path.exists():
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            pass
    return default


def save_json(path: Path, data: dict | list) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)


def load_metadata() -> dict:
    return load_json(METADATA_FILE, {})


def save_metadata(data: dict) -> None:
    save_json(METADATA_FILE, data)


def load_history() -> list:
    return load_json(HISTORY_FILE, [])


def save_history(data: list) -> None:
    save_json(HISTORY_FILE, data)


def add_history_entry(entry: dict) -> None:
    history = load_history()
    history.insert(0, entry)
    history = history[:200]  # Keep last 200 entries
    save_history(history)


def allowed_file(filename: str) -> bool:
    if ALLOWED_EXTENSIONS is None:
        return True
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS


def format_size(size: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024:
            return f"{size:.1f} {unit}"
        size /= 1024
    return f"{size:.1f} TB"


def broadcast_files_update() -> None:
    """Notify all clients that the file list changed."""
    socketio.emit("files_updated", {"files": get_files_list()})


def get_files_list() -> list:
    metadata = load_metadata()
    files = []
    for file_id, info in metadata.items():
        stored_path = UPLOADS_DIR / info.get("stored_name", file_id)
        if stored_path.exists():
            files.append({
                "id": file_id,
                "name": info.get("name", file_id),
                "size": info.get("size", 0),
                "size_formatted": format_size(info.get("size", 0)),
                "uploaded_at": info.get("uploaded_at"),
                "device_name": info.get("device_name", "Unknown"),
                "password_protected": bool(info.get("password_hash")),
                "encrypted": info.get("encrypted", False),
            })
    files.sort(key=lambda x: x.get("uploaded_at", ""), reverse=True)
    return files


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/info")
def api_info():
    return jsonify({
        "server_url": get_server_url(),
        "local_ip": get_local_ip(),
        "max_file_size": MAX_FILE_SIZE,
        "max_file_size_formatted": format_size(MAX_FILE_SIZE),
        "device_count": len(connected_devices),
    })


@app.route("/api/qr")
def api_qr():
    """Generate a QR code SVG for the server URL."""
    import qrcode.image.svg

    url = get_server_url()
    factory = qrcode.image.svg.SvgPathImage
    qr = qrcode.QRCode(version=1, box_size=8, border=2, image_factory=factory)
    qr.add_data(url)
    qr.make(fit=True)
    img = qr.make_image(fill_color="black", back_color="white")

    from io import BytesIO
    buf = BytesIO()
    img.save(buf)
    buf.seek(0)
    return send_file(buf, mimetype="image/svg+xml")


@app.route("/api/files")
def api_files():
    return jsonify({"files": get_files_list()})


@app.route("/api/devices")
def api_devices():
    devices = [
        {
            "id": d["id"],
            "name": d["name"],
            "connected_at": d["connected_at"],
        }
        for d in connected_devices.values()
    ]
    return jsonify({"devices": devices})


@app.route("/api/upload", methods=["POST"])
def api_upload():
    """Handle single or multiple file uploads with optional password protection."""
    if "files" not in request.files:
        return jsonify({"error": "No files provided"}), 400

    files = request.files.getlist("files")
    device_name = request.form.get("device_name", "Unknown Device")
    password = request.form.get("password", "").strip()
    encrypted = request.form.get("encrypted") == "true"

    if not files or all(f.filename == "" for f in files):
        return jsonify({"error": "No files selected"}), 400

    metadata = load_metadata()
    uploaded = []
    errors = []

    for file in files:
        if not file or file.filename == "":
            continue

        if not allowed_file(file.filename):
            errors.append(f"{file.filename}: file type not allowed")
            continue

        # Read content to validate size
        content = file.read()
        if len(content) > MAX_FILE_SIZE:
            errors.append(
                f"{file.filename}: exceeds max size ({format_size(MAX_FILE_SIZE)})"
            )
            continue

        file_id = str(uuid.uuid4())
        stored_name = f"{file_id}_{file.filename}"
        stored_path = UPLOADS_DIR / stored_name

        try:
            with open(stored_path, "wb") as f:
                f.write(content)
        except OSError as e:
            errors.append(f"{file.filename}: failed to save ({e})")
            continue

        import hashlib
        password_hash = ""
        if password:
            password_hash = hashlib.sha256(password.encode()).hexdigest()

        entry = {
            "name": file.filename,
            "stored_name": stored_name,
            "size": len(content),
            "uploaded_at": datetime.now(timezone.utc).isoformat(),
            "device_name": device_name,
            "password_hash": password_hash,
            "encrypted": encrypted,
        }
        metadata[file_id] = entry
        uploaded.append({
            "id": file_id,
            "name": file.filename,
            "size": len(content),
            "size_formatted": format_size(len(content)),
        })

        add_history_entry({
            "action": "upload",
            "file_id": file_id,
            "file_name": file.filename,
            "device_name": device_name,
            "size": len(content),
            "timestamp": entry["uploaded_at"],
            "encrypted": encrypted,
        })

    save_metadata(metadata)
    broadcast_files_update()

    return jsonify({
        "uploaded": uploaded,
        "errors": errors,
        "success": len(uploaded) > 0,
    })


@app.route("/api/download/<file_id>")
def api_download(file_id):
    """Download a file; requires password if protected."""
    metadata = load_metadata()
    info = metadata.get(file_id)
    if not info:
        return jsonify({"error": "File not found"}), 404

    stored_path = UPLOADS_DIR / info.get("stored_name", file_id)
    if not stored_path.exists():
        return jsonify({"error": "File not found on disk"}), 404

    password_hash = info.get("password_hash", "")
    if password_hash:
        import hashlib
        provided = request.args.get("password", "")
        if hashlib.sha256(provided.encode()).hexdigest() != password_hash:
            return jsonify({"error": "Invalid password"}), 403

    device_name = request.args.get("device_name", "Unknown Device")
    add_history_entry({
        "action": "download",
        "file_id": file_id,
        "file_name": info.get("name"),
        "device_name": device_name,
        "size": info.get("size", 0),
        "timestamp": datetime.now(timezone.utc).isoformat(),
    })

    return send_file(
        stored_path,
        as_attachment=True,
        download_name=info.get("name", file_id),
    )


@app.route("/api/delete/<file_id>", methods=["DELETE"])
def api_delete(file_id):
    metadata = load_metadata()
    info = metadata.get(file_id)
    if not info:
        return jsonify({"error": "File not found"}), 404

    stored_path = UPLOADS_DIR / info.get("stored_name", file_id)
    if stored_path.exists():
        try:
            stored_path.unlink()
        except OSError:
            pass

    del metadata[file_id]
    save_metadata(metadata)
    broadcast_files_update()

    return jsonify({"success": True})


@app.route("/api/history")
def api_history():
    return jsonify({"history": load_history()})


# ---------------------------------------------------------------------------
# WebSocket events
# ---------------------------------------------------------------------------

@socketio.on("connect")
def on_connect():
    emit("connected", {"server_url": get_server_url()})


@socketio.on("register_device")
def on_register_device(data):
    """Client registers with a device name for the connected-devices list."""
    device_id = data.get("device_id") or str(uuid.uuid4())
    device_name = data.get("device_name", "Unknown Device")

    connected_devices[device_id] = {
        "id": device_id,
        "name": device_name,
        "connected_at": datetime.now(timezone.utc).isoformat(),
        "sid": request.sid,
    }
    join_room("airbridge")
    emit("device_registered", {"device_id": device_id})
    socketio.emit("devices_updated", {
        "devices": [
            {"id": d["id"], "name": d["name"], "connected_at": d["connected_at"]}
            for d in connected_devices.values()
        ]
    })


@socketio.on("disconnect")
def on_disconnect():
    for device_id, info in list(connected_devices.items()):
        if info.get("sid") == request.sid:
            del connected_devices[device_id]
            socketio.emit("devices_updated", {
                "devices": [
                    {"id": d["id"], "name": d["name"], "connected_at": d["connected_at"]}
                    for d in connected_devices.values()
                ]
            })
            break


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8765))
    url = f"http://{get_local_ip()}:{port}"
    print("\n" + "=" * 50)
    print("  AirBridge - Local File Sharing")
    print("=" * 50)
    print(f"  Server running at: {url}")
    print(f"  Open this URL on any device on the same Wi-Fi")
    print("=" * 50 + "\n")
    socketio.run(app, host="0.0.0.0", port=port, debug=False, allow_unsafe_werkzeug=True)
