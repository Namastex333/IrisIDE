"""Iris tracer. Runs a Python script and records what it does, from the outside.

    python iris_tracer.py --out TRACE.jsonl --root PROJECT_DIR -- SCRIPT [ARGS...]

The project's files are never touched. Calls, returns, arguments and exceptions in the project's own
code are observed with sys.monitoring (Python 3.12+). File, database, network and environment access
is observed with an audit hook. Everything is appended to TRACE.jsonl, one JSON object per line:

    start    the run began                              python, root, entry, traced, note?
    call     a project function was called              i, fn, line, from?, at?, p?, cls?, args?
    ret      ...and returned                            i, v
    new      an object of a project class was created   cls, from, at   (classes with no constructor of their own)
    io       a file, database, host or environment      op, target, access, from, at, rel?
             variable was used
    raise    an exception was raised                    x, fn, line, type, msg, i?, origin?, locals
    unwind   ...and left a function without being       fn, type, x?, i?
             caught there
    handled  ...and was caught                          x, fn?, line?
    wrapper  a project function turned out to be a      fn
             decorator's wrapper
    hot      a function was called so often that it     fn, calls
             is no longer watched
    counts   how many times branches have run so far    counts: [[from, to, times, cls], ...]
    end      the run finished                           exit, calls, counts, error?

`fn`, `from` and `cls` name code as "<path inside the project>::<qualified name>". `i` numbers a call,
`p` is the call it was made from, `x` numbers an exception, `t` is seconds since the run began.

This file has to stay valid on old Pythons (3.8+) so that it can explain that tracing needs 3.12.
"""

import atexit
import builtins
import json
import os
import reprlib
import sys
import threading
import time
import traceback
import types

try:
    import _thread
except ImportError:  # pragma: no cover
    _thread = None

TRACE_VERSION = 1
THIS_FILE = __file__

# Limits that keep a busy program from producing an enormous trace or slowing to a crawl.
DETAIL_CALLS = 30  # calls per function recorded with their arguments and return value
MAX_DETAIL_EVENTS = 60000  # detailed call records per run
MAX_RAISES = 300  # exceptions recorded with their local variables
MAX_IO_EVENTS = 2000
HOT_CALLS = 200000  # a function called more often than this stops being watched (about half a second of overhead)
MAX_TEXT = 160  # longest description of a value

# Folders that never hold the project's own code. Keep in step with IGNORED_DIRS in src/main/services/project.ts.
IGNORED_DIRS = frozenset(
    [".git", "__pycache__", ".venv", "venv", "env", "node_modules", ".pytest_cache", ".mypy_cache", ".idea", ".vscode", ".iris", "site-packages", "dist-packages"]
)
CONSTRUCTORS = ("__init__", "__new__", "__post_init__")
CODE_SUFFIXES = (".py", ".pyc", ".pyo", ".pyd", ".pyi", ".pyw", ".so", ".dll", ".pth")
QUIET_EXCEPTIONS = (SystemExit, GeneratorExit)  # ways of stopping, not errors
WATCHED_AUDITS = frozenset(["open", "sqlite3.connect", "socket.getaddrinfo", "http.client.connect"])
ARRAY_LIBRARIES = frozenset(["pandas", "numpy", "polars", "torch", "tensorflow", "xarray"])

CO_OPTIMIZED, CO_VARARGS, CO_VARKEYWORDS = 0x1, 0x4, 0x8
TRAVELLING = "travelling"
MISSING = object()

_REPR = reprlib.Repr()
_REPR.maxlevel = 3
_REPR.maxlist = _REPR.maxtuple = _REPR.maxset = _REPR.maxfrozenset = _REPR.maxdeque = _REPR.maxarray = _REPR.maxdict = 6
_REPR.maxstring = 120
_REPR.maxlong = 60
_REPR.maxother = MAX_TEXT


