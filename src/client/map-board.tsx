'use client';

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  Background, BackgroundVariant, Handle, MarkerType, Position, ReactFlow,
  ReactFlowProvider, useReactFlow, type Node, type NodeProps, type Edge, type Viewport,
} from '@xyflow/react';
import {
  ArrowRight, BookOpen, Check, ChevronDown, Compass, ExternalLink, Focus,
  LoaderCircle, MessageCircle, Minus, Plus, RotateCcw, Search, ThumbsUp, X, GitBranch, Trash2,
} from 'lucide-react';
import type { MapNode, Resource } from '../../types/domain';
import { MapController, nodeRadius, safeResourceUrl, type MapView } from './map-controller';
import { ProgressStore, PROGRESS_KEY, progressId } from './learning-progress';
import { MapNavigation } from './map-navigation';
import '@xyflow/react/dist/style.css';

const levelNames = ['入门', '进阶', '深入'];
const stateNames = { pending: '等待资源', ready: '资源就绪', empty: '暂无资源', error: '加载失败', retrying: '正在重试' };
type KnowledgeData = {
  node: MapNode; expanded: boolean; mockMode: boolean; learned: boolean;
  drill?: (id: string) => void;
  open: (id: string) => void; retry: (id: string) => void;
};
type ResourceData = { resource: Resource; mockMode: boolean; order: number; mark: () => void };
type KnowledgeFlowNode = Node<KnowledgeData, 'knowledge'>;
type ResourceFlowNode = Node<ResourceData, 'resource'>;
type BoardNode = KnowledgeFlowNode | ResourceFlowNode;

interface CanvasMemory {
  positions: Map<string, { x: number; y: number }>;
  expanded?: string;
  viewport?: Viewport;
}
const freshMemory = (): CanvasMemory => ({ positions: new Map() });

function nodeElementId(id: string): string { return `knowledge-${encodeURIComponent(JSON.stringify(id))}`; }

function KnowledgeNode({ data }: NodeProps<KnowledgeFlowNode>) {
  const { node, expanded, open, retry } = data;
  const loading = node.state === 'pending' || node.state === 'retrying';
  const canRetry = (node.state === 'empty' || node.state === 'error') && node.error?.retryable !== false;
  const diameter = nodeRadius(node.weight) * 2;
  return <article className={`knowledge-node level-${node.level} state-${node.state}${data.learned ? ' is-learned' : ''}`}
    data-state={node.state} data-learned={data.learned}>
    <Handle type="target" position={Position.Left} />
    <div className="node-topline"><span>{levelNames[node.level - 1]}</span><span>{String(node.level).padStart(2, '0')}</span></div>
    <button id={nodeElementId(node.id)} className="node-open nodrag" type="button"
      aria-label={`${node.title}，${stateNames[node.state]}${data.learned ? '，已学' : ''}`} aria-expanded={expanded}
      onClick={() => open(node.id)} disabled={node.state === 'pending'}>
      <span className="node-orbit" style={{ width: diameter, height: diameter }} aria-hidden="true">
        {loading ? <LoaderCircle className="spin" size={26} /> :
          node.state === 'ready' ? <BookOpen size={27} strokeWidth={1.5} /> :
            node.state === 'empty' ? <Search size={26} /> : <RotateCcw size={26} />}
        <span>{node.resources.length.toString().padStart(2, '0')}</span>
        {data.learned && <span className="learned-badge"><Check size={16} /></span>}
      </span>
      <span className="node-title">{node.title}</span>
      <span className="node-summary">{node.summary}</span>
    </button>
    <div className="node-footer">
      <span>{data.learned ? '已学 · ' : ''}{stateNames[node.state]}</span>
      {data.drill && <button type="button" className="icon-button nodrag"
        title="以此为中心展开" aria-label={`下钻 ${node.title}`} onClick={() => data.drill?.(node.id)}>
        <GitBranch size={15} /></button>}
      {canRetry ? <button type="button" className="icon-button nodrag" aria-label={`重试 ${node.title}`} title="重试资源"
        onClick={() => retry(node.id)}><RotateCcw size={15} /></button> :
        <ChevronDown size={15} className={expanded ? 'expanded-chevron' : ''} aria-hidden="true" />}
    </div>
    <Handle type="source" position={Position.Right} />
  </article>;
}

