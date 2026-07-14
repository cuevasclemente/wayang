import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Tree, type NodeApi, type NodeRendererProps } from "react-arborist";
import {
  ChevronRight,
  ChevronDown,
  File as FileIcon,
  Folder,
  FolderOpen,
  Eye,
  EyeOff,
  Link as LinkIcon,
} from "lucide-react";
import {
  ApiError,
  fetchFsTree,
  type FsEntry,
  type FsEntryType,
} from "../api/client";

interface FileTreeProps {
  selectedPath: string | null;
  onFileSelect: (path: string) => void;
}

interface Node {
  id: string;
  name: string;
  type: FsEntryType;
  children: Node[] | null;
}

function joinPath(parent: string, name: string): string {
  if (parent === "" || parent === ".") return name;
  return `${parent}/${name}`;
}

function entryToNode(parentPath: string, entry: FsEntry): Node {
  const id = joinPath(parentPath, entry.name);
  return {
    id,
    name: entry.name,
    type: entry.type,
    children: entry.type === "dir" ? null : [],
  };
}

function setChildren(nodes: Node[], id: string, children: Node[]): Node[] {
  return nodes.map((n) => {
    if (n.id === id) return { ...n, children };
    if (n.children && n.children.length > 0) {
      return { ...n, children: setChildren(n.children, id, children) };
    }
    return n;
  });
}

export function FileTree({ selectedPath, onFileSelect }: FileTreeProps) {
  const [roots, setRoots] = useState<Node[]>([]);
  const [showHidden, setShowHidden] = useState(false);
  const [error, setError] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [dims, setDims] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

  // Load root
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    fetchFsTree(".", showHidden)
      .then((tree) => {
        if (cancelled) return;
        setRoots(tree.entries.map((e) => entryToNode(".", e)));
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(
          err instanceof ApiError ? `HTTP ${err.status}` : String(err),
        );
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [showHidden]);

  // Track container size
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      setDims({ w: el.clientWidth, h: el.clientHeight });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const loadChildren = useCallback(
    async (node: Node) => {
      try {
        const tree = await fetchFsTree(node.id, showHidden);
        const loaded = tree.entries.map((e) => entryToNode(node.id, e));
        setRoots((prev) => setChildren(prev, node.id, loaded));
      } catch (err) {
        setError(
          err instanceof ApiError ? `HTTP ${err.status}` : String(err),
        );
      }
    },
    [showHidden],
  );

  const handleToggle = useCallback(
    (id: string) => {
      const findById = (nodes: Node[]): Node | null => {
        for (const n of nodes) {
          if (n.id === id) return n;
          if (n.children && n.children.length > 0) {
            const hit = findById(n.children);
            if (hit) return hit;
          }
        }
        return null;
      };
      const target = findById(roots);
      if (target && target.type === "dir" && target.children === null) {
        void loadChildren(target);
      }
    },
    [roots, loadChildren],
  );

  const handleActivate = useCallback(
    (node: NodeApi<Node>) => {
      if (node.data.type === "file") {
        onFileSelect(node.data.id);
      }
    },
    [onFileSelect],
  );

  const treeData = useMemo<Node[]>(() => {
    const sanitize = (nodes: Node[]): Node[] =>
      nodes.map((n) => ({
        ...n,
        children:
          n.children === null
            ? []
            : n.children.length > 0
              ? sanitize(n.children)
              : [],
      }));
    return sanitize(roots);
  }, [roots]);

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between px-3 py-2 border-b border-neutral-900">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
          Files
        </span>
        <button
          type="button"
          onClick={() => setShowHidden((v) => !v)}
          className="rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
          title={showHidden ? "Hide hidden files" : "Show hidden files"}
        >
          {showHidden ? <Eye size={14} /> : <EyeOff size={14} />}
        </button>
      </div>
      {error ? (
        <div className="px-3 py-2 text-xs text-red-400">{error}</div>
      ) : null}
      {loading ? (
        <div className="px-3 py-2 text-xs text-neutral-500">Loading…</div>
      ) : null}
      <div ref={containerRef} className="flex-1 min-h-0">
        {dims.w > 0 && dims.h > 0 ? (
          <Tree<Node>
            data={treeData}
            openByDefault={false}
            width={dims.w}
            height={dims.h}
            rowHeight={24}
            indent={16}
            onToggle={handleToggle}
            onActivate={handleActivate}
            selection={selectedPath ?? undefined}
            disableEdit
            disableDrag
            disableDrop
          >
            {FileTreeNode}
          </Tree>
        ) : null}
      </div>
    </div>
  );
}

function FileTreeNode({ node, style, dragHandle }: NodeRendererProps<Node>) {
  const isDir = node.data.type === "dir";
  const isSymlink = node.data.type === "symlink";
  const isSelected = node.isSelected;

  return (
    <div
      ref={dragHandle}
      style={style}
      onClick={() => {
        if (isDir) {
          node.toggle();
        } else {
          node.select();
          node.activate();
        }
      }}
      className={
        "flex items-center gap-1 px-2 text-xs cursor-pointer whitespace-nowrap " +
        (isSelected
          ? "bg-neutral-800 text-neutral-100"
          : "text-neutral-300 hover:bg-neutral-900")
      }
    >
      {isDir ? (
        node.isOpen ? (
          <ChevronDown size={12} className="shrink-0 text-neutral-500" />
        ) : (
          <ChevronRight size={12} className="shrink-0 text-neutral-500" />
        )
      ) : (
        <span className="inline-block w-3 shrink-0" />
      )}
      {isDir ? (
        node.isOpen ? (
          <FolderOpen size={14} className="shrink-0 text-sky-400" />
        ) : (
          <Folder size={14} className="shrink-0 text-sky-400" />
        )
      ) : isSymlink ? (
        <LinkIcon size={14} className="shrink-0 text-purple-400" />
      ) : (
        <FileIcon size={14} className="shrink-0 text-neutral-400" />
      )}
      <span className="truncate">{node.data.name}</span>
    </div>
  );
}