def describe(value):
    """A short description of a value. Never raises, whatever the value's own repr does."""
    try:
        kind = type(value)
        if (kind.__module__ or "").split(".")[0] in ARRAY_LIBRARIES and hasattr(value, "shape"):
            text = "<%s shape=%s>" % (kind.__name__, tuple(value.shape))
        else:
            text = _REPR.repr(value)
    except Exception:
        return "<%s: could not be shown>" % type(value).__name__
    return text if len(text) <= MAX_TEXT else text[:MAX_TEXT] + "..."


def message_of(error):
    try:
        text = str(error)
    except Exception:
        text = ""
    return text if len(text) <= 400 else text[:400] + "..."


class Writer(object):
    """Appends events to the trace file. A small background loop keeps the file current while the program runs."""

    def __init__(self, path):
        # backslashreplace: a value's description may hold characters that UTF-8 cannot encode.
        self._file = open(path, "w", encoding="utf-8", errors="backslashreplace", newline="\n")
        self._lock = threading.Lock()
        self._lines = []
        self._closed = False
        self.every_second = None  # called about once a second from the background loop
        if _thread is not None:
            # A raw thread: the program being run never sees it in threading.enumerate().
            _thread.start_new_thread(self._loop, ())

    def emit(self, event):
        line = json.dumps(event, separators=(",", ":"), ensure_ascii=False, default=str)
        with self._lock:
            self._lines.append(line)

    def flush(self):
        with self._lock:
            if self._lines and not self._file.closed:
                self._file.write("\n".join(self._lines) + "\n")
                self._file.flush()
            self._lines = []

    def _loop(self):
        ticks = 0
        while not self._closed:
            time.sleep(0.08)
            ticks += 1
            try:
                if ticks % 12 == 0 and self.every_second is not None:
                    self.every_second()
                self.flush()
            except Exception:
                pass

    def close(self):
        self._closed = True
        self.flush()
        with self._lock:
            self._file.close()


class CodeInfo(object):
    """What the tracer knows about one piece of project code (a function, a class body or a module)."""

    __slots__ = ("key", "kind", "calls", "constructor", "wrapper")