function ResourceContent({ resource, mockMode, order, mark }: ResourceData) {
  const url = safeResourceUrl(resource.url, mockMode);
  return <>
    <div className="resource-eyebrow"><span>{mockMode ? '示例资源 · 非真实文章' : '来源：知乎'}</span><span>0{order + 1}</span></div>
    <h3>{resource.title}</h3>
    <p className="resource-author">{resource.author}</p>
    <div className="resource-bottom">
      <span title="赞同"><ThumbsUp size={13} />{resource.voteUpCount}</span>
      <span title="评论"><MessageCircle size={13} />{resource.commentCount}</span>
      {url ? <a className="resource-link nodrag" href={url} target="_blank" rel="noopener noreferrer"
        onClick={mark} onAuxClick={(event) => { if (event.button === 1) mark(); }}
        aria-label={`打开知乎原文：${resource.title}`} title="打开知乎原文"><ExternalLink size={16} /></a> :
        <span className="resource-disabled">{mockMode ? '仅供演示' : '链接不可用'}</span>}
    </div>
  </>;
}

function SatelliteNode({ data }: NodeProps<ResourceFlowNode>) {
  return <article className="satellite-node nodrag">
    <Handle type="target" position={Position.Left} />
    <ResourceContent {...data} />
  </article>;
}
const nodeTypes = { knowledge: KnowledgeNode, resource: SatelliteNode };

function ResourceDrawer({ node, mockMode, close, retry, mark, drill }: {
  node: MapNode; mockMode: boolean; close: () => void; retry: () => void;
  mark: () => void; drill?: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    const trigger = document.getElementById(nodeElementId(node.id));
    element.showModal();
    return () => { element.close(); trigger?.focus({ preventScroll: true }); };
  }, [node.id]);
  return <dialog ref={dialog} className="resource-drawer" aria-labelledby="drawer-title"
    onCancel={(event) => { event.preventDefault(); close(); }}
    onKeyDown={(event) => {
      if (event.key !== 'Tab') return;
      const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
        'button:not(:disabled), a[href], [tabindex="0"]',
      ));
      const first = items[0];
      const last = items.at(-1);
      if (!first || !last) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus();
      }
    }}
    onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
    <div className="drawer-heading"><div><p>学习资源</p><h2 id="drawer-title">{node.title}</h2></div>
      <button type="button" className="icon-button" autoFocus aria-label="关闭资源" title="关闭资源" onClick={close}><X /></button>
    </div>
    <p className="drawer-summary">{node.summary}</p>
    {node.resources.length ? node.resources.slice(0, 3).map((resource, order) =>
      <article className="drawer-resource" key={`${resource.contentType}:${resource.contentId}`}>
        <ResourceContent resource={resource} mockMode={mockMode} order={order} mark={mark} />
      </article>) : <p role="status">{node.state === 'empty' ? '社区暂无优质资料' : node.error?.message ?? stateNames[node.state]}</p>}
    {(node.state === 'empty' || node.state === 'error') && node.error?.retryable !== false &&
      <button className="text-button" type="button" onClick={retry}><RotateCcw size={16} />重试资源</button>}
    {node.state === 'retrying' && <p role="status">正在重试…</p>}
    {drill && <button type="button" className="text-button drawer-drill" onClick={drill}>
      <GitBranch size={16} />以此为中心展开</button>}
  </dialog>;
}

