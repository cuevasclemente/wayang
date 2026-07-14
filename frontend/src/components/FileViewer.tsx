import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
} from "react";
import { Save, Pencil, RefreshCw } from "lucide-react";
import {
  ApiError,
  fetchFsRead,
  isFsBinaryRead,
  isFsTextRead,
  isFsTooLarge,
  writeFsFile,
} from "../api/client";

interface FileViewerProps {
  path: string | null;
}

type MonacoEditorComponent = ComponentType<{
  height: string | number;
  language?: string;
  theme?: string;
  value?: string;
  defaultValue?: string;
  options?: Record<string, unknown>;
  onChange?: (value: string | undefined) => void;
  onMount?: (editor: unknown, monaco: unknown) => void;
}>;

type LoadState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "text"; text: string; sha256: string; name: string; size: number }
  | { kind: "binary"; dataB64: string; size: number; name: string }
  | { kind: "too_large"; size: number; name: string }
  | { kind: "error"; message: string };

function languageFromPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    py: "python",
    rs: "rust",
    go: "go",
    java: "java",
    c: "c",
    h: "c",
    cpp: "cpp",
    hpp: "cpp",
    cs: "csharp",
    rb: "ruby",
    php: "php",
    sh: "shell",
    bash: "shell",
    zsh: "shell",
    fish: "shell",
    md: "markdown",
    json: "json",
    yml: "yaml",
    yaml: "yaml",
    toml: "ini",
    ini: "ini",
    html: "html",
    css: "css",
    scss: "scss",
    sql: "sql",
    xml: "xml",
    lua: "lua",
  };
  return map[ext] ?? "plaintext";
}