class Tracer(object):
    def __init__(self, root, trace_file, writer):
        self.writer = writer
        self.started = time.perf_counter()
        self.prefix = os.path.normcase(os.path.abspath(root)).rstrip(os.sep) + os.sep
        self.trace_file = os.path.normcase(os.path.abspath(trace_file))
        libraries = set()
        for name in ("prefix", "base_prefix", "exec_prefix", "base_exec_prefix"):
            value = getattr(sys, name, None)
            if value:
                folded = os.path.normcase(os.path.abspath(value)).rstrip(os.sep) + os.sep
                if not self.prefix.startswith(folded):
                    libraries.add(folded)
        self.libraries = tuple(libraries)

        self.paths = {}  # file name -> path inside the project, or None when it is not project code
        self.codes = {}  # id(code) -> CodeInfo, for project code only
        self.pinned = []  # the code objects themselves, so their ids stay unique
        self.plain_classes = {}  # class -> key if it is a project class with no constructor of its own, else None
        self.class_keys = {}  # class -> key if it is a project class, else None
        self.edges = {}  # (caller key, callee key, created class key) -> times
        self.reported = {}  # the same, as last written in a "counts" event
        self.open_calls = {}  # id(frame) -> call number, for calls recorded in detail
        self.wraps = {}  # (id(wrapper code), id(wrapped code)) -> bool
        self.pending = {}  # thread id -> [id(exception), number, TRAVELLING or where it was caught, recorded?]
        self.io_seen = set()
        self.environment_reads = {}  # code key -> environment variables noted for it

        self.main_thread = threading.get_ident()
        self.next_call = 0
        self.next_exception = 0
        self.total_calls = 0
        self.detail_left = MAX_DETAIL_EVENTS
        self.raises_left = MAX_RAISES
        self.problems = 0  # times the tracer itself tripped; reported at the end rather than disturbing the program
        self.active = False
        self.finished = False
        self.exit_code = 0
        self.failure = None
        self.tool = None
        self.local_events = 0
        self.disable = None

    def now(self):
        return round(time.perf_counter() - self.started, 6)

    # ---------- what counts as project code ----------

    def project_path(self, filename):
        """Where a source file sits inside the project ("pkg/mod.py"), or None if it is not the project's own code."""
        try:
            return self.paths[filename]
        except KeyError:
            pass
        relative = None
        if filename and filename[0] != "<":
            full = os.path.abspath(filename)
            folded = os.path.normcase(full)
            if folded.startswith(self.prefix) and not folded.startswith(self.libraries) and folded.endswith((".py", ".pyw")):
                parts = full[len(self.prefix) :].replace("\\", "/").split("/")
                if not any(part in IGNORED_DIRS for part in parts[:-1]):
                    relative = "/".join(parts)
        self.paths[filename] = relative
        return relative

    def learn(self, code):
        """Starts watching a piece of project code. Only call this for code that project_path() accepts."""
        info = CodeInfo()
        info.key = self.project_path(code.co_filename) + "::" + code.co_qualname
        info.calls = 0
        info.wrapper = False
        if code.co_name == "<module>":
            info.kind = "module"
        elif code.co_name == "__annotate__" or code.co_name.startswith("<generic parameters"):
            info.kind = "hidden"  # written by the compiler (lazy annotations, type parameters), not by the programmer
        elif not code.co_flags & CO_OPTIMIZED:
            info.kind = "class"  # the body of a class statement
        else:
            info.kind = "function"
        owner = code.co_qualname.rpartition(".")[0]
        info.constructor = info.kind == "function" and code.co_name in CONSTRUCTORS and owner != "" and not owner.endswith("<locals>")
        self.codes[id(code)] = info
        self.pinned.append(code)
        if info.kind in ("module", "function"):
            sys.monitoring.set_local_events(self.tool, code, self.local_events)
        return info

    def info_for(self, code):
        info = self.codes.get(id(code))
        if info is None and self.project_path(code.co_filename) is not None:
            info = self.learn(code)
        return info

    def class_key(self, cls):
        key = self.class_keys.get(cls, MISSING)
        if key is MISSING:
            module = sys.modules.get(getattr(cls, "__module__", None) or "")
            relative = self.project_path(getattr(module, "__file__", None) or "")
            key = None if relative is None else relative + "::" + getattr(cls, "__qualname__", cls.__name__)
            self.class_keys[cls] = key
        return key

    def plain_class_key(self, cls):
        """The key of a project class whose creation cannot be seen any other way: none of its constructors is project code."""
        key = self.plain_classes.get(cls, MISSING)
        if key is MISSING:
            key = self.class_key(cls)
            if key is not None:
                for name in CONSTRUCTORS:
                    code = getattr(getattr(cls, name, None), "__code__", None)
                    if code is not None and self.project_path(code.co_filename) is not None:
                        key = None  # seen when that constructor starts
                        break
            self.plain_classes[cls] = key
        return key

    # ---------- who called ----------

    def is_wrapper(self, frame, code, callee, info):
        """True if this frame is a decorator's wrapper calling the function it wraps."""
        pair = (id(code), id(callee))
        known = self.wraps.get(pair)
        if known is None:
            known = False
            try:
                values = frame.f_locals
                for name in code.co_freevars:
                    held = values.get(name)
                    held = getattr(held, "__func__", held)
                    if getattr(held, "__code__", None) is callee:
                        known = True
                        break
            except Exception:
                known = False
            self.wraps[pair] = known
            if known and not info.wrapper:
                info.wrapper = True
                self.writer.emit({"e": "wrapper", "fn": info.key})
        return known

    def caller_of(self, frame, callee):
        """The project code responsible for a call: the nearest project frame, looking through library
        frames and through the project's own decorator wrappers."""
        hops = 0
        while frame is not None and hops < 100:
            code = frame.f_code
            info = self.info_for(code)
            if info is not None and info.kind != "hidden":
                if info.kind == "function" and code.co_freevars and self.is_wrapper(frame, code, callee, info):
                    callee = code
                else:
                    return info, frame
            frame = frame.f_back
            hops += 1
        return None, None

    def created_class(self, frame, code, info):
        """For a constructor: the class being created, when it is a subclass of the one that defines the constructor."""
        if not code.co_argcount:
            return None
        first = frame.f_locals.get(code.co_varnames[0])
        key = self.class_key(first if isinstance(first, type) else type(first))
        return key if key is not None and key != info.key.rpartition(".")[0] else None

    def arguments(self, frame, code):
        count = code.co_argcount + code.co_kwonlyargcount
        if code.co_flags & CO_VARARGS:
            count += 1
        if code.co_flags & CO_VARKEYWORDS:
            count += 1
        shown = {}
        if count:
            values = frame.f_locals
            for index, name in enumerate(code.co_varnames[: min(count, 12)]):
                value = values.get(name, MISSING)
                if value is MISSING:
                    continue
                if index == 0 and name in ("self", "cls"):
                    shown[name] = "<%s>" % getattr(value if isinstance(value, type) else type(value), "__name__", "?")
                else:
                    shown[name] = describe(value)
        return shown

    def local_values(self, frame):
        shown = {}
        try:
            for name, value in list(frame.f_locals.items()):
                if name.startswith("__") or isinstance(value, (types.ModuleType, types.FunctionType, type)):
                    continue
                shown[name] = describe(value)
                if len(shown) >= 20:
                    break
        except Exception:
            pass
        return shown

    # ---------- sys.monitoring callbacks ----------
    # An exception escaping from one of these would land in the program being run, so each one keeps its own.

    def on_start(self, code, offset):
        try:
            info = self.codes.get(id(code))
            if info is None:
                if self.project_path(code.co_filename) is None:
                    return self.disable  # library code: never ask again
                info = self.learn(code)
            if info.kind == "class" or info.kind == "hidden":
                return self.disable  # a class body runs once, when the class is defined
            frame = sys._getframe(1)
            caller, caller_frame = self.caller_of(frame.f_back, code)
            caller_key = None if caller is None else caller.key
            created = self.created_class(frame, code, info) if info.constructor else None

            edge = (caller_key, info.key, created)
            seen = self.edges.get(edge, 0)
            self.edges[edge] = seen + 1
            info.calls += 1
            self.total_calls += 1

            detailed = info.calls <= DETAIL_CALLS and self.detail_left > 0
            if detailed or not seen:
                self.next_call += 1
                event = {"e": "call", "i": self.next_call, "t": self.now(), "fn": info.key, "line": code.co_firstlineno}
                if caller is not None:
                    event["from"] = caller_key
                    event["at"] = caller_frame.f_lineno
                    parent = self.open_calls.get(id(caller_frame))
                    if parent is not None:
                        event["p"] = parent
                if created is not None:
                    event["cls"] = created
                thread = threading.get_ident()
                if thread != self.main_thread:
                    event["th"] = thread
                if detailed:
                    self.detail_left -= 1
                    event["args"] = self.arguments(frame, code)
                    self.open_calls[id(frame)] = self.next_call
                self.writer.emit(event)
            elif self.open_calls:
                self.open_calls.pop(id(frame), None)  # a frame address being reused must not inherit an old call number

            if info.calls >= HOT_CALLS:
                self.writer.emit({"e": "hot", "t": self.now(), "fn": info.key, "calls": info.calls})
                sys.monitoring.set_local_events(self.tool, code, 0)
                return self.disable
        except Exception:
            self.problems += 1
        return None

    def on_return(self, code, offset, value):
        try:
            call = self.open_calls.pop(id(sys._getframe(1)), None)
            if call is not None:
                self.writer.emit({"e": "ret", "i": call, "t": self.now(), "v": describe(value)})
                return None
            info = self.codes.get(id(code))
            if info is not None and (info.calls > DETAIL_CALLS or self.detail_left <= 0):
                return self.disable  # this function's returns are no longer recorded
        except Exception:
            self.problems += 1
        return None

    def on_call(self, code, offset, target, arg0):
        """Fires at each place project code calls something. Only used to see objects of project classes
        being created when the class has no constructor of its own (a dataclass, say), then switched off."""
        try:
            if isinstance(target, type):
                key = self.plain_class_key(target)
                info = self.codes.get(id(code))
                if key is not None and info is not None:
                    edge = (info.key, key, None)
                    seen = self.edges.get(edge, 0)
                    self.edges[edge] = seen + 1
                    if not seen:
                        self.writer.emit({"e": "new", "t": self.now(), "cls": key, "from": info.key, "at": sys._getframe(1).f_lineno})
                    return None
        except Exception:
            self.problems += 1
        return self.disable

    # Exceptions. A "raise" event fires again in every function an exception passes through on its way up,
    # so each thread remembers the exception currently on the move. Only its id is kept, never the object,
    # so that tracing does not keep anything alive longer than the program would.

    def settle(self, thread):
        """Writes down that a thread's last exception was caught, if that is how it ended."""
        pending = self.pending.pop(thread, None)
        if pending is not None and pending[3] and pending[2] is not TRAVELLING:
            key, line, when = pending[2]
            event = {"e": "handled", "x": pending[1], "t": when}
            if key is not None:
                event["fn"] = key
                event["line"] = line
            self.writer.emit(event)

    def record_raise(self, thread, error, info, frame, traceback_end):
        self.next_exception += 1
        recorded = self.raises_left > 0
        self.pending[thread] = [id(error), self.next_exception, TRAVELLING, recorded]
        if not recorded:
            return
        self.raises_left -= 1
        event = {
            "e": "raise",
            "x": self.next_exception,
            "t": self.now(),
            "fn": info.key,
            "line": frame.f_lineno,
            "type": type(error).__name__,
            "msg": message_of(error),
        }
        call = self.open_calls.get(id(frame))
        if call is not None:
            event["i"] = call
        if traceback_end is not None and traceback_end.tb_frame is not frame:
            # It started inside a library that this function called.
            origin = traceback_end.tb_frame.f_code
            event["origin"] = "%s:%s" % (os.path.basename(origin.co_filename), origin.co_name)
        event["locals"] = self.local_values(frame)
        self.writer.emit(event)

    def on_raise(self, code, offset, error):
        try:
            end = error.__traceback__
            fresh = end is None or end.tb_next is None  # nothing below this function has seen it yet
            while end is not None and end.tb_next is not None:
                end = end.tb_next
            thread = threading.get_ident()
            pending = self.pending.get(thread)
            info = self.info_for(code)

            if not fresh and pending is not None and pending[0] == id(error):
                if pending[1] is None:
                    # Born inside a library; this is the first project function it reaches.
                    if info is not None:
                        self.record_raise(thread, error, info, sys._getframe(1), end)
                else:
                    pending[2] = TRAVELLING  # passing through the next function up, or raised again after being caught
                return None

            self.settle(thread)
            if isinstance(error, QUIET_EXCEPTIONS):
                return None
            if info is None:
                self.pending[thread] = [id(error), None, TRAVELLING, False]
            else:
                self.record_raise(thread, error, info, sys._getframe(1), end)
        except Exception:
            self.problems += 1
        return None

    def on_reraise(self, code, offset, error):
        # The end of a `finally`, a `with`, or an `except` that did not match: the exception carries on.
        try:
            pending = self.pending.get(threading.get_ident())
            if pending is not None and pending[0] == id(error):
                pending[2] = TRAVELLING
        except Exception:
            self.problems += 1
        return None

    def on_handled(self, code, offset, error):
        # Fires on entering any handler, including `finally` and `with`. It only counts as caught if no
        # re-raise follows, so it is written down later, by settle().
        try:
            pending = self.pending.get(threading.get_ident())
            if pending is not None and pending[0] == id(error) and code.co_filename != THIS_FILE:
                info = self.codes.get(id(code))
                pending[2] = (None if info is None else info.key, sys._getframe(1).f_lineno, self.now())
        except Exception:
            self.problems += 1
        return None

    def on_unwind(self, code, offset, error):
        try:
            info = self.codes.get(id(code))
            if info is None:
                return None
            call = self.open_calls.pop(id(sys._getframe(1)), None)
            pending = self.pending.get(threading.get_ident())
            number = pending[1] if pending is not None and pending[0] == id(error) and pending[3] else None
            if call is None and number is None:
                return None
            event = {"e": "unwind", "t": self.now(), "fn": info.key, "type": type(error).__name__}
            if call is not None:
                event["i"] = call
            if number is not None:
                event["x"] = number
            self.writer.emit(event)
        except Exception:
            self.problems += 1
        return None

    # ---------- files, databases, the network, environment variables ----------

    def owner(self, frame):
        """The project code that led to something outside the program being touched, or None when a library
        did it on its own account (importing a module, for one)."""
        hops = 0
        while frame is not None and hops < 150:
            code = frame.f_code
            if code.co_filename.startswith("<frozen importlib"):
                return None, None
            info = self.info_for(code)
            if info is not None and info.kind != "hidden":
                return info, frame
            frame = frame.f_back
            hops += 1
        return None, None

    def note_io(self, info, frame, op, target, access, relative=None):
        mark = (info.key, op, target, access)
        if mark in self.io_seen or len(self.io_seen) >= MAX_IO_EVENTS:
            return
        self.io_seen.add(mark)
        event = {"e": "io", "t": self.now(), "op": op, "target": target, "access": access, "from": info.key, "at": frame.f_lineno}
        if relative is not None:
            event["rel"] = relative
        self.writer.emit(event)

    def note_open(self, args, frame):
        path, mode, flags = args[0], args[1], args[2]
        if isinstance(path, int):
            return  # an already-open file descriptor
        full = os.path.abspath(os.fsdecode(path))
        folded = os.path.normcase(full)
        if folded == self.trace_file or folded.endswith(CODE_SUFFIXES) or folded.startswith(self.libraries):
            return
        if os.sep + "site-packages" + os.sep in folded or os.sep + "dist-packages" + os.sep in folded:
            return
        relative = None
        if folded.startswith(self.prefix):
            relative = full[len(self.prefix) :].replace("\\", "/")
            if any(part in IGNORED_DIRS for part in relative.split("/")[:-1]):
                return
        if isinstance(mode, str):
            writes = any(letter in mode for letter in "wax+")
        else:
            writes = isinstance(flags, int) and bool(flags & (os.O_WRONLY | os.O_RDWR | os.O_APPEND | os.O_CREAT | os.O_TRUNC))
        info, at = self.owner(frame)
        if info is not None:
            self.note_io(info, at, "open", full.replace("\\", "/"), "write" if writes else "read", relative)

    def on_audit(self, event, args):
        # Called for every audit event in the process, so the common case has to leave at once.
        if event not in WATCHED_AUDITS or not self.active:
            return
        try:
            frame = sys._getframe(1)
            if event == "open":
                self.note_open(args, frame)
                return
            if event == "sqlite3.connect":
                op, target = "sqlite", os.fsdecode(args[0]).replace("\\", "/")
            else:
                host = args[0] if event == "socket.getaddrinfo" else args[1]
                if isinstance(host, bytes):
                    host = host.decode("ascii", "replace")
                if not host:
                    return
                op, target = "net", str(host)
            info, at = self.owner(frame)
            if info is not None:
                self.note_io(info, at, op, target, "read")
        except Exception:
            self.problems += 1

    def note_environment(self, name, frame):
        """Called for every read of os.environ. Counts only when project code asked directly."""
        try:
            while frame is not None and frame.f_code.co_filename.startswith("<frozen "):
                frame = frame.f_back  # os.getenv() and the dict helpers it goes through
            if frame is None:
                return
            base = os.path.basename(frame.f_code.co_filename)
            while frame is not None and base in ("os.py", "_collections_abc.py"):
                frame = frame.f_back
                base = "" if frame is None else os.path.basename(frame.f_code.co_filename)
            info = None if frame is None else self.info_for(frame.f_code)
            if info is None:
                return
            # Copying the whole environment reads every variable; a handful of names is enough to say so.
            noted = self.environment_reads.get(info.key, 0)
            if noted < 5:
                self.environment_reads[info.key] = noted + 1
                self.note_io(info, frame, "env", str(name), "read")
        except Exception:
            self.problems += 1

    def watch_environment(self):
        kind = type(os.environ)
        original = kind.__getitem__
        tracer = self

        def __getitem__(self, key):
            if tracer.active:
                tracer.note_environment(key, sys._getframe(1))
            return original(self, key)

        try:
            kind.__getitem__ = __getitem__
        except Exception:
            self.problems += 1

    # ---------- start and finish ----------

    def start(self):
        monitoring = sys.monitoring
        events = monitoring.events
        for tool in (4, 3, 2, 1, 0, 5):
            if monitoring.get_tool(tool) is None:
                self.tool = tool
                break
        else:
            raise RuntimeError("every sys.monitoring tool slot is already in use")
        monitoring.use_tool_id(self.tool, "iris")
        self.disable = monitoring.DISABLE
        self.local_events = events.PY_RETURN | events.CALL
        monitoring.register_callback(self.tool, events.PY_START, self.on_start)
        monitoring.register_callback(self.tool, events.PY_RETURN, self.on_return)
        monitoring.register_callback(self.tool, events.CALL, self.on_call)
        monitoring.register_callback(self.tool, events.RAISE, self.on_raise)
        monitoring.register_callback(self.tool, events.RERAISE, self.on_reraise)
        monitoring.register_callback(self.tool, events.EXCEPTION_HANDLED, self.on_handled)
        monitoring.register_callback(self.tool, events.PY_UNWIND, self.on_unwind)
        monitoring.set_events(self.tool, events.PY_START | events.RAISE | events.RERAISE | events.EXCEPTION_HANDLED | events.PY_UNWIND)
        sys.addaudithook(self.on_audit)
        self.watch_environment()
        self.writer.every_second = self.write_counts
        self.active = True

    def changed_counts(self):
        try:
            current = list(self.edges.items())
        except RuntimeError:  # the dict changed size while being copied; the next tick will do
            return []
        changed = []
        for edge, times in current:
            if self.reported.get(edge) != times:
                self.reported[edge] = times
                changed.append([edge[0], edge[1], times, edge[2]])
        return changed

    def write_counts(self):
        changed = self.changed_counts()
        if changed:
            self.writer.emit({"e": "counts", "t": self.now(), "counts": changed})

    def finish(self):
        """Runs at interpreter exit, after the program's threads and its own exit handlers are done."""
        if self.finished:
            return
        self.finished = True
        self.active = False
        self.writer.every_second = None
        if self.tool is not None:
            try:
                sys.monitoring.set_events(self.tool, 0)
            except Exception:
                pass
        for thread in list(self.pending):
            if self.failure is not None and self.pending[thread][1] == self.failure.get("x"):
                continue  # the one that ended the run was not caught
            self.settle(thread)
        end = {
            "e": "end",
            "t": self.now(),
            "exit": self.exit_code,
            "calls": self.total_calls,
            "counts": [[edge[0], edge[1], times, edge[2]] for edge, times in list(self.edges.items())],
        }
        if self.failure is not None:
            end["error"] = self.failure
        if self.problems:
            end["problems"] = self.problems
        if self.detail_left <= 0 or self.raises_left <= 0:
            end["truncated"] = True
        self.writer.emit(end)
        self.writer.close()


