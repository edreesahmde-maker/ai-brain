# AI Brain bridge for Krita (a Krita Python plugin). AI Brain copies it into Krita's pykrita folder,
# switches it on, and starts Krita with AIBRAIN_BRIDGE_PORT and AIBRAIN_BRIDGE_TOKEN set. Krita then
# listens on 127.0.0.1:<port> (this computer only). One JSON line per request:
#   {"token": "...", "id": 1, "cmd": "python", "code": "..."}   -> runs the code in Krita
#   {"token": "...", "id": 2, "cmd": "info"}                     -> version, open documents
# The code runs on Krita's main thread with `Krita` (and `app` = Krita.instance()) available.
# Krita started without those variables (from its own shortcut): the plugin does nothing.
import ast, contextlib, io, json, os, traceback

from krita import Krita, Extension

try:
    from PyQt5.QtNetwork import QHostAddress, QTcpServer
except ImportError:  # Krita 6
    from PyQt6.QtNetwork import QHostAddress, QTcpServer

PORT = int(os.environ.get("AIBRAIN_BRIDGE_PORT") or 0)
TOKEN = os.environ.get("AIBRAIN_BRIDGE_TOKEN") or ""
MAX_OUT = 200_000


class AIBrainBridge(Extension):
    def __init__(self, parent):
        super().__init__(parent)
        self.server = None
        self.buffers = {}
        self.ns = {"Krita": Krita, "__name__": "__aibrain__"}

    def setup(self):
        if not PORT or not TOKEN:
            return
        self.server = QTcpServer(self)
        local = QHostAddress(QHostAddress.LocalHost) if hasattr(QHostAddress, "LocalHost") else QHostAddress(QHostAddress.SpecialAddress.LocalHost)
        if not self.server.listen(local, PORT):
            print("AI Brain bridge: could not listen on port", PORT)
            return
        self.server.newConnection.connect(self.accept)
        print("AI Brain bridge listening on 127.0.0.1:%d" % PORT)

    def createActions(self, window):
        pass

    def accept(self):
        while self.server.hasPendingConnections():
            sock = self.server.nextPendingConnection()
            self.buffers[sock] = b""
            sock.readyRead.connect(lambda s=sock: self.read(s))
            sock.disconnected.connect(lambda s=sock: self.buffers.pop(s, None))

    def read(self, sock):
        buf = self.buffers.get(sock, b"") + bytes(sock.readAll())
        if len(buf) > 8 << 20:
            sock.abort()
            return
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            reply = self.handle(line.decode("utf-8", "replace"))
            sock.write((json.dumps(reply) + "\n").encode("utf-8"))
            sock.flush()
        self.buffers[sock] = buf

    def run(self, code):
        self.ns["app"] = Krita.instance()
        out = io.StringIO()
        result = None
        tree = ast.parse(code, "<ai-brain>", "exec")
        last = tree.body[-1] if tree.body and isinstance(tree.body[-1], ast.Expr) else None
        if last is not None:
            tree.body = tree.body[:-1]
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
            exec(compile(tree, "<ai-brain>", "exec"), self.ns)
            if last is not None:
                value = eval(compile(ast.Expression(last.value), "<ai-brain>", "eval"), self.ns)
                if value is not None:
                    result = repr(value)
        return out.getvalue(), result

    def info(self):
        app = Krita.instance()
        doc = app.activeDocument()
        return {
            "app": "krita", "version": app.version(),
            "documents": [{"name": d.name(), "file": d.fileName(), "width": d.width(), "height": d.height()} for d in app.documents()][:50],
            "active": doc.name() if doc else None,
        }

    def handle(self, line):
        try:
            req = json.loads(line)
        except Exception:
            return {"ok": False, "error": "bad request"}
        rid = req.get("id")
        if req.get("token") != TOKEN:
            return {"id": rid, "ok": False, "error": "wrong token"}
        try:
            if req.get("cmd") == "info":
                return {"id": rid, "ok": True, "result": self.info()}
            if req.get("cmd") == "python":
                output, result = self.run(str(req.get("code") or ""))
                return {"id": rid, "ok": True, "output": output[-MAX_OUT:], "result": result}
            return {"id": rid, "ok": False, "error": "unknown cmd"}
        except Exception:
            return {"id": rid, "ok": False, "error": traceback.format_exc()[-MAX_OUT:]}


Krita.instance().addExtension(AIBrainBridge(Krita.instance()))