function Canvas({ view, controller, narrow, memory, completed, mark, drill }: {
  view: MapView; controller: MapController; narrow: boolean; memory: CanvasMemory;
  completed: string[]; mark: (nodeId: string) => void; drill?: (nodeId: string) => void;
}) {
  const flow = useReactFlow<BoardNode>();
  const [positions, setPositions] = useState(() => memory.positions);
  const [expanded, setExpanded] = useState<string | undefined>(memory.expanded);
  const fitOnce = useRef(!!memory.viewport);
  const [initial] = useState(() => {
    const rows = [0, 0, 0];
    return Object.fromEntries(view.nodes.map((node) => [
      node.id, { x: (node.level - 1) * 550, y: rows[node.level - 1]++ * 450 },
    ]));
  });
  const fit = () => {
    const points = view.nodes.map((node) => positions.get(node.id) ?? initial[node.id]);
    const left = Math.min(...points.map((point) => point.x)) - 35;
    const top = Math.min(...points.map((point) => point.y)) - 40;
    const right = Math.max(...points.map((point) => point.x)) + (narrow ? 235 : 485);
    const bottom = Math.max(...points.map((point) => point.y)) + 515;
    void flow.fitBounds({ x: left, y: top, width: right - left, height: bottom - top }, { padding: 0.08 });
  };
  const focusNode = (id?: string) => {
    if (id) requestAnimationFrame(() => document.getElementById(nodeElementId(id))?.focus({ preventScroll: true }));
  };
  const close = () => {
    const id = expanded; memory.expanded = undefined; setExpanded(undefined); focusNode(id);
  };
  const open = (id: string) => setExpanded((current) => {
    memory.expanded = current === id ? undefined : id;
    return memory.expanded;
  });
  const canDrill = (node: MapNode) => !!drill && node.title.trim().length <= 200 && (
    node.state === 'ready' || node.state === 'empty' || (node.state === 'error' && view.originalStatus === 'partial')
  );
  const nodes = useMemo<BoardNode[]>(() => {
    const result: BoardNode[] = view.nodes.map((node) => ({
      id: node.id, type: 'knowledge', position: positions.get(node.id) ?? initial[node.id],
      data: { node, expanded: expanded === node.id, mockMode: view.mockMode ?? true,
        learned: !!view.progressScope && completed.includes(progressId(view.topic, node.id, view.progressScope)),
        drill: canDrill(node) ? drill : undefined,
        open, retry: (id) => { void controller.retry(id); } },
      width: 200, height: 350, measured: { width: 200, height: 350 },
      style: { width: 200, height: 350 }, selectable: false, zIndex: 2,
      ariaLabel: node.title,
    }));
    const selected = view.nodes.find((node) => node.id === expanded);
    if (!narrow && selected) {
      const position = positions.get(selected.id) ?? initial[selected.id];
      selected.resources.slice(0, 3).forEach((resource, order) => {
        result.push({
          id: JSON.stringify(['resource', selected.id, order]), type: 'resource',
          position: { x: position.x + 235, y: position.y + order * 172 },
          data: { resource, order, mockMode: view.mockMode ?? true, mark: () => mark(selected.id) }, draggable: false,
          selectable: false, width: 230, height: 152, measured: { width: 230, height: 152 },
          style: { width: 230, height: 152, pointerEvents: 'all' }, zIndex: 3,
        });
      });
    }
    return result;
  }, [view.nodes, view.mockMode, positions, initial, expanded, narrow, controller, completed, mark, drill, view.progressScope, view.topic, view.originalStatus]);
  const edges = useMemo<Edge[]>(() => {
    const result: Edge[] = view.edges.map((edge, index) => ({
      id: `edge-${index}`, source: edge.from, target: edge.to, type: 'smoothstep',
      markerEnd: { type: MarkerType.ArrowClosed, color: edge.type === 'main' ? '#748579' : '#a5aba7' },
      style: { stroke: edge.type === 'main' ? '#748579' : '#a5aba7',
        strokeWidth: edge.type === 'main' ? 2 : 1, strokeDasharray: edge.type === 'branch' ? '5 5' : undefined },
    }));
    if (!narrow && expanded) {
      const node = view.nodes.find((node) => node.id === expanded);
      node?.resources.slice(0, 3).forEach((_, order) => {
        result.push({
          id: `satellite-edge-${order}`, source: expanded, target: JSON.stringify(['resource', expanded, order]),
          type: 'smoothstep', style: { stroke: '#aaa69d', strokeWidth: 1, strokeDasharray: '3 4' },
        });
      });
    }
    return result;
  }, [view.edges, view.nodes, expanded, narrow]);

  useEffect(() => {
    if (fitOnce.current || !view.mapId) return;
    const timer = setTimeout(() => {
      fitOnce.current = true;
      fit();
    }, 50);
    return () => clearTimeout(timer);
  }, [flow, view.mapId]);
  const selected = view.nodes.find((node) => node.id === expanded);

  return <section className="canvas-region" aria-label="知识地图">
    <div className="level-legend"><span className="legend-green">01 入门</span><span className="legend-blue">02 进阶</span><span className="legend-purple">03 深入</span></div>
    {narrow && <nav className="node-jump-list" aria-label="知识点资源">
      {view.nodes.map((node) => <button key={node.id} type="button"
        disabled={node.state === 'pending'} onClick={() => open(node.id)}
        aria-label={`查看 ${node.title} 资源`}>{node.title}</button>)}
    </nav>}
    <ReactFlow<BoardNode> nodes={nodes} edges={edges} nodeTypes={nodeTypes}
      defaultViewport={memory.viewport}
      onMoveEnd={(_event, viewport) => { memory.viewport = viewport; }}
      onNodesChange={(changes) => {
        setPositions((previous) => {
          const next = new Map(previous);
          for (const change of changes) if (change.type === 'position' && change.position) next.set(change.id, change.position);
          memory.positions = next;
          return next;
        });
      }}
      nodesConnectable={false} edgesFocusable={false} deleteKeyCode={null} minZoom={0.1} maxZoom={1.6}
      onlyRenderVisibleElements={false} panOnDrag onPaneClick={() => { if (!narrow) close(); }}
      onKeyDown={(event) => { if (event.key === 'Escape') close(); }}
      proOptions={{ hideAttribution: false }}>
      <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#c9ccc5" />
    </ReactFlow>
    <div className="canvas-controls" role="toolbar" aria-label="地图视图">
      <button type="button" className="icon-button" title="放大" aria-label="放大" onClick={() => { void flow.zoomIn(); }}><Plus size={18} /></button>
      <button type="button" className="icon-button" title="缩小" aria-label="缩小" onClick={() => { void flow.zoomOut(); }}><Minus size={18} /></button>
      <span />
      <button type="button" className="icon-button" title="适配视图" aria-label="适配视图"
        onClick={fit}><Focus size={19} /></button>
    </div>
    {selected && !narrow && <aside className="selection-bar" aria-live="polite">
      <strong>{selected.title}</strong>
      <span>{selected.state === 'empty' ? '社区暂无优质资料' :
        selected.error?.message ?? `${selected.resources.length} 条${view.mockMode ? '示例' : '学习'}资源`}</span>
      <button type="button" className="icon-button" title="收起资源" aria-label="收起资源" onClick={close}><X size={17} /></button>
    </aside>}
    {selected && narrow && <ResourceDrawer node={selected} mockMode={view.mockMode ?? true} close={close}
      mark={() => mark(selected.id)} drill={canDrill(selected) ? () => drill?.(selected.id) : undefined}
      retry={() => { void controller.retry(selected.id); }} />}
  </section>;
}