export function FileViewer({ path }: FileViewerProps) {
  const [MonacoEditor, setMonacoEditor] =
    useState<MonacoEditorComponent | null>(null);
  const [state, setState] = useState<LoadState>({ kind: "idle" });
  const [editMode, setEditMode] = useState(false);
  const [draft, setDraft] = useState<string>("");
  const [saveMsg, setSaveMsg] = useState<string>("");
  const [saveConflict, setSaveConflict] = useState(false);
  const [saving, setSaving] = useState(false);

  const editorRef = useRef<unknown>(null);
  const vimAdapterRef = useRef<{ dispose: () => void } | null>(null);
  const statusBarRef = useRef<HTMLDivElement | null>(null);

  // Lazy-load Monaco only after a file is selected. This keeps the initial
  // app shell fast and avoids loading the large editor chunks on first paint.
  useEffect(() => {
    if (!path || MonacoEditor) return;
    let cancelled = false;
    import("@monaco-editor/react").then((mod) => {
      if (cancelled) return;
      setMonacoEditor(() => mod.default as unknown as MonacoEditorComponent);
    });
    return () => {
      cancelled = true;
    };
  }, [path, MonacoEditor]);

  // Fetch file when path changes
  useEffect(() => {
    if (!path) {
      setState({ kind: "idle" });
      setEditMode(false);
      setSaveConflict(false);
      return;
    }
    let cancelled = false;
    setState({ kind: "loading" });
    setEditMode(false);
    setSaveMsg("");
    setSaveConflict(false);
    fetchFsRead(path)
      .then((res) => {
        if (cancelled) return;
        if (isFsTooLarge(res)) {
          setState({ kind: "too_large", size: res.size, name: res.name });
        } else if (isFsBinaryRead(res)) {
          setState({
            kind: "binary",
            dataB64: res.data_b64,
            size: res.size,
            name: res.name,
          });
        } else if (isFsTextRead(res)) {
          setState({
            kind: "text",
            text: res.text,
            sha256: res.sha256,
            name: res.name,
            size: res.size,
          });
          setDraft(res.text);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          kind: "error",
          message:
            err instanceof ApiError ? `HTTP ${err.status}` : String(err),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  // Dispose vim adapter
  useEffect(() => {
    return () => {
      vimAdapterRef.current?.dispose();
      vimAdapterRef.current = null;
    };
  }, [path]);

  const handleMount = useCallback((editor: unknown) => {
    editorRef.current = editor;
    import("monaco-vim").then(({ initVimMode }) => {
      if (!editorRef.current || !statusBarRef.current) return;
      vimAdapterRef.current?.dispose();
      vimAdapterRef.current = initVimMode(
        editorRef.current as any,
        statusBarRef.current,
      ) as unknown as { dispose: () => void };
    });
  }, []);

  const handleSave = useCallback(async () => {
    if (!path || state.kind !== "text") return;
    setSaving(true);
    setSaveMsg("");
    try {
      const res = await writeFsFile(path, draft, state.sha256);
      setState({
        kind: "text",
        text: draft,
        sha256: res.sha256,
        name: state.name,
        size: res.size,
      });
      setSaveMsg("Saved");
      setSaveConflict(false);
      setTimeout(() => setSaveMsg(""), 1500);
    } catch (err) {
      if (err instanceof ApiError && err.status === 412) {
        setSaveConflict(true);
        setSaveMsg("File changed externally — reload to overwrite");
      } else {
        setSaveMsg(
          err instanceof ApiError ? `HTTP ${err.status}` : String(err),
        );
      }
    } finally {
      setSaving(false);
    }
  }, [path, state, draft]);

  const handleReload = useCallback(() => {
    if (!path) return;
    setState({ kind: "loading" });
    setSaveConflict(false);
    fetchFsRead(path)
      .then((res) => {
        if (isFsTextRead(res)) {
          setState({
            kind: "text",
            text: res.text,
            sha256: res.sha256,
            name: res.name,
            size: res.size,
          });
          setDraft(res.text);
          setSaveMsg("");
        }
      })
      .catch((err) => {
        setState({
          kind: "error",
          message:
            err instanceof ApiError ? `HTTP ${err.status}` : String(err),
        });
      });
  }, [path]);

  if (!path) {
    return (
      <div className="h-full flex items-center justify-center text-xs text-neutral-600">
        Select a file to view
      </div>
    );
  }

  if (state.kind === "loading" || state.kind === "idle") {
    return (
      <div className="h-full flex items-center justify-center text-xs text-neutral-500">
        Loading…
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="h-full flex items-center justify-center text-xs text-red-400">
        {state.message}
      </div>
    );
  }

  if (state.kind === "too_large") {
    return (
      <div className="h-full flex items-center justify-center text-xs text-neutral-500">
        File too large to display ({state.size.toLocaleString()} bytes)
      </div>
    );
  }

  if (state.kind === "binary") {
    return (
      <div className="h-full flex items-center justify-center text-xs text-neutral-500">
        Binary file, {state.size.toLocaleString()} bytes
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between px-3 py-2 border-b border-neutral-900 gap-2">
        <div className="text-xs font-mono text-neutral-400 truncate">{path}</div>
        <div className="flex items-center gap-2">
          {saveMsg ? (
            <span
              className={
                "text-[10px] " +
                (saveConflict ? "text-red-400" : "text-emerald-400")
              }
            >
              {saveMsg}
            </span>
          ) : null}
          {saveConflict ? (
            <button
              type="button"
              onClick={handleReload}
              className="flex items-center gap-1 rounded px-2 py-1 text-[10px] text-neutral-300 hover:bg-neutral-800"
            >
              <RefreshCw size={12} />
              Reload
            </button>
          ) : null}
          {editMode ? (
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={saving}
              className="flex items-center gap-1 rounded bg-neutral-100 px-2 py-1 text-[10px] font-medium text-neutral-900 hover:bg-white disabled:opacity-50"
            >
              <Save size={12} />
              {saving ? "Saving…" : "Save"}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setEditMode(true)}
              className="flex items-center gap-1 rounded px-2 py-1 text-[10px] text-neutral-300 hover:bg-neutral-800"
            >
              <Pencil size={12} />
              Edit
            </button>
          )}
        </div>
      </div>
      <div className="flex-1 min-h-0">
        {MonacoEditor ? (
          <MonacoEditor
            height="100%"
            language={languageFromPath(path)}
            theme="vs-dark"
            value={editMode ? draft : state.text}
            options={{
              readOnly: !editMode,
              minimap: { enabled: false },
              fontSize: 13,
              scrollBeyondLastLine: false,
              automaticLayout: true,
            }}
            onChange={(value) => {
              if (editMode) setDraft(value ?? "");
            }}
            onMount={handleMount}
          />
        ) : (
          <div className="h-full flex items-center justify-center text-xs text-neutral-500">
            Loading editor…
          </div>
        )}
      </div>
      <div
        ref={statusBarRef}
        className="border-t border-neutral-900 bg-neutral-950 px-3 py-1 text-[10px] font-mono text-neutral-400 min-h-[20px]"
      />
    </div>
  );
}