def show_traceback(error):
    """Prints an uncaught exception the way Python would, without the tracer's own frames."""
    trace = error.__traceback__
    while trace is not None and trace.tb_frame.f_code.co_filename == THIS_FILE:
        trace = trace.tb_next
    traceback.print_exception(type(error), error, trace)


def run_script(script, arguments):
    """Runs the script as Python itself would run `python script.py arguments...`."""
    with open(script, "rb") as handle:
        source = handle.read()
    main_module = types.ModuleType("__main__")
    main_module.__file__ = script
    main_module.__builtins__ = builtins
    # Keep this module reachable: once it stops being __main__ nothing else refers to it.
    sys.modules["iris_tracer"] = sys.modules["__main__"]
    sys.modules["__main__"] = main_module
    sys.argv = [script] + list(arguments)
    script_dir = os.path.dirname(script)
    if not getattr(sys.flags, "safe_path", False):
        if sys.path and os.path.normcase(os.path.abspath(sys.path[0])) == os.path.normcase(os.path.dirname(os.path.abspath(THIS_FILE))):
            sys.path[0] = script_dir
        else:
            sys.path.insert(0, script_dir)
    exec(compile(source, script, "exec", dont_inherit=True), main_module.__dict__)


def parse_arguments(arguments):
    out = root = None
    index = 0
    while index < len(arguments):
        if arguments[index] == "--out" and index + 1 < len(arguments):
            out = arguments[index + 1]
            index += 2
        elif arguments[index] == "--root" and index + 1 < len(arguments):
            root = arguments[index + 1]
            index += 2
        elif arguments[index] == "--":
            index += 1
            break
        else:
            break
    rest = arguments[index:]
    if not out or not root or not rest:
        sys.stderr.write("usage: iris_tracer.py --out TRACE.jsonl --root PROJECT_DIR -- SCRIPT [ARGS...]\n")
        sys.exit(2)
    return out, root, rest[0], rest[1:]


