# AI Brain bridge for Blender. AI Brain starts Blender with:
#   blender.exe --python <this file>
# and the environment variables AIBRAIN_BRIDGE_PORT and AIBRAIN_BRIDGE_TOKEN. Blender then listens on
# 127.0.0.1:<port> (this computer only). Each request is one JSON line:
#   {"token": "...", "id": 1, "cmd": "python", "code": "..."}   -> runs the code in Blender
#   {"token": "...", "id": 2, "cmd": "info"}                     -> Blender version, file, scene
# and gets one JSON line back: {"id": 1, "ok": true, "output": "...", "result": "..."}.
# The code runs on Blender's main thread (a timer), so it can use bpy freely and you see the result
# live. Without the right token nothing runs. Started without the variables, this file does nothing.
import ast, io, json, os, socket, sys, traceback, contextlib

try:
    import bpy
except ImportError:  # not inside Blender
    bpy = None

PORT = int(os.environ.get("AIBRAIN_BRIDGE_PORT") or 0)
TOKEN = os.environ.get("AIBRAIN_BRIDGE_TOKEN") or ""
MAX_OUT = 200_000

_server = None
_clients = {}   # socket -> bytes received so far
_ns = {}        # one namespace for the session, so variables survive between calls


def _run(code):
    """Runs code like a console: the value of a last expression is the result."""
    out = io.StringIO()
    result = None
    tree = ast.parse(code, "<ai-brain>", "exec")
    last = tree.body[-1] if tree.body and isinstance(tree.body[-1], ast.Expr) else None
    if last is not None:
        tree.body = tree.body[:-1]
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
        exec(compile(tree, "<ai-brain>", "exec"), _ns)
        if last is not None:
            value = eval(compile(ast.Expression(last.value), "<ai-brain>", "eval"), _ns)
            if value is not None:
                result = repr(value)
    return out.getvalue(), result


def _info():
    d = bpy.data
    scene = bpy.context.scene
    return {
        "app": "blender", "version": bpy.app.version_string, "file": d.filepath or "(not saved yet)",
        "dirty": d.is_dirty, "scene": scene.name, "frame": scene.frame_current,
        "frames": [scene.frame_start, scene.frame_end], "fps": scene.render.fps,
        "objects": [{"name": o.name, "type": o.type} for o in list(scene.objects)[:200]],
        "mode": bpy.context.mode,
    }


def _handle(line):
    try:
        req = json.loads(line)
    except Exception:
        return {"ok": False, "error": "bad request"}
    rid = req.get("id")
    if not TOKEN or req.get("token") != TOKEN:
        return {"id": rid, "ok": False, "error": "wrong token"}
    try:
        if req.get("cmd") == "info":
            return {"id": rid, "ok": True, "result": _info()}
        if req.get("cmd") == "python":
            output, result = _run(str(req.get("code") or ""))
            return {"id": rid, "ok": True, "output": output[-MAX_OUT:], "result": result}
        return {"id": rid, "ok": False, "error": "unknown cmd"}
    except Exception:
        return {"id": rid, "ok": False, "error": traceback.format_exc()[-MAX_OUT:]}


def _tick():
    """Runs a few times a second on Blender's main thread."""
    try:
        while True:  # new connections
            try:
                c, addr = _server.accept()
            except (BlockingIOError, socket.timeout):
                break
            if addr[0] != "127.0.0.1":
                c.close()
                continue
            c.setblocking(False)
            _clients[c] = b""
        for c in list(_clients):
            try:
                data = c.recv(1 << 20)
                if not data:
                    raise ConnectionError
                _clients[c] += data
            except BlockingIOError:
                pass
            except Exception:
                _clients.pop(c, None)
                c.close()
                continue
            buf = _clients.get(c, b"")
            if len(buf) > 8 << 20:  # a line longer than 8 MB: drop the connection
                _clients.pop(c, None)
                c.close()
                continue
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                reply = _handle(line.decode("utf-8", "replace"))
                c.setblocking(True)
                try:
                    c.sendall((json.dumps(reply) + "\n").encode("utf-8"))
                finally:
                    c.setblocking(False)
            _clients[c] = buf
    except Exception:
        traceback.print_exc()
    return 0.05


def start():
    global _server
    if bpy is None or not PORT or not TOKEN or _server is not None:
        return
    _server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    _server.bind(("127.0.0.1", PORT))
    _server.listen(4)
    _server.setblocking(False)
    _ns.update({"bpy": bpy, "__name__": "__aibrain__"})
    bpy.app.timers.register(_tick, first_interval=0.1, persistent=True)
    print(f"AI Brain bridge listening on 127.0.0.1:{PORT}")


start()