export default function MapBoard() {
  const [navigation] = useState(() => new MapNavigation());
  const controller = useSyncExternalStore(navigation.subscribe, navigation.snapshot, navigation.snapshot);
  const view = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
  const [progress] = useState(() => new ProgressStore());
  const learning = useSyncExternalStore(progress.subscribe, progress.snapshot, progress.snapshot);
  const [storageNotice, setStorageNotice] = useState('');
  const memories = useRef(new Map<string, CanvasMemory>());
  const viewKey = `${view.drilldown ? `child-${navigation.childKey()}` : 'parent'}:${view.requestId}`;
  if (!memories.current.has(viewKey)) memories.current.set(viewKey, freshMemory());
  const memory = memories.current.get(viewKey)!;
  const [input, setInput] = useState('');
  const [narrow, setNarrow] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const busy = view.phase === 'loading' || view.phase === 'streaming';
  useEffect(() => {
    const query = matchMedia('(max-width: 700px)');
    const update = () => setNarrow(query.matches);
    update();
    query.addEventListener('change', update);
    const leave = () => navigation.cancel();
    window.addEventListener('pagehide', leave);
    return () => { query.removeEventListener('change', update); window.removeEventListener('pagehide', leave); navigation.cancel(); };
  }, [navigation]);
  useEffect(() => {
    progress.restore();
    const sync = (event: StorageEvent) => { if (event.key === PROGRESS_KEY || event.key === null) progress.restore(); };
    window.addEventListener('storage', sync);
    const topic = new URL(window.location.href).searchParams.get('topic');
    if (topic) { setInput(topic); void navigation.load(topic); }
    return () => window.removeEventListener('storage', sync);
  }, [navigation, progress]);
  const load = (topic: string) => {
    setInput(topic);
    if (topic.trim() && topic.trim().length <= 200) {
      const url = new URL(window.location.href);
      url.searchParams.set('topic', topic.trim());
      window.history.replaceState(null, '', url);
      memories.current.clear();
    }
    void navigation.load(topic);
  };
  const mark = (nodeId: string) => {
    if (!view.progressScope || view.mockMode !== false) return;
    const node = view.nodes.find((node) => node.id === nodeId);
    if (!node?.resources.some((resource) => safeResourceUrl(resource.url, false))) return;
    progress.mark(progressId(view.topic, nodeId, view.progressScope));
  };
  const learnedCount = view.progressScope ? view.nodes.filter((node) =>
    learning.completedNodeIds.includes(progressId(view.topic, node.id, view.progressScope))).length : 0;
  const back = () => {
    for (const key of memories.current.keys()) if (key.startsWith('child-')) memories.current.delete(key);
    navigation.back();
    setInput(navigation.parent.snapshot().topic);
  };
  const reload = () => {
    if (view.drilldown) {
      for (const key of memories.current.keys()) if (key.startsWith('child-')) memories.current.delete(key);
      void controller.load(view.drilldown.topic, view.drilldown);
    } else load(view.topic || input);
  };
  const errors = view.nodes.filter((node) => node.state === 'error').length;
  const settled = view.nodes.filter((node) => !['pending', 'retrying'].includes(node.state)).length;

  return <main className="map-app">
    <header className="app-header">
      <a className="brand" href="/" aria-label="知径首页"><Compass size={25} strokeWidth={1.7} /><strong>知径</strong><span>知识白板</span></a>
      <form className="topic-form" onSubmit={(event) => { event.preventDefault(); load(input); }}>
        <Search size={17} aria-hidden="true" />
        <label className="sr-only" htmlFor="topic">学习话题</label>
        <input ref={inputRef} id="topic" value={input} maxLength={200} placeholder="输入一个想学的话题"
          onChange={(event) => setInput(event.target.value)} autoComplete="off" />
        <button type="submit" className="submit-button" disabled={busy && input.trim() === view.topic}
          aria-label={busy ? '切换学习话题' : '生成地图'} title="生成地图"><ArrowRight size={19} /></button>
      </form>
      <button className="reload-button" type="button" disabled={!view.topic || busy}
        onClick={reload}><RotateCcw size={15} />重新加载</button>
    </header>
    <nav className="topic-shortcuts" aria-label="话题快捷入口">
      <span>探索话题</span>
      {['微积分', 'Python 入门', '摄影'].map((topic) =>
        <button type="button" key={topic} aria-pressed={view.topic === topic}
          disabled={busy && view.topic === topic} onClick={() => load(topic)}>{topic}<ArrowRight size={13} /></button>)}
      <span className="shortcut-end">入门 <span>→</span> 进阶 <span>→</span> 深入</span>
    </nav>
    {view.drilldown && <nav className="breadcrumbs" aria-label="地图面包屑">
      <button type="button" onClick={back}>{view.drilldown.breadcrumb[0]}</button>
      <ArrowRight size={13} aria-hidden="true" /><span aria-current="page">{view.drilldown.breadcrumb[1]}</span>
      <small>一级下钻</small>
    </nav>}
    {view.mockMode === true && <div className="mock-banner" role="note">
      <span className="mode-tag">MOCK</span>演示模式 · 固定示例数据，不代表当前话题的真实知乎文章
    </div>}
    {view.overview && <section className="map-overview" aria-label="话题总览">
      <div className="overview-title"><span>学习地图</span><h1>{view.topic}</h1><small>{view.overview.duration}</small></div>
      <div><span>这是什么</span><p>{view.overview.what}</p></div>
      <div><span>学完能做什么</span><p>{view.overview.gain}</p></div>
    </section>}
    <section className="learning-progress" aria-label="本地学习进度">
      <span role="status">已学 {learnedCount} / {view.nodes.length} 个知识点</span>
      <progress value={learnedCount} max={view.nodes.length || 1} aria-label="已学知识点比例" />
      <button type="button" className="icon-button" title="清除本地学习进度" aria-label="清除本地学习进度"
        onClick={() => {
          if (!window.confirm('清除所有本地学习进度？当前地图不会被清除。')) return;
          setStorageNotice(progress.clear() ? '' : '存储不可用，当前会话进度已清空');
        }}><Trash2 size={15} /></button>
      {storageNotice && <small role="status">{storageNotice}</small>}
    </section>
    <div className="generation-status" role="status" aria-live="polite">
      {busy ? <><LoaderCircle size={15} className="spin" />{view.drilldown ? '下钻：' : ''}{view.phase === 'loading' ? '正在生成学习大纲…' : `正在检索资源 · ${settled}/${view.nodes.length}`}</> :
        view.phase === 'finished' ? <><Check size={15} />{view.originalStatus === 'partial' ? '原始生成：部分资源失败' : '地图已生成'}
          <span>当前失败 {errors} 个</span></> : view.phase === 'idle' ? <><BookOpen size={15} />从一个话题开始</> : null}
    </div>
    {view.error && <div className="error-banner" role="alert"><span>{view.error}</span>
      <button type="button" onClick={reload} disabled={busy}>重新加载</button>
      {view.drilldown && <button type="button" onClick={back}>返回上级</button>}</div>}
    {view.mapId && view.nodes.length ? <ReactFlowProvider key={viewKey}>
      <Canvas view={view} controller={controller} narrow={narrow} memory={memory}
        completed={learning.completedNodeIds} mark={mark}
        drill={view.drilldown ? undefined : (id) => {
          if (navigation.enter(id)) setInput(navigation.snapshot().snapshot().topic);
        }} />
    </ReactFlowProvider> : <section className="empty-board">
      <div className="board-mark" aria-hidden="true"><Compass size={48} strokeWidth={1} /></div>
      <h1>{view.phase === 'loading' ? '正在构建学习路径' : '你想从哪里开始？'}</h1>
      <p>{view.phase === 'loading' ? view.topic : '数学、编程、摄影，或一个新的兴趣。'}</p>
      {view.phase !== 'loading' && <button type="button" className="text-button" onClick={() => inputRef.current?.focus()}><Plus size={16} />输入学习话题</button>}
      <div className="empty-levels" aria-hidden="true"><span>01 入门</span><span>02 进阶</span><span>03 深入</span></div>
    </section>}
    <footer className="app-footer"><span>知径 / 知乎学习资源</span><span>AI 编排的学习顺序与用时仅供参考</span></footer>
  </main>;
}