def main():
    out, root, script, arguments = parse_arguments(sys.argv[1:])
    script = os.path.abspath(script)
    writer = Writer(out)
    tracer = Tracer(root, out, writer)
    atexit.register(tracer.finish)  # registered first, so it runs last

    version = "%d.%d.%d" % sys.version_info[:3]
    start = {"e": "start", "v": TRACE_VERSION, "python": version, "root": os.path.abspath(root), "entry": script, "traced": True}
    if sys.version_info < (3, 12) or not hasattr(sys, "monitoring"):
        start["traced"] = False
        start["note"] = "Tracing needs Python 3.12 or newer. This run used Python %s, so the tree could not light up." % version
    writer.emit(start)
    if start["traced"]:
        tracer.start()

    try:
        run_script(script, arguments)
    except SystemExit as stop:
        if stop.code is None:
            tracer.exit_code = 0
        elif isinstance(stop.code, int):
            tracer.exit_code = stop.code
        else:
            sys.stderr.write("%s\n" % (stop.code,))
            tracer.exit_code = 1
    except BaseException as error:
        tracer.active = False
        tracer.exit_code = 1
        tracer.failure = {"type": type(error).__name__, "msg": message_of(error)}
        pending = tracer.pending.get(threading.get_ident())
        if pending is not None and pending[0] == id(error) and pending[1] is not None:
            tracer.failure["x"] = pending[1]
        show_traceback(error)
    sys.exit(tracer.exit_code)


if __name__ == "__main__":
    main()
