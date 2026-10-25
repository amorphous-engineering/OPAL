<script lang="ts">
	import type { Snippet } from 'svelte';
	import {
		SvelteFlow,
		SvelteFlowProvider,
		Controls,
		MarkerType,
		type Edge,
		type Node
	} from '@xyflow/svelte';
	import '@xyflow/svelte/dist/style.css';
	import { wouldCycle } from './cycle.js';
	import { layoutGraph, NODE_HEIGHT, NODE_WIDTH } from './layout.js';
	import OpNode from './OpNode.svelte';
	import OpEdge from './OpEdge.svelte';
	import Refit from './Refit.svelte';
	import type { GraphEdge, GraphNode, OpEdgeData, OpNodeData } from './types.js';

	let {
		nodes,
		edges,
		editable = false,
		selected = null,
		onconnect,
		ondisconnect,
		onselect,
		nodeActions,
		class: className = ''
	}: {
		nodes: GraphNode[];
		edges: GraphEdge[];
		editable?: boolean;
		selected?: number | null;
		onconnect?: (from: number, to: number) => void | Promise<void>;
		ondisconnect?: (from: number, to: number) => void | Promise<void>;
		onselect?: (id: number) => void;
		nodeActions?: Snippet<[GraphNode]>;
		class?: string;
	} = $props();

	const nodeTypes = { op: OpNode };
	const edgeTypes = { op: OpEdge };

	let flashId = $state<number | null>(null);
	let flashTimer: ReturnType<typeof setTimeout> | undefined;
	function flash(id: number) {
		flashId = id;
		clearTimeout(flashTimer);
		flashTimer = setTimeout(() => (flashId = null), 700);
	}

	function connect(from: number, to: number) {
		if (!editable) return;
		const refused =
			wouldCycle(edges, from, to) ||
			edges.some((e) => e.from === from && e.to === to) ||
			edges.some(
				(e) => e.kind === 'redline' && (e.from === to || e.to === to || e.from === from)
			) ||
			nodes.find((n) => n.id === from)?.kind === 'redline' ||
			nodes.find((n) => n.id === to)?.kind === 'redline';
		if (refused) {
			flash(to);
			// SvelteFlow adds the dropped connection to the bound edges itself; the props are the truth.
			setTimeout(() => (rfEdges = flowEdges), 0);
			return;
		}
		void onconnect?.(from, to);
	}
	function disconnect(e: GraphEdge) {
		if (!editable || e.kind === 'redline') return;
		void ondisconnect?.(e.from, e.to);
	}

	// Positions depend only on the graph structure, not on selection or flash.
	const positions = $derived(layoutGraph(nodes, edges));
	const nodeKey = $derived(
		nodes
			.map((n) => n.id)
			.sort((a, b) => a - b)
			.join(',')
	);

	const bounds = $derived.by(() => {
		let x0 = Infinity,
			y0 = Infinity,
			x1 = -Infinity,
			y1 = -Infinity;
		for (const p of positions.values()) {
			x0 = Math.min(x0, p.x);
			y0 = Math.min(y0, p.y);
			x1 = Math.max(x1, p.x + NODE_WIDTH);
			y1 = Math.max(y1, p.y + NODE_HEIGHT);
		}
		return isFinite(x0) ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : { x: 0, y: 0, w: 1, h: 1 };
	});
	let paneW = $state(0);
	let paneH = $state(0);

	const flowNodes = $derived<Node[]>(
		nodes.map((n) => ({
			id: String(n.id),
			type: 'op',
			position: positions.get(n.id) ?? { x: 0, y: 0 },
			width: NODE_WIDTH,
			height: NODE_HEIGHT,
			draggable: false,
			deletable: false,
			selectable: false,
			connectable: editable,
			data: {
				node: n,
				selected: selected === n.id,
				flash: flashId === n.id,
				editable,
				actions: nodeActions
			} satisfies OpNodeData
		}))
	);
	const flowEdges = $derived<Edge[]>(
		edges.map((e) => {
			const redline = e.kind === 'redline';
			return {
				id: `${e.from}-${e.to}-${e.kind ?? 'dependency'}`,
				source: String(e.from),
				target: String(e.to),
				type: 'op',
				selectable: editable && !redline,
				deletable: editable && !redline,
				focusable: editable && !redline,
				markerEnd: {
					type: MarkerType.ArrowClosed,
					width: 14,
					height: 14,
					color: 'var(--opg-edge)'
				},
				data: {
					redline,
					editable,
					onremove: () => disconnect(e)
				} satisfies OpEdgeData
			};
		})
	);

	// SvelteFlow wants writable arrays; the props stay the single source of truth.
	let rfNodes = $state.raw<Node[]>([]);
	let rfEdges = $state.raw<Edge[]>([]);
	$effect(() => {
		rfNodes = flowNodes;
	});
	$effect(() => {
		rfEdges = flowEdges;
	});

	function edgeByFlowId(id: string): GraphEdge | undefined {
		const i = flowEdges.findIndex((e) => e.id === id);
		return i >= 0 ? edges[i] : undefined;
	}

	// Keys typed in the graph stay in the graph, except Escape.
	function keydown(e: KeyboardEvent) {
		if (e.key !== 'Escape') e.stopPropagation();
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class={['op-graph', className]}
	onkeydown={keydown}
	bind:clientWidth={paneW}
	bind:clientHeight={paneH}
>
	<SvelteFlowProvider>
		<SvelteFlow
			bind:nodes={rfNodes}
			bind:edges={rfEdges}
			{nodeTypes}
			{edgeTypes}
			minZoom={0.2}
			maxZoom={1.5}
			nodesDraggable={false}
			nodesConnectable={editable}
			elementsSelectable={editable}
			edgesFocusable={editable}
			deleteKey={editable ? ['Delete', 'Backspace'] : null}
			selectionKey={null}
			multiSelectionKey={null}
			zoomOnDoubleClick={false}
			connectionRadius={24}
			proOptions={{ hideAttribution: true }}
			onnodeclick={({ node }) => onselect?.(Number(node.id))}
			onconnect={(c) => connect(Number(c.source), Number(c.target))}
			onbeforedelete={async ({ edges: doomed }) => {
				for (const d of doomed) {
					const e = edgeByFlowId(d.id);
					if (e) disconnect(e);
				}
				return false;
			}}
		>
			<Controls
				showLock={false}
				position="bottom-left"
				fitViewOptions={{ padding: 0.1, minZoom: 1, maxZoom: 1 }}
			/>
			<Refit signal={nodeKey} {bounds} width={paneW} height={paneH} />
		</SvelteFlow>
	</SvelteFlowProvider>
</div>

<style>
	.op-graph {
		position: relative;
		width: 100%;
		height: 100%;
		min-height: 240px;
		border: 1px solid var(--border);
		border-radius: var(--radius-md, 6px);
		background: var(--card);
		overflow: hidden;

		--opg-edge: var(--muted-foreground);
		--opg-line: color-mix(in oklab, var(--foreground) 24%, var(--card));
		--opg-edge-sel: var(--info);
		--xy-background-color: var(--card);
		--xy-node-color: var(--foreground);
		--xy-node-background-color: var(--card);
		--xy-node-border: 1px solid var(--border);
		--xy-node-border-radius: 4px;
		--xy-node-boxshadow-hover: none;
		--xy-node-boxshadow-selected: none;
		--xy-edge-stroke: var(--opg-edge);
		--xy-edge-stroke-selected: var(--opg-edge-sel);
		--xy-edge-stroke-width: 1.25;
		--xy-connectionline-stroke: var(--info);
		--xy-connectionline-stroke-width: 1.5;
		--xy-handle-background-color: var(--info);
		--xy-handle-border-color: var(--card);
		--xy-controls-button-background-color: var(--card);
		--xy-controls-button-background-color-hover: var(--accent);
		--xy-controls-button-color: var(--foreground);
		--xy-controls-button-color-hover: var(--foreground);
		--xy-controls-button-border-color: var(--border);
		--xy-controls-box-shadow: none;
		--xy-edge-label-background-color: var(--card);
		--xy-edge-label-color: var(--foreground);
		--xy-selection-background-color: var(--info-muted);
		--xy-selection-border: 1px dotted var(--info);
	}
	.op-graph :global(.svelte-flow) {
		background: var(--card);
	}
	.op-graph :global(.svelte-flow__attribution) {
		display: none;
	}
	.op-graph :global(.svelte-flow__controls) {
		box-shadow: none;
		border: 1px solid var(--border);
		border-radius: 4px;
		overflow: hidden;
	}
	.op-graph :global(.svelte-flow__controls-button) {
		border-bottom: 1px solid var(--border);
	}
	.op-graph :global(.svelte-flow__controls-button svg) {
		fill: currentColor;
	}
	.op-graph :global(.svelte-flow__node) {
		cursor: pointer;
	}
	.op-graph :global(.svelte-flow__arrowhead polyline),
	.op-graph :global(.svelte-flow__arrowhead path) {
		stroke: var(--opg-edge);
		fill: var(--opg-edge);
	}

	/* Nodes */
	.op-graph :global(.opg-node) {
		position: relative;
		box-sizing: border-box;
		width: 220px;
		height: 56px;
		padding: 6px 8px 6px 10px;
		display: flex;
		flex-direction: column;
		justify-content: center;
		gap: 3px;
		background: var(--card);
		color: var(--foreground);
		border: 1px solid var(--opg-line);
		border-left: 3px solid var(--opg-line);
		border-radius: 4px;
		font-size: var(--text-xs);
		line-height: 1.2;
		--opg-tone: var(--foreground);
	}
	.op-graph :global(.opg-node[data-tone='ok']) {
		--opg-tone: var(--ok);
		border-left-color: var(--ok);
	}
	.op-graph :global(.opg-node[data-tone='info']) {
		--opg-tone: var(--info);
		border-left-color: var(--info);
	}
	.op-graph :global(.opg-node[data-tone='warn']) {
		--opg-tone: var(--warn);
		border-left-color: var(--warn);
	}
	.op-graph :global(.opg-node[data-tone='error']) {
		--opg-tone: var(--error);
		border-left-color: var(--error);
	}
	.op-graph :global(.opg-node[data-tone='muted']) {
		--opg-tone: var(--muted-foreground);
		border-left-color: var(--muted-foreground);
		color: var(--muted-foreground);
	}
	.op-graph :global(.opg-node.contingency) {
		border-style: dashed;
		border-left-style: solid;
	}
	.op-graph :global(.opg-node.redline) {
		border-color: var(--warn);
		border-left-color: var(--warn);
	}
	.op-graph :global(.opg-node.selected) {
		border-color: var(--info);
		border-left-color: var(--info);
		background: var(--info-muted);
	}
	.op-graph :global(.opg-node.flash) {
		border-color: var(--error);
		background: var(--error-muted);
	}
	.op-graph :global(.opg-row) {
		display: flex;
		align-items: baseline;
		gap: 6px;
		min-width: 0;
	}
	.op-graph :global(.opg-num) {
		font-family: var(--font-mono, ui-monospace, monospace);
		font-weight: 600;
		color: var(--opg-tone);
		flex: none;
	}
	.op-graph :global(.opg-title) {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
	}
	.op-graph :global(.opg-meta) {
		display: flex;
		gap: 6px;
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: var(--text-xs);
		color: var(--muted-foreground);
	}
	.op-graph :global(.opg-flag) {
		font-weight: 600;
	}
	.op-graph :global(.opg-flag[data-tone='error']) {
		color: var(--error);
	}
	.op-graph :global(.opg-flag[data-tone='warn']) {
		color: var(--warn);
	}
	.op-graph :global(.opg-actions) {
		position: absolute;
		top: calc(100% + 4px);
		left: 0;
		z-index: 5;
		display: flex;
		gap: 4px;
		padding: 3px;
		background: var(--popover);
		border: 1px solid var(--border);
		border-radius: 4px;
		white-space: nowrap;
	}

	/* Handles: visible only when the graph is editable (connectable). */
	.op-graph :global(.opg-handle.svelte-flow__handle) {
		width: 8px;
		height: 8px;
		min-width: 0;
		min-height: 0;
		border-radius: 2px;
		border: 1px solid var(--card);
		background: var(--info);
	}
	.op-graph :global(.opg-handle.svelte-flow__handle:not(.connectable)) {
		opacity: 0;
		pointer-events: none;
	}
	.op-graph :global(.opg-handle.svelte-flow__handle.connectingto) {
		background: var(--ok);
	}

	/* Edges */
	.op-graph :global(.opg-edge.redline) {
		stroke: var(--warn);
		stroke-dasharray: 5 4;
	}
	.op-graph :global(.svelte-flow__edge.selected .opg-edge) {
		stroke: var(--opg-edge-sel);
	}
	.op-graph :global(.opg-remove) {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 16px;
		height: 16px;
		padding: 0;
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 13px;
		line-height: 1;
		color: var(--muted-foreground);
		background: var(--card);
		border: 1px solid var(--border);
		border-radius: 3px;
		cursor: pointer;
	}
	.op-graph :global(.opg-remove:hover) {
		color: var(--error);
		border-color: var(--error);
	}
</style>
